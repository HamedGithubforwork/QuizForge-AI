"""Read-only aggregate diagnostic for migrated Cognito MFA state."""
from __future__ import annotations

import json
from pathlib import Path
import re

import boto3

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
RESULT = Path("cognito-mfa-state-results/summary.json")


def discover_pool(client) -> str:
    token = None
    matches = []
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = client.list_user_pools(**kwargs)
        matches.extend(item for item in page.get("UserPools", []) if item.get("Name") == POOL_NAME)
        token = page.get("NextToken")
        if not token:
            break
    if len(matches) != 1:
        raise RuntimeError("Expected exact production pool")
    pool_id = str(matches[0].get("Id", ""))
    if not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool_id):
        raise RuntimeError("Unexpected pool identifier")
    return pool_id


def main() -> int:
    client = boto3.client("cognito-idp", region_name=REGION)
    pool_id = discover_pool(client)
    users = []
    token = None
    while True:
        kwargs = {"UserPoolId": pool_id, "Limit": 60}
        if token:
            kwargs["PaginationToken"] = token
        page = client.list_users(**kwargs)
        users.extend(page.get("Users", []))
        token = page.get("PaginationToken")
        if not token:
            break

    confirmed = 0
    software_mfa = 0
    preferred_software_mfa = 0
    no_mfa = 0
    for item in users:
        username = item.get("Username")
        if not username:
            raise RuntimeError("Cognito user missing username")
        detail = client.admin_get_user(UserPoolId=pool_id, Username=username)
        if detail.get("UserStatus") == "CONFIRMED":
            confirmed += 1
        methods = detail.get("UserMFASettingList") or []
        preferred = detail.get("PreferredMfaSetting")
        if "SOFTWARE_TOKEN_MFA" in methods:
            software_mfa += 1
        if preferred == "SOFTWARE_TOKEN_MFA":
            preferred_software_mfa += 1
        if not methods:
            no_mfa += 1

    report = {
        "schema": 1,
        "total_users": len(users),
        "confirmed_users": confirmed,
        "software_mfa_users": software_mfa,
        "preferred_software_mfa_users": preferred_software_mfa,
        "users_without_mfa": no_mfa,
        "user_identifiers_published": False,
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "Cognito MFA aggregate: "
        f"users={len(users)} confirmed={confirmed} software_mfa={software_mfa} no_mfa={no_mfa}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
