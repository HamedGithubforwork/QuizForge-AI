"""Read-only production SMS readiness diagnostic for Cognito MFA."""
# Recheck after owner-approved AWS account plan upgrade.
from __future__ import annotations

import json
from pathlib import Path
import re

import boto3
from botocore.exceptions import ClientError

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
RESULT = Path("cognito-sms-readiness-results/summary.json")


def discover_pool(client) -> str:
    token = None
    matches = []
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = client.list_user_pools(**kwargs)
        matches.extend(x for x in page.get("UserPools", []) if x.get("Name") == POOL_NAME)
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
    cognito = boto3.client("cognito-idp", region_name=REGION)
    sms = boto3.client("pinpoint-sms-voice-v2", region_name=REGION)
    pool_id = discover_pool(cognito)

    mfa = cognito.get_user_pool_mfa_config(UserPoolId=pool_id)
    sms_service_enabled = True
    try:
        attrs = sms.describe_account_attributes(MaxResults=100).get("AccountAttributes", [])
        values = {str(item.get("Name", "")): str(item.get("Value", "")) for item in attrs}

        tier = values.get("ACCOUNT_TIER", "").upper()
        if tier not in {"SANDBOX", "PRODUCTION"}:
            tier = "UNKNOWN"

        phone_count = 0
        next_token = None
        while True:
            kwargs = {"MaxResults": 100}
            if next_token:
                kwargs["NextToken"] = next_token
            page = sms.describe_phone_numbers(**kwargs)
            phone_count += len(page.get("PhoneNumbers", []))
            next_token = page.get("NextToken")
            if not next_token:
                break

        pool_count = 0
        next_token = None
        while True:
            kwargs = {"MaxResults": 100}
            if next_token:
                kwargs["NextToken"] = next_token
            page = sms.describe_pools(**kwargs)
            pool_count += len(page.get("Pools", []))
            next_token = page.get("NextToken")
            if not next_token:
                break
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code not in {"SubscriptionRequiredException", "OptInRequired"}:
            raise
        sms_service_enabled = False
        tier = "NOT_ENABLED"
        phone_count = 0
        pool_count = 0

    report = {
        "schema": 1,
        "sms_service_enabled": sms_service_enabled,
        "sms_account_tier": tier,
        "origination_phone_numbers_present": phone_count > 0,
        "sms_pools_present": pool_count > 0,
        "cognito_mfa_required": mfa.get("MfaConfiguration") == "ON",
        "totp_enabled": mfa.get("SoftwareTokenMfaConfiguration", {}).get("Enabled") is True,
        "sms_mfa_already_enabled": bool(mfa.get("SmsMfaConfiguration")),
        "raw_identifiers_published": False,
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "SMS readiness: service="
        + ("enabled" if sms_service_enabled else "not-enabled")
        + " tier="
        + tier
        + " origination="
        + ("yes" if report["origination_phone_numbers_present"] else "no")
        + " pool="
        + ("yes" if report["sms_pools_present"] else "no")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
