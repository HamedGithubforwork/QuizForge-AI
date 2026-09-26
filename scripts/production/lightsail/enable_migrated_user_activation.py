"""Guard the narrowly-scoped production Cognito activation-client change."""
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
CLIENT_NAME = "quizforge-production-pkce"
RESULT = Path("cognito-activation-client-results/summary.json")
BEFORE = ["ALLOW_REFRESH_TOKEN_AUTH"]
AFTER = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"]


def changed_resources(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in plan.get("resource_changes", [])
        if item.get("change", {}).get("actions", []) != ["no-op"]
    ]


def review_plan(plan: dict[str, Any]) -> bool:
    changes = changed_resources(plan)
    if not changes:
        return False

    client_changes = [
        item for item in changes
        if item.get("address") == "aws_cognito_user_pool_client.browser"
    ]
    if not client_changes:
        # Targeted Terraform plans can include dependency drift from the user
        # pool. This activation-only workflow must ignore it rather than apply it.
        return False
    if len(client_changes) != 1 or len(changes) != 1:
        raise ValueError("Activation-client plan contains unrelated changes")
    item = client_changes[0]
    change = item.get("change", {})
    if change.get("actions") != ["update"]:
        raise ValueError("Activation-client plan must be an in-place update")
    before = copy.deepcopy(change.get("before"))
    after = copy.deepcopy(change.get("after"))
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("Activation-client plan is missing before/after values")
    if before.get("explicit_auth_flows") != BEFORE or after.get("explicit_auth_flows") != AFTER:
        raise ValueError("Activation-client plan does not add only USER_PASSWORD_AUTH")
    before["explicit_auth_flows"] = AFTER
    if before != after:
        raise ValueError("Activation-client plan changes more than the intended auth flow")
    return True


def discover(client):
    pools = []
    token = None
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = client.list_user_pools(**kwargs)
        pools.extend(x for x in page.get("UserPools", []) if x.get("Name") == POOL_NAME)
        token = page.get("NextToken")
        if not token:
            break
    if len(pools) != 1:
        raise ValueError("Expected exact production Cognito pool")
    pool_id = str(pools[0].get("Id", ""))
    if not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool_id):
        raise ValueError("Unexpected pool identifier")

    clients = []
    token = None
    while True:
        kwargs = {"UserPoolId": pool_id, "MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = client.list_user_pool_clients(**kwargs)
        clients.extend(x for x in page.get("UserPoolClients", []) if x.get("ClientName") == CLIENT_NAME)
        token = page.get("NextToken")
        if not token:
            break
    if len(clients) != 1:
        raise ValueError("Expected exact production browser client")
    return pool_id, str(clients[0]["ClientId"])


def verify_live() -> dict[str, bool]:
    client = boto3.client("cognito-idp", region_name=REGION)
    pool_id, client_id = discover(client)
    app = client.describe_user_pool_client(UserPoolId=pool_id, ClientId=client_id)["UserPoolClient"]
    flows = sorted(app.get("ExplicitAuthFlows", []))
    return {
        "refresh_flow_retained": "ALLOW_REFRESH_TOKEN_AUTH" in flows,
        "user_password_activation_enabled": "ALLOW_USER_PASSWORD_AUTH" in flows,
        "no_admin_password_flow": "ALLOW_ADMIN_USER_PASSWORD_AUTH" not in flows,
        "no_custom_auth_flow": "ALLOW_CUSTOM_AUTH" not in flows,
        "public_client_retained": not bool(app.get("ClientSecret")),
        "existence_protection_retained": app.get("PreventUserExistenceErrors") == "ENABLED",
        "token_revocation_retained": app.get("EnableTokenRevocation") is True,
    }


def write_report(report: dict[str, Any]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if re.search(r"ca-central-1_[A-Za-z0-9]+", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("Private identifier reached activation-client summary")
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
            failed = sorted(k for k, v in checks.items() if not v)
            write_report({
                "schema": 1,
                "operation": "enable_migrated_user_activation_flow",
                "result": "enabled" if not failed else "security_readback_failed",
                **checks,
                "failed_checks": failed,
            })
            return 0 if not failed else 1
        raise ValueError("Unsupported operation")
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", "AWS_ERROR"))
        print("Activation-client check failed: " + (code if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", code) else "AWS_ERROR"))
    except Exception as error:
        print("Activation-client check failed: " + type(error).__name__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
