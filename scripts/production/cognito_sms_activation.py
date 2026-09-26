"""Guarded production activation for Cognito SMS MFA through AWS End User Messaging SMS.

This is intentionally manual-only. It refuses activation unless:
- the AWS End User Messaging SMS account is in PRODUCTION,
- the supplied origination identity belongs to this account and ca-central-1,
- the identity exists and is SMS-capable,
- Cognito still has the reviewed optional-TOTP security baseline,
- the operator explicitly confirms activation.

The script then creates a dedicated Cognito-assumable IAM role with a confused-
deputy-resistant trust policy, grants only sms-voice:SendTextMessage on the exact
origination identity, preserves the full existing Cognito pool/client settings,
adds phone-number verification/client attributes, and enables SMS MFA while
retaining optional TOTP.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Iterable

import boto3
from botocore.exceptions import ClientError

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
CLIENT_NAME = "quizforge-production-pkce"
ROLE_NAME = "quizforge-production-cognito-sms"
CONFIRMATION = "ENABLE COGNITO SMS MFA"
SMS_MESSAGE = "Quiz From Notes code: {####}"
RESULT = Path("cognito-sms-activation-results/summary.json")

IDENTITY_RE = re.compile(
    r"^arn:aws:sms-voice:ca-central-1:(?P<account>[0-9]{12}):"
    r"(?P<kind>phone-number|pool)/(?P<id>[A-Za-z0-9._/-]{1,256})$"
)


class Refused(RuntimeError):
    pass


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def discover_pool(cognito) -> tuple[str, dict[str, Any]]:
    token = None
    matches: list[dict[str, Any]] = []
    while True:
        kwargs: dict[str, Any] = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = cognito.list_user_pools(**kwargs)
        matches.extend(
            item for item in page.get("UserPools", [])
            if item.get("Name") == POOL_NAME
        )
        token = page.get("NextToken")
        if not token:
            break
    require(len(matches) == 1, "COGNITO_POOL_NOT_UNIQUE")
    pool_id = str(matches[0].get("Id", ""))
    require(
        bool(re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool_id)),
        "COGNITO_POOL_ID_INVALID",
    )
    detail = cognito.describe_user_pool(UserPoolId=pool_id).get("UserPool") or {}
    require(isinstance(detail, dict), "COGNITO_POOL_READBACK_INVALID")
    return pool_id, detail


def discover_client(cognito, pool_id: str) -> tuple[str, dict[str, Any]]:
    token = None
    matches: list[dict[str, Any]] = []
    while True:
        kwargs: dict[str, Any] = {"UserPoolId": pool_id, "MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        page = cognito.list_user_pool_clients(**kwargs)
        matches.extend(
            item for item in page.get("UserPoolClients", [])
            if item.get("ClientName") == CLIENT_NAME
        )
        token = page.get("NextToken")
        if not token:
            break
    require(len(matches) == 1, "COGNITO_CLIENT_NOT_UNIQUE")
    client_id = str(matches[0].get("ClientId", ""))
    require(bool(re.fullmatch(r"[a-z0-9]{1,128}", client_id)), "COGNITO_CLIENT_ID_INVALID")
    detail = cognito.describe_user_pool_client(
        UserPoolId=pool_id,
        ClientId=client_id,
    ).get("UserPoolClient") or {}
    require(isinstance(detail, dict), "COGNITO_CLIENT_READBACK_INVALID")
    return client_id, detail


def external_id(account: str, pool_id: str) -> str:
    digest = hashlib.sha256(f"{account}:{pool_id}:quizforge-cognito-sms".encode()).hexdigest()
    return "quizforge-cognito-sms-" + digest[:32]


def pool_arn(account: str, pool_id: str) -> str:
    return f"arn:aws:cognito-idp:{REGION}:{account}:userpool/{pool_id}"


def role_arn(account: str) -> str:
    return f"arn:aws:iam::{account}:role/{ROLE_NAME}"


def trust_policy(account: str, user_pool_arn: str, ext: str) -> dict[str, Any]:
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "cognito-idp.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {
                    "aws:SourceAccount": account,
                    "sts:ExternalId": ext,
                },
                "ArnLike": {
                    "aws:SourceArn": user_pool_arn,
                },
            },
        }],
    }


def send_policy(identity_arn: str) -> dict[str, Any]:
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["sms-voice:SendTextMessage"],
            "Resource": identity_arn,
        }],
    }


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def account_tier(sms) -> str:
    attrs = sms.describe_account_attributes(MaxResults=100).get("AccountAttributes", [])
    values = {str(item.get("Name", "")): str(item.get("Value", "")) for item in attrs}
    tier = values.get("ACCOUNT_TIER", "").upper()
    return tier if tier in {"SANDBOX", "PRODUCTION"} else "UNKNOWN"


def _pages(client, method: str, result_key: str) -> Iterable[dict[str, Any]]:
    token = None
    while True:
        kwargs: dict[str, Any] = {"MaxResults": 100}
        if token:
            kwargs["NextToken"] = token
        page = getattr(client, method)(**kwargs)
        for item in page.get(result_key, []):
            if isinstance(item, dict):
                yield item
        token = page.get("NextToken")
        if not token:
            break


def identity_status(sms, identity_arn: str, account: str) -> dict[str, bool]:
    match = IDENTITY_RE.fullmatch(identity_arn)
    require(match is not None, "ORIGINATION_IDENTITY_ARN_INVALID")
    require(match.group("account") == account, "ORIGINATION_IDENTITY_WRONG_ACCOUNT")

    found = False
    sms_capable = False
    if match.group("kind") == "phone-number":
        for item in _pages(sms, "describe_phone_numbers", "PhoneNumbers"):
            if item.get("PhoneNumberArn") != identity_arn:
                continue
            found = True
            capabilities = {str(value).upper() for value in item.get("NumberCapabilities", [])}
            sms_capable = "SMS" in capabilities
            break
    else:
        for item in _pages(sms, "describe_pools", "Pools"):
            if item.get("PoolArn") == identity_arn:
                found = True
                sms_capable = True
                break

    return {
        "origination_identity_present": found,
        "origination_identity_sms_capable": sms_capable,
    }


def baseline_checks(pool: dict[str, Any], mfa: dict[str, Any]) -> dict[str, bool]:
    password = pool.get("Policies", {}).get("PasswordPolicy", {})
    return {
        "mfa_optional": pool.get("MfaConfiguration") == "OPTIONAL",
        "totp_available": mfa.get("SoftwareTokenMfaConfiguration", {}).get("Enabled") is True,
        "deletion_protection_active": pool.get("DeletionProtection") == "ACTIVE",
        "public_signup_enabled": pool.get("AdminCreateUserConfig", {}).get("AllowAdminCreateUserOnly") is False,
        "email_username_retained": pool.get("UsernameAttributes") == ["email"],
        "password_minimum_eight": password.get("MinimumLength") == 8,
        "password_complexity_retained": all(
            password.get(name) is True
            for name in ("RequireLowercase", "RequireUppercase", "RequireNumbers", "RequireSymbols")
        ),
    }


def operation_input(client, operation: str, current: dict[str, Any]) -> dict[str, Any]:
    model = client.meta.service_model.operation_model(operation)
    allowed = set(model.input_shape.members)
    return {
        key: copy.deepcopy(value)
        for key, value in current.items()
        if key in allowed and value is not None
    }


def configure_role(iam, account: str, user_pool_arn: str, ext: str, identity_arn: str) -> str:
    trust = trust_policy(account, user_pool_arn, ext)
    try:
        current = iam.get_role(RoleName=ROLE_NAME)["Role"]
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "NoSuchEntity":
            raise
        created = iam.create_role(
            RoleName=ROLE_NAME,
            Description="Allows Quiz From Notes Cognito to send SMS MFA codes through AWS End User Messaging SMS.",
            AssumeRolePolicyDocument=canonical(trust),
        )["Role"]
        current = created

    current_trust = current.get("AssumeRolePolicyDocument")
    require(
        isinstance(current_trust, dict) and canonical(current_trust) == canonical(trust),
        "SMS_ROLE_TRUST_MISMATCH",
    )
    arn = str(current.get("Arn", ""))
    require(arn == role_arn(account), "SMS_ROLE_ARN_MISMATCH")

    policy = send_policy(identity_arn)
    iam.put_role_policy(
        RoleName=ROLE_NAME,
        PolicyName="quizforge-production-cognito-sms-send",
        PolicyDocument=canonical(policy),
    )
    readback = iam.get_role_policy(
        RoleName=ROLE_NAME,
        PolicyName="quizforge-production-cognito-sms-send",
    ).get("PolicyDocument")
    require(
        isinstance(readback, dict) and canonical(readback) == canonical(policy),
        "SMS_ROLE_POLICY_MISMATCH",
    )
    return arn


def configure_pool_and_client(
    cognito,
    pool_id: str,
    pool: dict[str, Any],
    client_id: str,
    client: dict[str, Any],
    caller_arn: str,
    ext: str,
    identity_arn: str,
) -> None:
    sms_config = {
        "EumsSms": {
            "CallerArn": caller_arn,
            "ExternalId": ext,
            "OriginationIdentity": identity_arn,
            "Region": REGION,
        }
    }

    pool_update = operation_input(cognito, "UpdateUserPool", pool)
    pool_update["UserPoolId"] = pool_id
    auto = {str(value) for value in pool_update.get("AutoVerifiedAttributes", [])}
    auto.update({"email", "phone_number"})
    pool_update["AutoVerifiedAttributes"] = sorted(auto)
    current_update = pool_update.get("UserAttributeUpdateSettings") or {}
    pending = {
        str(value)
        for value in current_update.get("AttributesRequireVerificationBeforeUpdate", [])
    }
    pending.update({"email", "phone_number"})
    pool_update["UserAttributeUpdateSettings"] = {
        "AttributesRequireVerificationBeforeUpdate": sorted(pending)
    }
    pool_update["SmsConfiguration"] = sms_config
    pool_update["MfaConfiguration"] = "OPTIONAL"
    cognito.update_user_pool(**pool_update)

    cognito.set_user_pool_mfa_config(
        UserPoolId=pool_id,
        SmsMfaConfiguration={"SmsAuthenticationMessage": SMS_MESSAGE},
        SoftwareTokenMfaConfiguration={"Enabled": True},
        MfaConfiguration="OPTIONAL",
        SmsConfiguration=sms_config,
    )

    client_update = operation_input(cognito, "UpdateUserPoolClient", client)
    client_update["UserPoolId"] = pool_id
    client_update["ClientId"] = client_id
    read_attrs = {str(value) for value in client_update.get("ReadAttributes", [])}
    read_attrs.update({"email", "email_verified", "phone_number", "phone_number_verified", "sub"})
    client_update["ReadAttributes"] = sorted(read_attrs)
    write_attrs = {str(value) for value in client_update.get("WriteAttributes", [])}
    write_attrs.update({"email", "phone_number"})
    client_update["WriteAttributes"] = sorted(write_attrs)
    cognito.update_user_pool_client(**client_update)


def verify_live(cognito, iam, account: str, identity_arn: str) -> dict[str, bool]:
    pool_id, pool = discover_pool(cognito)
    client_id, client = discover_client(cognito, pool_id)
    mfa = cognito.get_user_pool_mfa_config(UserPoolId=pool_id)
    ext = external_id(account, pool_id)
    expected_role = role_arn(account)
    eums = (mfa.get("SmsConfiguration") or {}).get("EumsSms") or {}
    update = pool.get("UserAttributeUpdateSettings", {})
    checks = {
        **baseline_checks(pool, mfa),
        "sms_mfa_enabled": bool(mfa.get("SmsMfaConfiguration")),
        "direct_eums_sms_configured": (
            eums.get("CallerArn") == expected_role
            and eums.get("ExternalId") == ext
            and eums.get("OriginationIdentity") == identity_arn
            and eums.get("Region") in {None, "", REGION}
        ),
        "phone_auto_verification_enabled": {"email", "phone_number"}.issubset(
            set(pool.get("AutoVerifiedAttributes") or [])
        ),
        "phone_update_requires_verification": {"email", "phone_number"}.issubset(
            set(update.get("AttributesRequireVerificationBeforeUpdate") or [])
        ),
        "client_can_read_phone": {"phone_number", "phone_number_verified"}.issubset(
            set(client.get("ReadAttributes") or [])
        ),
        "client_can_write_phone": "phone_number" in set(client.get("WriteAttributes") or []),
    }

    role = iam.get_role(RoleName=ROLE_NAME)["Role"]
    trust = role.get("AssumeRolePolicyDocument")
    expected_trust = trust_policy(account, pool_arn(account, pool_id), ext)
    policy = iam.get_role_policy(
        RoleName=ROLE_NAME,
        PolicyName="quizforge-production-cognito-sms-send",
    ).get("PolicyDocument")
    checks["sms_role_trust_scoped"] = (
        isinstance(trust, dict) and canonical(trust) == canonical(expected_trust)
    )
    checks["sms_send_permission_scoped"] = (
        isinstance(policy, dict) and canonical(policy) == canonical(send_policy(identity_arn))
    )
    return checks


def write_report(report: dict[str, Any], forbidden: Iterable[str] = ()) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private SMS activation value reached summary")
    if re.search(r"arn:aws:", raw) or re.search(r"ca-central-1_[A-Za-z0-9]+", raw):
        raise ValueError("AWS identifier reached SMS activation summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    identity_arn = sys.argv[2] if len(sys.argv) > 2 else ""
    forbidden = [identity_arn]
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "cognito_sms_mfa_activation",
        "result": "blocked",
        "sms_activation_attempted": False,
        "marketing_sms_enabled": False,
    }
    try:
        sts = boto3.client("sts", region_name=REGION)
        cognito = boto3.client("cognito-idp", region_name=REGION)
        sms = boto3.client("pinpoint-sms-voice-v2", region_name=REGION)
        iam = boto3.client("iam", region_name=REGION)
        account = str(sts.get_caller_identity().get("Account", ""))
        require(bool(re.fullmatch(r"[0-9]{12}", account)), "AWS_ACCOUNT_INVALID")
        forbidden.append(account)

        pool_id, pool = discover_pool(cognito)
        client_id, client = discover_client(cognito, pool_id)
        forbidden.extend([pool_id, client_id])
        mfa = cognito.get_user_pool_mfa_config(UserPoolId=pool_id)
        baseline = baseline_checks(pool, mfa)
        require(all(baseline.values()), "COGNITO_SECURITY_BASELINE_MISMATCH")

        tier = account_tier(sms)
        identity = identity_status(sms, identity_arn, account)
        report.update({
            "sms_account_production": tier == "PRODUCTION",
            **identity,
            **baseline,
        })

        if operation == "preflight":
            ready = tier == "PRODUCTION" and all(identity.values())
            report["result"] = "ready_for_manual_activation" if ready else "waiting_for_sms_prerequisites"
            write_report(report, forbidden)
            return 0 if ready else 1

        if operation != "activate":
            raise Refused("UNSUPPORTED_OPERATION")

        require(os.environ.get("QF_SMS_CONFIRMATION") == CONFIRMATION, "ACTIVATION_CONFIRMATION_MISSING")
        require(tier == "PRODUCTION", "SMS_ACCOUNT_NOT_PRODUCTION")
        require(all(identity.values()), "ORIGINATION_IDENTITY_NOT_READY")

        ext = external_id(account, pool_id)
        caller = configure_role(
            iam,
            account,
            pool_arn(account, pool_id),
            ext,
            identity_arn,
        )

        report["sms_activation_attempted"] = True
        # IAM propagation can briefly lag after first role/policy creation.
        last_error: Exception | None = None
        for attempt in range(5):
            try:
                configure_pool_and_client(
                    cognito,
                    pool_id,
                    pool,
                    client_id,
                    client,
                    caller,
                    ext,
                    identity_arn,
                )
                last_error = None
                break
            except ClientError as error:
                last_error = error
                code = str(error.response.get("Error", {}).get("Code", ""))
                if code not in {
                    "InvalidSmsRoleTrustRelationshipException",
                    "InvalidSmsRoleAccessPolicyException",
                    "AccessDeniedException",
                } or attempt == 4:
                    raise
                time.sleep(4 * (attempt + 1))
        if last_error:
            raise last_error

        checks = verify_live(cognito, iam, account, identity_arn)
        failed = sorted(name for name, value in checks.items() if not value)
        report.update(checks)
        report["failed_checks"] = failed
        report["result"] = "sms_mfa_enabled" if not failed else "sms_mfa_readback_failed"
        write_report(report, forbidden)
        return 0 if not failed else 1
    except Refused as error:
        report["error_code"] = safe_code(str(error), "SMS_ACTIVATION_REFUSED")
    except ClientError as error:
        report["error_code"] = "AWS_SMS_ACTIVATION_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "SMS_ACTIVATION_FAILED")
    try:
        write_report(report, forbidden)
    except Exception:
        RESULT.unlink(missing_ok=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
