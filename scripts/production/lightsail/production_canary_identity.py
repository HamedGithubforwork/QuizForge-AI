"""Run-scoped synthetic Cognito identity for the permanent production browser canary.

Preparation creates one admin-only user with email delivery suppressed, completes
mandatory software TOTP setup, and writes all browser credentials to a mode-0600
runner file. Cleanup removes the exact local identity only when it owns no quiz
history, then deletes the synthetic Cognito user and temporary fixture client.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    load_pins,
    normalized_ports,
    runner_ipv4,
    scan_host,
    ssh_command,
)

REGION = "ca-central-1"
POOL_NAME = "quizforge-production-lightsail"
PRODUCTION_CLIENT_NAME = "quizforge-production-pkce"
POOL_RE = re.compile(r"^ca-central-1_[A-Za-z0-9]{1,55}$")
CLIENT_RE = re.compile(r"^[a-z0-9]{1,128}$")
EMAIL_RE = re.compile(r"^qf-prod-canary-[0-9]+@example\.invalid$")

REMOTE_CLEANUP = r"""set -euo pipefail
pool_id="$1"
subject="$2"

case "$pool_id" in ca-central-1_*) ;; *) exit 31 ;; esac
python3 - "$subject" <<'PY'
from uuid import UUID
import sys
UUID(sys.argv[1])
PY

compose=/opt/quizforge/current/compose.json
test -f /etc/quizforge/database-initialized
test -f /etc/quizforge/launch-approved
systemctl is-active --quiet quizforge.service
test -s "$compose"

ops_image="$(python3 - "$compose" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
image=value["services"]["guard"]["image"]
assert re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}",image)
print(image)
PY
)"

issuer="https://cognito-idp.ca-central-1.amazonaws.com/$pool_id"

docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1 \
  --user 0:0 \
  -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e PGHOST=db.quizforge.internal \
  -e PGDATABASE=quizforge \
  -e PGUSER=quizforge_owner \
  -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem \
  -e QF_CANARY_ISSUER="$issuer" \
  -e QF_CANARY_SUBJECT="$subject" \
  -v /etc/quizforge:/etc/quizforge \
  "$ops_image" python -c '
import os
from pathlib import Path
import psycopg
from database import options

os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
issuer=os.environ["QF_CANARY_ISSUER"]
subject=os.environ["QF_CANARY_SUBJECT"]

with psycopg.connect(**options(os.environ)) as conn:
    rows=conn.execute(
        "SELECT user_id FROM app.user_identities WHERE issuer=%s AND subject=%s",
        (issuer,subject),
    ).fetchall()
    assert len(rows) <= 1
    if rows:
        user_id=rows[0]["user_id"]
        identity_count=conn.execute(
            "SELECT count(*) AS n FROM app.user_identities WHERE user_id=%s",
            (user_id,),
        ).fetchone()["n"]
        history_count=conn.execute(
            "SELECT count(*) AS n FROM app.quiz_history WHERE user_id=%s",
            (user_id,),
        ).fetchone()["n"]
        assert identity_count == 1
        assert history_count == 0
        deleted=conn.execute(
            "DELETE FROM app.user_identities WHERE issuer=%s AND subject=%s RETURNING user_id",
            (issuer,subject),
        ).fetchall()
        assert len(deleted) == 1 and deleted[0]["user_id"] == user_id
        removed=conn.execute(
            "DELETE FROM app.users WHERE id=%s RETURNING id",
            (user_id,),
        ).fetchall()
        assert len(removed) == 1
' >/dev/null
"""


def totp(secret: str, timestamp: float | None = None) -> str:
    if not re.fullmatch(r"[A-Z2-7]{16,128}", secret):
        raise ValueError("Invalid TOTP secret")
    encoded = secret + "=" * (-len(secret) % 8)
    key = base64.b32decode(encoded)
    counter = int((time.time() if timestamp is None else timestamp) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def canary_email(run_id: str) -> str:
    if not re.fullmatch(r"[0-9]{1,20}", run_id):
        raise ValueError("Invalid GitHub run id")
    return f"qf-prod-canary-{run_id}@example.invalid"


def private_write(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError("Fixture path already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "x", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write("\n")


def pages(client, method: str, result_key: str, **kwargs) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    token = None
    while True:
        request = dict(kwargs)
        if token:
            request["NextToken"] = token
        response = getattr(client, method)(**request)
        values = response.get(result_key) or []
        if not isinstance(values, list):
            raise ValueError("Unexpected Cognito list response")
        result.extend(item for item in values if isinstance(item, dict))
        token = response.get("NextToken")
        if not token:
            return result


def discover(cognito) -> tuple[str, str]:
    pools = [
        item
        for item in pages(cognito, "list_user_pools", "UserPools", MaxResults=60)
        if item.get("Name") == POOL_NAME
    ]
    if len(pools) != 1 or not POOL_RE.fullmatch(str(pools[0].get("Id", ""))):
        raise ValueError("Expected exact production Cognito pool")
    pool_id = pools[0]["Id"]
    clients = [
        item
        for item in pages(
            cognito,
            "list_user_pool_clients",
            "UserPoolClients",
            UserPoolId=pool_id,
            MaxResults=60,
        )
        if item.get("ClientName") == PRODUCTION_CLIENT_NAME
    ]
    if len(clients) != 1 or not CLIENT_RE.fullmatch(str(clients[0].get("ClientId", ""))):
        raise ValueError("Expected exact production Cognito browser client")
    client_id = clients[0]["ClientId"]
    described = cognito.describe_user_pool_client(
        UserPoolId=pool_id,
        ClientId=client_id,
    )["UserPoolClient"]
    if (
        described.get("GenerateSecret") is not False
        or set(described.get("CallbackURLs") or []) != {"https://quizfromnotes.com/auth/callback"}
        or set(described.get("LogoutURLs") or []) != {"https://quizfromnotes.com/"}
        or set(described.get("AllowedOAuthFlows") or []) != {"code"}
    ):
        raise ValueError("Production Cognito client contract mismatch")
    return pool_id, client_id


def validate_fixture(value: dict[str, Any]) -> dict[str, str]:
    expected = {
        "schema",
        "pool",
        "production_client",
        "fixture_client",
        "username",
        "email",
        "password",
        "totp",
        "subject",
    }
    if set(value) != expected or value.get("schema") != 1:
        raise ValueError("Invalid fixture shape")
    strings = {key: value[key] for key in expected - {"schema"}}
    if not all(isinstance(item, str) and item for item in strings.values()):
        raise ValueError("Invalid fixture values")
    if not POOL_RE.fullmatch(strings["pool"]):
        raise ValueError("Invalid pool")
    if not CLIENT_RE.fullmatch(strings["production_client"]) or not CLIENT_RE.fullmatch(strings["fixture_client"]):
        raise ValueError("Invalid client")
    if not EMAIL_RE.fullmatch(strings["email"]):
        raise ValueError("Invalid fixture email")
    if not re.fullmatch(r"[A-Z2-7]{16,128}", strings["totp"]):
        raise ValueError("Invalid TOTP secret")
    str(UUID(strings["subject"]))
    if len(strings["password"]) < 20 or len(strings["password"]) > 200 or re.search(r"\s", strings["password"]):
        raise ValueError("Invalid password")
    return strings


class PrepareFailed(Exception):
    pass


def prepare(path: Path) -> None:
    stage = "run_id"
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    email = canary_email(run_id)
    password = "Qf9!" + secrets.token_urlsafe(32)
    cognito = boto3.client("cognito-idp", region_name=REGION)
    stage = "discover"
    pool_id, production_client = discover(cognito)
    fixture_client = None
    username = None
    try:
        stage = "create_fixture_client"
        created_client = cognito.create_user_pool_client(
            UserPoolId=pool_id,
            ClientName=f"quizforge-production-canary-{run_id}",
            GenerateSecret=False,
            ExplicitAuthFlows=[
                "ALLOW_ADMIN_USER_PASSWORD_AUTH",
                "ALLOW_REFRESH_TOKEN_AUTH",
            ],
            PreventUserExistenceErrors="ENABLED",
            EnableTokenRevocation=True,
            AccessTokenValidity=5,
            IdTokenValidity=5,
            RefreshTokenValidity=1,
            TokenValidityUnits={
                "AccessToken": "minutes",
                "IdToken": "minutes",
                "RefreshToken": "hours",
            },
        )["UserPoolClient"]
        fixture_client = created_client["ClientId"]
        if not CLIENT_RE.fullmatch(str(fixture_client)):
            raise ValueError("Unexpected fixture client id")

        stage = "create_user"
        cognito.admin_create_user(
            UserPoolId=pool_id,
            Username=email,
            MessageAction="SUPPRESS",
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
        )
        stage = "read_user"
        created = cognito.admin_get_user(UserPoolId=pool_id, Username=email)
        username = created["Username"]
        if not isinstance(username, str) or not username or len(username) > 128:
            raise ValueError("Unexpected Cognito username")
        stage = "set_password"
        cognito.admin_set_user_password(
            UserPoolId=pool_id,
            Username=username,
            Password=password,
            Permanent=True,
        )
        stage = "begin_mfa"
        login = cognito.admin_initiate_auth(
            UserPoolId=pool_id,
            ClientId=fixture_client,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        if login.get("ChallengeName") != "MFA_SETUP" or not login.get("Session"):
            raise ValueError("Mandatory MFA setup did not start")
        challenge_username = login.get("ChallengeParameters", {}).get("USERNAME", email)
        stage = "associate_totp"
        association = cognito.associate_software_token(Session=login["Session"])
        secret = str(association.get("SecretCode", ""))
        if not re.fullmatch(r"[A-Z2-7]{16,128}", secret):
            raise ValueError("Unexpected TOTP secret")
        stage = "verify_totp"
        verified = cognito.verify_software_token(
            Session=association["Session"],
            UserCode=totp(secret),
        )
        if verified.get("Status") != "SUCCESS" or not verified.get("Session"):
            raise ValueError("TOTP setup failed")
        stage = "finish_mfa"
        result = cognito.admin_respond_to_auth_challenge(
            UserPoolId=pool_id,
            ClientId=fixture_client,
            ChallengeName="MFA_SETUP",
            Session=verified["Session"],
            ChallengeResponses={"USERNAME": challenge_username},
        ).get("AuthenticationResult") or {}
        access = result.get("AccessToken")
        if not isinstance(access, str) or not access:
            raise ValueError("MFA setup did not produce an access token")
        stage = "read_subject"
        user = cognito.get_user(AccessToken=access)
        subject = next(
            (
                item.get("Value")
                for item in user.get("UserAttributes", [])
                if item.get("Name") == "sub"
            ),
            None,
        )
        subject = str(UUID(str(subject)))
        stage = "set_mfa_preference"
        cognito.admin_set_user_mfa_preference(
            UserPoolId=pool_id,
            Username=username,
            SoftwareTokenMfaSettings={"Enabled": True, "PreferredMfa": True},
        )
        stage = "write_fixture"
        private_write(
            path,
            {
                "schema": 1,
                "pool": pool_id,
                "production_client": production_client,
                "fixture_client": fixture_client,
                "username": username,
                "email": email,
                "password": password,
                "totp": secret,
                "subject": subject,
            },
        )
        print("PASS: run-scoped production Cognito canary prepared with mandatory TOTP")
    except Exception:
        if username:
            try:
                cognito.admin_delete_user(UserPoolId=pool_id, Username=username)
            except Exception:
                pass
        if fixture_client:
            try:
                cognito.delete_user_pool_client(UserPoolId=pool_id, ClientId=fixture_client)
            except Exception:
                pass
        path.unlink(missing_ok=True)
        code = "PREPARE_" + re.sub(r"[^A-Z0-9_]", "_", stage.upper())
        raise PrepareFailed(code) from None


def cleanup_local_identity(pool_id: str, subject: str) -> None:
    admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
    pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
    lightsail = boto3.client("lightsail", region_name=REGION)
    runner = None
    temp = None
    cleanup_error = None
    try:
        instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip = static.get("ipAddress")
        if (
            instance.get("blueprintId") != "ubuntu_24_04"
            or instance.get("bundleId") != "small_3_0"
            or instance.get("isStaticIp") is not True
            or static.get("attachedTo") != INSTANCE_NAME
            or not isinstance(ip, str)
        ):
            raise ValueError("Permanent Lightsail instance contract mismatch")
        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if normalized_ports(before) != baseline_ports(admin):
            raise ValueError("Baseline firewall mismatch")

        runner = runner_ipv4()
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={
                "fromPort": 22,
                "toPort": 22,
                "protocol": "tcp",
                "cidrs": [runner + "/32"],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        )
        known = scan_host(ip, pins)
        access = lightsail.get_instance_access_details(
            instanceName=INSTANCE_NAME,
            protocol="ssh",
        )["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        if not all(isinstance(item, str) and item for item in (private_key, cert_key, username)):
            raise ValueError("Temporary SSH access incomplete")

        temp = Path(tempfile.mkdtemp(prefix="quizforge-prod-canary-cleanup-"))
        temp.chmod(0o700)
        key = temp / "key"
        cert = temp / "key-cert.pub"
        hosts = temp / "known_hosts"
        key.write_text(private_key)
        key.chmod(0o600)
        cert.write_text(cert_key + ("" if cert_key.endswith("\n") else "\n"))
        cert.chmod(0o600)
        hosts.write_text(known)
        hosts.chmod(0o600)
        subprocess.run(
            ssh_command(
                key,
                cert,
                hosts,
                username,
                ip,
                "sudo",
                "bash",
                "-s",
                "--",
                pool_id,
                subject,
            ),
            input=REMOTE_CLEANUP,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=180,
            check=True,
        )
    except Exception as error:
        cleanup_error = error
    finally:
        if runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={
                        "fromPort": 22,
                        "toPort": 22,
                        "protocol": "tcp",
                        "cidrs": [runner + "/32"],
                        "ipv6Cidrs": [],
                        "cidrListAliases": [],
                    },
                )
                after = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
                if normalized_ports(after) != baseline_ports(admin):
                    raise RuntimeError("Baseline firewall was not restored")
            except Exception as error:
                cleanup_error = cleanup_error or error
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
    if cleanup_error:
        raise cleanup_error


def cleanup(path: Path) -> None:
    if not path.is_file():
        print("PASS: no production canary fixture exists to clean")
        return
    value = json.loads(path.read_text(encoding="utf-8"))
    fixture = validate_fixture(value)
    cleanup_local_identity(fixture["pool"], fixture["subject"])

    cognito = boto3.client("cognito-idp", region_name=REGION)
    current_pool, current_client = discover(cognito)
    if current_pool != fixture["pool"] or current_client != fixture["production_client"]:
        raise ValueError("Production Cognito resources changed during canary")
    cognito.admin_delete_user(
        UserPoolId=fixture["pool"],
        Username=fixture["username"],
    )
    cognito.delete_user_pool_client(
        UserPoolId=fixture["pool"],
        ClientId=fixture["fixture_client"],
    )
    path.unlink()
    print("PASS: exact synthetic Cognito user, empty local identity and fixture client removed")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"prepare", "cleanup"}:
        print("usage: production_canary_identity.py prepare|cleanup FIXTURE", file=sys.stderr)
        return 2
    try:
        if sys.argv[1] == "prepare":
            prepare(Path(sys.argv[2]))
        else:
            cleanup(Path(sys.argv[2]))
        return 0
    except PrepareFailed as error:
        print(f"Production canary identity operation failed: {error}", file=sys.stderr)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "AWS_ERROR")
        code = code if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", str(code)) else "AWS_ERROR"
        print(f"Production canary identity operation failed: {code}", file=sys.stderr)
    except Exception as error:
        print(f"Production canary identity operation failed: {type(error).__name__}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
