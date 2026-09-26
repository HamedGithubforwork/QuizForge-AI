"""Guard the production Cognito MFA update from required to optional."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

import boto3
from botocore.exceptions import ClientError

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
RESULT = Path("cognito-mfa-policy-results/summary.json")


def changed_resources(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in plan.get("resource_changes", [])
        if item.get("change", {}).get("actions", []) != ["no-op"]
    ]


def review_plan(plan: dict[str, Any]) -> bool:
    changes = changed_resources(plan)
    if not changes:
        return False
    if len(changes) != 1:
        raise ValueError("MFA-policy plan contains unrelated changes")
    item = changes[0]
    if item.get("address") != "aws_cognito_user_pool.browser":
        raise ValueError("MFA-policy plan changes the wrong resource")
    change = item.get("change", {})
    if change.get("actions") != ["update"]:
        raise ValueError("MFA-policy change must be in-place")

    before = copy.deepcopy(change.get("before"))
    after = copy.deepcopy(change.get("after"))
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("MFA-policy plan is missing before/after values")

    if before.get("mfa_configuration") != "ON" or after.get("mfa_configuration") != "OPTIONAL":
        raise ValueError("MFA-policy plan does not change ON to OPTIONAL")

    before["mfa_configuration"] = "OPTIONAL"
    if before != after:
        raise ValueError("MFA-policy plan changes more than required-to-optional MFA")
    return True


def discover(cognito) -> str:
    token = None
    matches = []
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        response = cognito.list_user_pools(**kwargs)
        matches.extend(
            item for item in response.get("UserPools", [])
            if item.get("Name") == POOL_NAME
        )
        token = response.get("NextToken")
        if not token:
            break
    if len(matches) != 1:
        raise ValueError("Expected exact production Cognito pool")
    pool_id = str(matches[0].get("Id", ""))
    if not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool_id):
        raise ValueError("Production Cognito pool ID is invalid")
    return pool_id


def verify_live() -> dict[str, bool]:
    cognito = boto3.client("cognito-idp", region_name=REGION)
    pool_id = discover(cognito)
    pool = cognito.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    mfa = cognito.get_user_pool_mfa_config(UserPoolId=pool_id)
    password = pool.get("Policies", {}).get("PasswordPolicy", {})
    return {
        "mfa_optional": pool.get("MfaConfiguration") == "OPTIONAL",
        "totp_available": mfa.get("SoftwareTokenMfaConfiguration", {}).get("Enabled") is True,
        "password_minimum_eight_retained": password.get("MinimumLength") == 8,
        "password_complexity_retained": (
            password.get("RequireLowercase") is True
            and password.get("RequireUppercase") is True
            and password.get("RequireNumbers") is True
            and password.get("RequireSymbols") is True
        ),
        "deletion_protection_retained": pool.get("DeletionProtection") == "ACTIVE",
        "public_signup_retained": pool.get("AdminCreateUserConfig", {}).get("AllowAdminCreateUserOnly") is False,
        "email_username_retained": pool.get("UsernameAttributes") == ["email"],
        "email_verification_retained": pool.get("AutoVerifiedAttributes") == ["email"],
    }


def write_report(report: dict[str, Any]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if re.search(r"ca-central-1_[A-Za-z0-9]+", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("Private identifier reached MFA-policy summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if operation == "review-plan":
            changed = review_plan(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
            output = os.environ.get("GITHUB_OUTPUT")
            if output:
                with open(output, "a", encoding="utf-8") as handle:
                    handle.write("apply_required=" + ("true" if changed else "false") + "\n")
            return 0
        if operation == "verify-live":
            checks = verify_live()
            failed = sorted(name for name, ok in checks.items() if not ok)
            write_report({
                "schema": 1,
                "operation": "set_cognito_mfa_optional",
                "result": "enabled" if not failed else "security_readback_failed",
                **checks,
                "failed_checks": failed,
            })
            return 0 if not failed else 1
        raise ValueError("Unsupported operation")
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", "AWS_ERROR"))
        print("MFA-policy update failed: " + (code if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", code) else "AWS_ERROR"))
    except Exception as error:
        print("MFA-policy update failed: " + type(error).__name__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
