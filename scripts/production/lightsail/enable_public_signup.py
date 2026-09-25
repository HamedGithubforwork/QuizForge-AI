"""Guard the one-time production Cognito public-signup enablement."""
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
RESULT = Path("lightsail-public-signup-results/summary.json")


def changed_resources(plan: dict[str, Any]) -> list[dict[str, Any]]:
    values = []
    for item in plan.get("resource_changes", []):
        actions = item.get("change", {}).get("actions", [])
        if actions != ["no-op"]:
            values.append(item)
    return values


def review_plan(plan: dict[str, Any]) -> bool:
    changes = changed_resources(plan)
    if not changes:
        return False
    if len(changes) != 1:
        raise ValueError("Public signup plan contains unrelated resource changes")
    item = changes[0]
    if item.get("address") != "aws_cognito_user_pool.browser":
        raise ValueError("Public signup plan changes the wrong resource")
    change = item.get("change", {})
    if change.get("actions") != ["update"]:
        raise ValueError("Public signup plan must be an in-place update")

    before = copy.deepcopy(change.get("before"))
    after = copy.deepcopy(change.get("after"))
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("Public signup plan is missing before/after values")

    before_admin = before.get("admin_create_user_config")
    after_admin = after.get("admin_create_user_config")
    if (
        not isinstance(before_admin, list)
        or not isinstance(after_admin, list)
        or len(before_admin) != 1
        or len(after_admin) != 1
        or before_admin[0].get("allow_admin_create_user_only") is not True
        or after_admin[0].get("allow_admin_create_user_only") is not False
    ):
        raise ValueError("Public signup plan does not toggle the expected Cognito gate")

    before["admin_create_user_config"][0]["allow_admin_create_user_only"] = False
    if before != after:
        raise ValueError("Public signup plan changes more than the signup gate")
    return True


def discover(cognito) -> str:
    token = None
    matches = []
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        response = cognito.list_user_pools(**kwargs)
        matches.extend(item for item in response.get("UserPools", []) if item.get("Name") == POOL_NAME)
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
    update = pool.get("UserAttributeUpdateSettings", {})
    checks = {
        "public_signup_enabled": pool.get("AdminCreateUserConfig", {}).get("AllowAdminCreateUserOnly") is False,
        "deletion_protection_active": pool.get("DeletionProtection") == "ACTIVE",
        "email_username_required": pool.get("UsernameAttributes") == ["email"],
        "email_auto_verified": pool.get("AutoVerifiedAttributes") == ["email"],
        "mandatory_mfa_retained": pool.get("MfaConfiguration") == "ON",
        "software_mfa_retained": mfa.get("SoftwareTokenMfaConfiguration", {}).get("Enabled") is True,
        "verified_email_update_retained": update.get("AttributesRequireVerificationBeforeUpdate") == ["email"],
        "strong_password_policy_retained": (
            password.get("MinimumLength") == 14
            and password.get("RequireLowercase") is True
            and password.get("RequireUppercase") is True
            and password.get("RequireNumbers") is True
            and password.get("RequireSymbols") is True
        ),
        "default_cognito_email_sender_retained": pool.get("EmailConfiguration", {}).get("EmailSendingAccount") == "COGNITO_DEFAULT",
    }
    return checks


def write_report(report: dict[str, Any]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if re.search(r"ca-central-1_[A-Za-z0-9]+", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("Private Cognito identifier reached signup summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if operation == "review-plan":
            plan = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
            changed = review_plan(plan)
            output = os.environ.get("GITHUB_OUTPUT")
            if output:
                with open(output, "a", encoding="utf-8") as handle:
                    handle.write("apply_required=" + ("true" if changed else "false") + "\n")
            return 0
        if operation == "verify-live":
            checks = verify_live()
            failed = sorted(name for name, passed in checks.items() if not passed)
            write_report({
                "schema": 1,
                "operation": "enable_public_cognito_signup",
                "result": "public_signup_enabled" if not failed else "signup_enabled_security_readback_failed",
                **checks,
                "failed_checks": failed,
                "application_changed": False,
                "dns_changed": False,
                "ai_configuration_changed": False,
            })
            if failed:
                print("Public signup readback failed checks=" + ",".join(failed))
                return 1
            return 0
        raise ValueError("Unsupported public-signup operation")
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "AWS_ERROR")
        print("Public signup check failed: " + (str(code) if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", str(code)) else "AWS_ERROR"))
    except Exception as error:
        print("Public signup check failed: " + type(error).__name__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
