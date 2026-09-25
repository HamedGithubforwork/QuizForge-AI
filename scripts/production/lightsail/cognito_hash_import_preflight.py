"""One-time production Cognito bcrypt-import preflight using only a synthetic user."""
from __future__ import annotations

import base64
import crypt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.request

import boto3
from botocore.exceptions import ClientError

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
BROWSER_CLIENT_NAME = "quizforge-production-pkce"
TEMP_ROLE_NAME = "quizforge-production-cognito-import-preflight"
TEMP_ROLE_POLICY = "quizforge-cognito-import-preflight-logs"
TEMP_CLIENT_NAME = "quizforge-cognito-import-preflight"
TEMP_EMAIL = "qf-cognito-hash-preflight@example.invalid"
RESULT = Path("cognito-hash-import-preflight-results/summary.json")


def discover_pool(client) -> str:
    matches = []
    token = None
    while True:
        kwargs = {"MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        response = client.list_user_pools(**kwargs)
        matches.extend(x for x in response.get("UserPools", []) if x.get("Name") == POOL_NAME)
        token = response.get("NextToken")
        if not token:
            break
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one production Cognito pool")
    pool_id = str(matches[0].get("Id", ""))
    if not re.fullmatch(r"ca-central-1_[A-Za-z0-9]{1,55}", pool_id):
        raise RuntimeError("Unexpected production Cognito pool identifier")
    return pool_id


def discover_browser_client(client, pool_id: str) -> str:
    matches = []
    token = None
    while True:
        kwargs = {"UserPoolId": pool_id, "MaxResults": 60}
        if token:
            kwargs["NextToken"] = token
        response = client.list_user_pool_clients(**kwargs)
        matches.extend(x for x in response.get("UserPoolClients", []) if x.get("ClientName") == BROWSER_CLIENT_NAME)
        token = response.get("NextToken")
        if not token:
            break
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one production browser client")
    return str(matches[0]["ClientId"])


def production_checks(client, pool_id: str, browser_client_id: str) -> dict[str, bool]:
    pool = client.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    mfa = client.get_user_pool_mfa_config(UserPoolId=pool_id)
    app = client.describe_user_pool_client(UserPoolId=pool_id, ClientId=browser_client_id)["UserPoolClient"]
    return {
        "pool_lite": pool.get("UserPoolTier") == "LITE",
        "email_username": pool.get("UsernameAttributes") == ["email"],
        "email_auto_verified": pool.get("AutoVerifiedAttributes") == ["email"],
        "mandatory_mfa": pool.get("MfaConfiguration") == "ON",
        "software_totp_enabled": mfa.get("SoftwareTokenMfaConfiguration", {}).get("Enabled") is True,
        "browser_client_public": not bool(app.get("ClientSecret")),
        "existence_protection": app.get("PreventUserExistenceErrors") == "ENABLED",
    }


def hash_capability(client, pool_id: str) -> tuple[bool, list[str]]:
    header = client.get_csv_header(UserPoolId=pool_id).get("CSVHeader", [])
    if not isinstance(header, list) or "cognito:username" not in header:
        raise RuntimeError("Cognito import CSV header is invalid")
    return "password_hash" in header, [str(x) for x in header]


def bcrypt_hash(password: str) -> str:
    salt = crypt.mksalt(crypt.METHOD_BLOWFISH, rounds=1 << 12)
    value = crypt.crypt(password, salt)
    if not re.fullmatch(r"\$2[abxy]\$12\$[./A-Za-z0-9]{53}", value or ""):
        raise RuntimeError("Runner could not generate a Cognito-compatible bcrypt hash")
    return value


def csv_bytes(header: list[str], password_hash: str) -> bytes:
    if "password_hash" not in header:
        raise RuntimeError("Production pool does not expose password hash import")
    values = {name: "" for name in header}
    values["cognito:username"] = TEMP_EMAIL
    if "email" not in values or "email_verified" not in values:
        raise RuntimeError("Production pool import template is missing email fields")
    values["email"] = TEMP_EMAIL
    values["email_verified"] = "TRUE"
    values["password_hash"] = password_hash
    if "updated_at" in values:
        values["updated_at"] = str(int(time.time()))
    if "cognito:mfa_enabled" in values:
        values["cognito:mfa_enabled"] = ""
    for value in values.values():
        if any(c in str(value) for c in ("\r", "\n", ",")):
            raise RuntimeError("Unsafe synthetic CSV field")
    return (",".join(header) + "\n" + ",".join(str(values[name]) for name in header) + "\n").encode("utf-8")


def upload_csv(url: str, payload: bytes) -> None:
    request = urllib.request.Request(
        url,
        data=payload,
        method="PUT",
        headers={"x-amz-server-side-encryption": "aws:kms"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status not in (200, 201, 204):
            raise RuntimeError("Cognito CSV upload failed")


def create_logs_role(iam, pool_id: str) -> str:
    account_id = boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "cognito-idp.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }
    role = iam.create_role(
        RoleName=TEMP_ROLE_NAME,
        AssumeRolePolicyDocument=json.dumps(trust, separators=(",", ":")),
        Description="Temporary Quiz From Notes Cognito bcrypt-import preflight role",
    )["Role"]
    logs = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
            "Resource": f"arn:aws:logs:{REGION}:{account_id}:log-group:/aws/cognito/*",
        }],
    }
    iam.put_role_policy(
        RoleName=TEMP_ROLE_NAME,
        PolicyName=TEMP_ROLE_POLICY,
        PolicyDocument=json.dumps(logs, separators=(",", ":")),
    )
    iam.get_waiter("role_exists").wait(RoleName=TEMP_ROLE_NAME)
    time.sleep(8)
    return str(role["Arn"])


def totp(secret: str, now: float | None = None) -> str:
    padded = secret.upper() + "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(padded)
    counter = int((time.time() if now is None else now) // 30).to_bytes(8, "big")
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def wait_job(client, pool_id: str, job_id: str) -> dict:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        job = client.describe_user_import_job(UserPoolId=pool_id, JobId=job_id)["UserImportJob"]
        if job.get("Status") in ("Succeeded", "Failed", "Stopped", "Expired"):
            return job
        time.sleep(3)
    raise RuntimeError("Cognito import job did not finish in time")


def run_preflight() -> dict[str, object]:
    cognito = boto3.client("cognito-idp", region_name=REGION)
    iam = boto3.client("iam", region_name=REGION)
    pool_id = discover_pool(cognito)
    browser_client_id = discover_browser_client(cognito, pool_id)
    checks = production_checks(cognito, pool_id, browser_client_id)
    if not all(checks.values()):
        raise RuntimeError("Production Cognito security baseline changed")

    supported, header = hash_capability(cognito, pool_id)
    if not supported:
        return {
            "schema": 1,
            "result": "unsupported",
            **checks,
            "password_hash_column_available": False,
            "synthetic_user_created": False,
            "existing_password_verified": False,
            "mfa_setup_required": False,
            "mfa_setup_completed": False,
            "synthetic_user_removed": True,
            "temporary_client_removed": True,
            "temporary_role_removed": True,
        }

    if cognito.list_users(UserPoolId=pool_id, Filter=f'email = "{TEMP_EMAIL}"', Limit=1).get("Users"):
        raise RuntimeError("Synthetic preflight user already exists")

    password = "Qf9!" + secrets.token_urlsafe(32)
    synthetic_hash = bcrypt_hash(password)
    role_created = False
    user_created = False
    client_id = None
    client_removed = False
    user_removed = False
    role_removed = False
    try:
        role_arn = create_logs_role(iam, pool_id)
        role_created = True

        job = cognito.create_user_import_job(
            JobName=f"quizforge-hash-preflight-{int(time.time())}",
            UserPoolId=pool_id,
            CloudWatchLogsRoleArn=role_arn,
            PasswordHashingAlgorithm="BCRYPT",
        )["UserImportJob"]
        if job.get("PasswordHashingAlgorithm") != "BCRYPT":
            raise RuntimeError("Cognito did not accept bcrypt import mode")

        upload_csv(str(job["PreSignedUrl"]), csv_bytes(header, synthetic_hash))
        started = cognito.start_user_import_job(UserPoolId=pool_id, JobId=job["JobId"])["UserImportJob"]
        completed = wait_job(cognito, pool_id, str(started["JobId"]))
        if completed.get("Status") != "Succeeded" or completed.get("ImportedUsers") != 1 or completed.get("FailedUsers") != 0:
            raise RuntimeError("Synthetic bcrypt import did not succeed")
        user_created = True

        user = cognito.admin_get_user(UserPoolId=pool_id, Username=TEMP_EMAIL)
        attrs = {a["Name"]: a["Value"] for a in user.get("UserAttributes", [])}
        if user.get("UserStatus") != "CONFIRMED" or attrs.get("email_verified") != "true":
            raise RuntimeError("Imported synthetic user has unexpected state")

        temp_client = cognito.create_user_pool_client(
            UserPoolId=pool_id,
            ClientName=TEMP_CLIENT_NAME,
            GenerateSecret=False,
            ExplicitAuthFlows=["ALLOW_ADMIN_USER_PASSWORD_AUTH"],
            PreventUserExistenceErrors="ENABLED",
            EnableTokenRevocation=True,
        )["UserPoolClient"]
        client_id = str(temp_client["ClientId"])

        login = cognito.admin_initiate_auth(
            UserPoolId=pool_id,
            ClientId=client_id,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": TEMP_EMAIL, "PASSWORD": password},
        )
        if login.get("ChallengeName") != "MFA_SETUP" or login.get("AuthenticationResult"):
            raise RuntimeError("Imported password did not reach required MFA setup")

        association = cognito.associate_software_token(Session=login["Session"])
        secret = str(association["SecretCode"])
        verified = cognito.verify_software_token(
            Session=association["Session"],
            UserCode=totp(secret),
        )
        if verified.get("Status") != "SUCCESS":
            raise RuntimeError("Synthetic TOTP verification failed")
        challenge_username = login.get("ChallengeParameters", {}).get("USERNAME", TEMP_EMAIL)
        result = cognito.admin_respond_to_auth_challenge(
            UserPoolId=pool_id,
            ClientId=client_id,
            ChallengeName="MFA_SETUP",
            Session=verified["Session"],
            ChallengeResponses={"USERNAME": challenge_username},
        )
        access = result.get("AuthenticationResult", {}).get("AccessToken")
        if not access:
            raise RuntimeError("MFA setup did not complete authentication")
        after = cognito.get_user(AccessToken=access)
        after_attrs = {a["Name"]: a["Value"] for a in after.get("UserAttributes", [])}
        if after_attrs.get("email") != TEMP_EMAIL or after_attrs.get("email_verified") != "true":
            raise RuntimeError("Synthetic identity changed during MFA setup")

        return {
            "schema": 1,
            "result": "passed",
            **checks,
            "password_hash_column_available": True,
            "bcrypt_import_job_succeeded": True,
            "synthetic_user_created": True,
            "existing_password_verified": True,
            "mfa_setup_required": True,
            "mfa_setup_completed": True,
        }
    finally:
        if client_id:
            try:
                cognito.delete_user_pool_client(UserPoolId=pool_id, ClientId=client_id)
                client_removed = True
            except ClientError:
                pass
        try:
            cognito.admin_delete_user(UserPoolId=pool_id, Username=TEMP_EMAIL)
            user_removed = True
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "UserNotFoundException":
                user_removed = True
        if role_created:
            try:
                iam.delete_role_policy(RoleName=TEMP_ROLE_NAME, PolicyName=TEMP_ROLE_POLICY)
            except ClientError:
                pass
            try:
                iam.delete_role(RoleName=TEMP_ROLE_NAME)
                role_removed = True
            except ClientError:
                pass
        cleanup = {
            "synthetic_user_removed": user_removed,
            "temporary_client_removed": client_removed or client_id is None,
            "temporary_role_removed": role_removed or not role_created,
        }
        Path(os.environ.get("RUNNER_TEMP", "/tmp")).joinpath("qf-cognito-hash-preflight-cleanup.json").write_text(
            json.dumps(cleanup, sort_keys=True) + "\n", encoding="utf-8"
        )


def write_report(report: dict[str, object]) -> None:
    cleanup_path = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "qf-cognito-hash-preflight-cleanup.json"
    if cleanup_path.exists():
        report.update(json.loads(cleanup_path.read_text(encoding="utf-8")))
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    banned = [
        r"\$2[abxy]\$",
        r"ca-central-1_[A-Za-z0-9]+",
        r"\b\d{12}\b",
        r"AKIA[0-9A-Z]{16}",
        r"ASIA[0-9A-Z]{16}",
        r"qf-cognito-hash-preflight@example\.invalid",
    ]
    if any(re.search(pattern, raw) for pattern in banned):
        raise RuntimeError("Sensitive or private identifier reached the preflight report")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, object] = {
        "schema": 1,
        "result": "failed",
        "password_hash_column_available": False,
        "synthetic_user_created": False,
        "existing_password_verified": False,
        "mfa_setup_required": False,
        "mfa_setup_completed": False,
    }
    try:
        report = run_preflight()
        return_code = 0 if report.get("result") == "passed" else 2
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", "AWS_ERROR"))
        operation = str(getattr(error, "operation_name", "AWS_OPERATION"))
        report["error_class"] = code if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", code) else "AWS_ERROR"
        report["aws_operation"] = operation if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", operation) else "AWS_OPERATION"
        return_code = 1
    except Exception as error:
        report["error_class"] = type(error).__name__
        return_code = 1
    finally:
        try:
            write_report(report)
        except Exception:
            return 1
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
