"""One-time migration of frozen Supabase password identities into production Cognito."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any
from urllib.request import Request, urlopen
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

from scripts.production.database import SOURCE_ISSUER
from scripts.production.lightsail.cognito_hash_import_preflight import (
    TEMP_ROLE_NAME,
    TEMP_ROLE_POLICY,
    create_logs_role,
    discover_browser_client,
    discover_pool,
    hash_capability,
    production_checks,
    start_job,
    upload_csv,
    wait_job,
)
from scripts.production.lightsail.migrate_supabase_history import (
    refresh_temp_access,
    retry_command,
    scp_key_only_command,
    ssh_failure_code,
    ssh_key_only_command,
)
from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    load_pins,
    normalized_ports,
    runner_ipv4,
    scan_host,
    scp_command,
    ssh_command,
)

REGION = "ca-central-1"
EXPECTED_USERS = 3
EXPORT_URL = "https://vfxmsvphgcaizqnbyjip.supabase.co/functions/v1/quizfromnotes-cognito-password-export"
OIDC_AUDIENCE = "quizfromnotes-cognito-password-export"
STATE_PARAMETER = "/quizforge/migration/cognito-auth-import-state"
RESULT = Path("cognito-auth-migration-results/summary.json")
BCRYPT = re.compile(r"^\$2[abxy]\$(\d{2})\$[./A-Za-z0-9]{53}$")
EMAIL = re.compile(r"^[^\s@,\"']+@[^\s@,\"']+$")
COGNITO_ISSUER_PREFIX = "https://cognito-idp.ca-central-1.amazonaws.com/"

REMOTE = r"""set -Eeuo pipefail
mapping="$1"
importer="$2"
database="$3"
stage="VALIDATE_HOST"
cleanup(){ rm -f "$mapping" "$importer" "$database"; }
trap 'printf "QF_FAILURE_STAGE=%s\n" "$stage" >&2' ERR
trap cleanup EXIT

test -s "$mapping"
test -s "$importer"
test -s "$database"
test -f /etc/quizforge/database-initialized
test -f /etc/quizforge/postgres/owner-password
test -f /etc/quizforge/db-ca.pem
systemctl is-active --quiet quizforge.service

stage="RESOLVE_OPERATIONS_IMAGE"
compose=/opt/quizforge/current/compose.json
ops_image="$(python3 - "$compose" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
image=value["services"]["guard"]["image"]
if not re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}",image):
    raise SystemExit(31)
print(image)
PY
)"

run_map(){
  operation="$1"
  docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1 --user 0:0 \
    -e PRODUCTION_DATABASE_TARGET=lightsail \
    -e PGHOST=db.quizforge.internal -e PGPORT=5432 -e PGDATABASE=quizforge -e PGUSER=quizforge_owner \
    -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem \
    -v /etc/quizforge:/etc/quizforge:ro \
    -v "$mapping:/run/migration/cognito-mapping.json:ro" \
    -v "$importer:/app/cognito_identity_import.py:ro" \
    -v "$database:/app/database.py:ro" \
    "$ops_image" sh -ec '
      export PGPASSWORD="$(cat /etc/quizforge/postgres/owner-password)"
      exec python /app/cognito_identity_import.py "$@" --mapping /run/migration/cognito-mapping.json
    ' sh "$operation"
}

stage="DRY_RUN_MAPPING"
dry="$(run_map dry-run)"
stage="COMMIT_MAPPING"
commit="$(run_map commit)"
stage="VERIFY_MAPPING"
verify="$(run_map verify)"
python3 - "$dry" "$commit" "$verify" <<'PY'
import json,sys
dry,commit,verify=(json.loads(v) for v in sys.argv[1:])
if [x["operation"] for x in (dry,commit,verify)] != ["dry-run","commit","verify"]:
    raise SystemExit(41)
users=verify["users"]
if users <= 0 or commit["inserted_identities"] + commit["existing_exact_identities"] != users:
    raise SystemExit(42)
if verify["inserted_identities"] != 0 or verify["existing_exact_identities"] != users:
    raise SystemExit(43)
if len({x["history_rows_for_migrated_users"] for x in (dry,commit,verify)}) != 1:
    raise SystemExit(44)
print("QF_RESULT="+json.dumps({
  "users":users,
  "inserted_identities":commit["inserted_identities"],
  "existing_exact_identities":commit["existing_exact_identities"],
  "history_rows_for_migrated_users":verify["history_rows_for_migrated_users"],
  "dry_run_passed":True,
  "commit_passed":True,
  "verify_passed":True,
},sort_keys=True))
PY
"""


def github_oidc() -> str:
    base = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    separator = "&" if "?" in base else "?"
    request = Request(
        base + separator + "audience=" + OIDC_AUDIENCE,
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    )
    with urlopen(request, timeout=15) as response:
        value = json.load(response)
    token = value.get("value")
    if not isinstance(token, str) or token.count(".") != 2 or len(token) > 10000:
        raise ValueError("GitHub OIDC token invalid")
    return token


def source_users() -> list[dict[str, Any]]:
    request = Request(
        EXPORT_URL,
        method="POST",
        data=b"{}",
        headers={
            "Authorization": "Bearer " + github_oidc(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=30) as response:
        raw = response.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024:
        raise ValueError("Credential export exceeds bound")
    value = json.loads(raw)
    if set(value) != {"schema", "issuer", "users"} or value["schema"] != 1 or value["issuer"] != SOURCE_ISSUER:
        raise ValueError("Credential export envelope invalid")
    users = value["users"]
    if not isinstance(users, list) or len(users) != EXPECTED_USERS:
        raise ValueError("Expected exact migrated user count")
    ids, emails = set(), set()
    for user in users:
        if not isinstance(user, dict) or set(user) != {"id", "email", "password_hash", "email_verified", "history_count"}:
            raise ValueError("Credential export entry invalid")
        uid = str(UUID(str(user["id"])))
        email = str(user["email"]).strip().lower()
        password_hash = str(user["password_hash"])
        match = BCRYPT.fullmatch(password_hash)
        if not match or int(match.group(1)) > 12:
            raise ValueError("Source bcrypt hash is not Cognito-compatible")
        if not EMAIL.fullmatch(email) or user["email_verified"] is not True:
            raise ValueError("Source email is not eligible for migration")
        if not isinstance(user["history_count"], int) or user["history_count"] < 0:
            raise ValueError("Source history count invalid")
        if uid in ids or email in emails:
            raise ValueError("Duplicate source identity")
        ids.add(uid); emails.add(email)
        user["id"] = uid
        user["email"] = email
    return users


def user_set_digest(users: list[dict[str, Any]]) -> str:
    public = [
        {"id": u["id"], "email": u["email"], "history_count": u["history_count"]}
        for u in sorted(users, key=lambda x: x["id"])
    ]
    return hashlib.sha256(json.dumps(public, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def build_csv(header: list[str], users: list[dict[str, Any]]) -> bytes:
    required = {"cognito:username", "email", "email_verified", "password_hash"}
    if not required.issubset(header):
        raise ValueError("Cognito import template is missing required fields")
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(header)
    for user in users:
        values = {name: "" for name in header}
        values["cognito:username"] = user["email"]
        values["email"] = user["email"]
        values["email_verified"] = "TRUE"
        values["password_hash"] = user["password_hash"]
        if "updated_at" in values:
            values["updated_at"] = str(int(time.time()))
        if "cognito:mfa_enabled" in values:
            values["cognito:mfa_enabled"] = ""
        writer.writerow([values[name] for name in header])
    return output.getvalue().encode()


def secure_delete(path: Path) -> None:
    try:
        size = path.stat().st_size
        with path.open("r+b", buffering=0) as handle:
            handle.write(b"\0" * size)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        pass
    path.unlink(missing_ok=True)


def read_state(ssm, digest: str) -> dict[str, Any] | None:
    try:
        raw = ssm.get_parameter(Name=STATE_PARAMETER, WithDecryption=True)["Parameter"]["Value"]
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return None
        raise
    value = json.loads(raw)
    if set(value) != {"schema", "user_set_sha256", "count", "import_succeeded", "mapping_succeeded"}:
        raise ValueError("Cognito migration state invalid")
    if value["schema"] != 1 or value["user_set_sha256"] != digest or value["count"] != EXPECTED_USERS:
        raise ValueError("Cognito migration state belongs to another source set")
    return value


def write_state(ssm, digest: str, *, mapping_succeeded: bool, overwrite: bool) -> None:
    ssm.put_parameter(
        Name=STATE_PARAMETER,
        Description="Quiz From Notes Supabase to Cognito credential migration state",
        Value=json.dumps({
            "schema": 1,
            "user_set_sha256": digest,
            "count": EXPECTED_USERS,
            "import_succeeded": True,
            "mapping_succeeded": mapping_succeeded,
        }, separators=(",", ":"), sort_keys=True),
        Type="SecureString",
        Tier="Standard",
        Overwrite=overwrite,
    )


def find_cognito_user(cognito, pool_id: str, email: str) -> dict[str, Any] | None:
    response = cognito.list_users(UserPoolId=pool_id, Filter=f'email = "{email}"', Limit=2)
    users = response.get("Users", [])
    if len(users) > 1:
        raise ValueError("Multiple Cognito users share one migrated email")
    return users[0] if users else None


def validated_cognito_mapping(cognito, pool_id: str, users: list[dict[str, Any]]) -> list[dict[str, str]]:
    mapping = []
    for source in users:
        user = find_cognito_user(cognito, pool_id, source["email"])
        if not user or user.get("UserStatus") != "CONFIRMED":
            raise ValueError("Imported Cognito user is missing or unconfirmed")
        attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
        if attrs.get("email", "").lower() != source["email"] or attrs.get("email_verified") != "true":
            raise ValueError("Imported Cognito email verification mismatch")
        subject = str(UUID(attrs["sub"]))
        mapping.append({"legacy_user_id": source["id"], "cognito_subject": subject})
    return mapping


def cleanup_import_role(iam) -> bool:
    ok = True
    try:
        iam.delete_role_policy(RoleName=TEMP_ROLE_NAME, PolicyName=TEMP_ROLE_POLICY)
    except ClientError as error:
        ok = ok and error.response.get("Error", {}).get("Code") == "NoSuchEntity"
    try:
        iam.delete_role(RoleName=TEMP_ROLE_NAME)
    except ClientError as error:
        ok = ok and error.response.get("Error", {}).get("Code") == "NoSuchEntity"
    return ok


def remote_map(mapping_path: Path, forbidden: list[str]) -> dict[str, Any]:
    lightsail = boto3.client("lightsail", region_name=REGION)
    instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
    static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
    ip = static.get("ipAddress")
    admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
    if not isinstance(ip, str) or static.get("attachedTo") != INSTANCE_NAME:
        raise ValueError("Production host contract mismatch")
    forbidden.extend([ip, admin])
    before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
    if normalized_ports(before) != baseline_ports(admin):
        raise ValueError("Baseline firewall mismatch")

    runner = runner_ipv4()
    forbidden.append(runner)
    opened = False
    temp = Path(tempfile.mkdtemp(prefix="qf-cognito-map-", dir=os.environ.get("RUNNER_TEMP")))
    temp.chmod(0o700)
    try:
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        opened = True
        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        known = scan_host(ip, pins)
        ssh_key, ssh_cert, hosts, username = refresh_temp_access(lightsail, temp, known, forbidden)
        time.sleep(30)
        use_certificate = True
        try:
            retry_command(ssh_command(ssh_key, ssh_cert, hosts, username, ip, "true"), attempts=2, timeout=30)
        except subprocess.CalledProcessError as error:
            if error.returncode != 255 or ssh_failure_code(error.stderr) != "AUTH_REJECTED":
                raise
            retry_command(ssh_key_only_command(ssh_key, hosts, username, ip, "true"), attempts=4, timeout=30)
            use_certificate = False

        base = "/tmp/qf-cognito-map-" + os.environ["GITHUB_RUN_ID"]
        remote_mapping, remote_importer, remote_database = base+".json", base+"-import.py", base+"-database.py"
        for local, remote in (
            (mapping_path, remote_mapping),
            (Path("scripts/production/cognito_identity_import.py"), remote_importer),
            (Path("scripts/production/database.py"), remote_database),
        ):
            command = (
                scp_command(ssh_key, ssh_cert, hosts, username, ip, local, remote)
                if use_certificate else scp_key_only_command(ssh_key, hosts, username, ip, local, remote)
            )
            retry_command(command, attempts=3, timeout=120)

        command = (
            ssh_command(ssh_key, ssh_cert, hosts, username, ip, "sudo","bash","-s","--",remote_mapping,remote_importer,remote_database)
            if use_certificate else
            ssh_key_only_command(ssh_key, hosts, username, ip, "sudo","bash","-s","--",remote_mapping,remote_importer,remote_database)
        )
        completed = retry_command(command, attempts=2, timeout=240, input_text=REMOTE)
        values = [line.removeprefix("QF_RESULT=") for line in completed.stdout.splitlines() if line.startswith("QF_RESULT=")]
        if len(values) != 1:
            raise ValueError("Unexpected identity mapping result")
        return json.loads(values[0])
    finally:
        if opened:
            lightsail.close_instance_public_ports(
                instanceName=INSTANCE_NAME,
                portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
            )
            after = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
            if normalized_ports(after) != baseline_ports(admin):
                raise RuntimeError("Baseline firewall was not restored")
        for child in temp.iterdir():
            child.unlink(missing_ok=True)
        try:
            temp.rmdir()
        except OSError:
            pass


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def write_report(report: dict[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if any(item and item in raw for item in forbidden):
        raise ValueError("Private credential migration value reached summary")
    if BCRYPT.search(raw) or re.search(r"ca-central-1_[A-Za-z0-9]+", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("Sensitive identifier reached summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "supabase_credentials_to_cognito",
        "result": "migration_failed",
        "source_users": 0,
        "source_history_rows": 0,
        "cognito_import_succeeded": False,
        "identity_mapping_succeeded": False,
        "password_reset_required": False,
        "new_totp_setup_required": True,
        "source_modified": False,
        "dns_changed": False,
        "application_changed": False,
        "ai_configuration_changed": False,
        "temporary_import_role_removed": False,
    }
    forbidden: list[str] = []
    temp: Path | None = None
    iam = boto3.client("iam", region_name=REGION)
    try:
        if (
            os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"
            or os.environ.get("GITHUB_RUN_ATTEMPT") != "1"
        ):
            raise ValueError("Credential migration requires first trusted main push")

        users = source_users()
        report["source_users"] = len(users)
        report["source_history_rows"] = sum(u["history_count"] for u in users)
        for user in users:
            forbidden.extend([user["id"], user["email"], user["password_hash"]])
        digest = user_set_digest(users)

        cognito = boto3.client("cognito-idp", region_name=REGION)
        pool_id = discover_pool(cognito)
        browser_client_id = discover_browser_client(cognito, pool_id)
        forbidden.extend([pool_id, browser_client_id])
        if not all(production_checks(cognito, pool_id, browser_client_id).values()):
            raise ValueError("Production Cognito security baseline changed")
        supported, header = hash_capability(cognito, pool_id)
        if not supported:
            raise ValueError("Production Cognito pool lacks password-hash import")
        issuer = COGNITO_ISSUER_PREFIX + pool_id
        forbidden.append(issuer)

        ssm = boto3.client("ssm", region_name=REGION)
        state = read_state(ssm, digest)
        existing = [find_cognito_user(cognito, pool_id, u["email"]) for u in users]
        existing_count = sum(user is not None for user in existing)
        report["preexisting_cognito_users"] = existing_count

        if existing_count == 0:
            if state and state["import_succeeded"]:
                raise ValueError("Migration state says imported users exist but Cognito is empty")
            role_arn = create_logs_role(iam, pool_id)
            temp = Path(tempfile.mkdtemp(prefix="qf-cognito-import-", dir=os.environ.get("RUNNER_TEMP")))
            temp.chmod(0o700)
            csv_path = temp / "users.csv"
            payload = build_csv(header, users)
            csv_path.write_bytes(payload)
            csv_path.chmod(0o600)
            job = cognito.create_user_import_job(
                JobName="quizforge-real-user-migration-" + os.environ["GITHUB_RUN_ID"],
                UserPoolId=pool_id,
                CloudWatchLogsRoleArn=role_arn,
                PasswordHashingAlgorithm="BCRYPT",
            )["UserImportJob"]
            upload_csv(str(job["PreSignedUrl"]), payload)
            secure_delete(csv_path)
            payload = b""
            started = start_job(cognito, pool_id, str(job["JobId"]))
            completed = wait_job(cognito, pool_id, str(started["JobId"]))
            if (
                completed.get("Status") != "Succeeded"
                or completed.get("ImportedUsers") != EXPECTED_USERS
                or completed.get("FailedUsers") != 0
                or completed.get("SkippedUsers", 0) != 0
            ):
                raise ValueError("Cognito credential import did not reconcile exactly")
            report["cognito_import_succeeded"] = True
            write_state(ssm, digest, mapping_succeeded=False, overwrite=False)
            state = {"schema":1,"user_set_sha256":digest,"count":EXPECTED_USERS,"import_succeeded":True,"mapping_succeeded":False}
        elif existing_count == EXPECTED_USERS and state and state["import_succeeded"]:
            report["cognito_import_succeeded"] = True
            report["resumed_after_import"] = True
        else:
            raise ValueError("Existing Cognito users conflict with guarded migration")

        mapping = validated_cognito_mapping(cognito, pool_id, users)
        for item in mapping:
            forbidden.extend([item["legacy_user_id"], item["cognito_subject"]])
        if len(mapping) != EXPECTED_USERS:
            raise ValueError("Cognito mapping count mismatch")

        temp = temp or Path(tempfile.mkdtemp(prefix="qf-cognito-map-input-", dir=os.environ.get("RUNNER_TEMP")))
        temp.chmod(0o700)
        mapping_path = temp / "mapping.json"
        mapping_path.write_text(json.dumps({"schema":1,"cognito_issuer":issuer,"users":mapping}, separators=(",",":")), encoding="utf-8")
        mapping_path.chmod(0o600)
        mapped = remote_map(mapping_path, forbidden)
        if (
            mapped.get("users") != EXPECTED_USERS
            or mapped.get("verify_passed") is not True
            or mapped.get("history_rows_for_migrated_users") != report["source_history_rows"]
        ):
            raise ValueError("Lightsail identity mapping did not reconcile exactly")
        report["identity_mapping_succeeded"] = True
        report["inserted_cognito_identities"] = mapped["inserted_identities"]
        report["existing_exact_cognito_identities"] = mapped["existing_exact_identities"]
        write_state(ssm, digest, mapping_succeeded=True, overwrite=True)
        report["result"] = "cognito_credential_migration_succeeded"
    except ClientError as error:
        report["error_code"] = safe_code(error.response.get("Error", {}).get("Code"), "AWS_MIGRATION_FAILED")
        report["aws_operation"] = safe_code(getattr(error, "operation_name", ""), "AWS_OPERATION")
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_IDENTITY_MAPPING_FAILED"
        report["remote_return_code"] = error.returncode
        report["ssh_failure_code"] = ssh_failure_code(error.stderr)
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "MIGRATION_FAILED")
    finally:
        report["temporary_import_role_removed"] = cleanup_import_role(iam)
        if temp:
            for child in temp.iterdir():
                if child.is_file():
                    secure_delete(child)
            try:
                temp.rmdir()
            except OSError:
                pass
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "cognito_credential_migration_succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
