"""Migrate the frozen Supabase history snapshot into permanent Lightsail PostgreSQL."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import socket
import tempfile
import time
from typing import Any
from urllib.request import Request, urlopen

import boto3
from botocore.exceptions import ClientError

from scripts.production.database import SOURCE_ISSUER
from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    normalized_ports,
    load_pins,
    runner_ipv4,
    scan_host,
    ssh_command,
    scp_command,
)
from scripts.rds_rehearsal.history_transfer import seal, validate

REGION = "ca-central-1"
EXPORT_URL = "https://vfxmsvphgcaizqnbyjip.supabase.co/functions/v1/quizfromnotes-migration-export"
OIDC_AUDIENCE = "quizfromnotes-supabase-export"
RESULT = Path("lightsail-history-migration-results/summary.json")

REMOTE = r"""set -Eeuo pipefail
archive="$1"
key="$2"
importer="$3"
transfer="$4"
expected="$5"
stage="VALIDATE_HOST"

cleanup() {
  rm -f "$archive" "$key" "$importer" "$transfer"
}
trap 'printf "QF_FAILURE_STAGE=%s\n" "$stage" >&2' ERR
trap cleanup EXIT

test -s "$archive"
test -s "$key"
test -s "$importer"
test -s "$transfer"
test -f /etc/quizforge/database-initialized
test -f /etc/quizforge/postgres/owner-password
test -f /etc/quizforge/db-ca.pem
systemctl is-active --quiet quizforge.service

stage="RESOLVE_OPERATIONS_IMAGE"
compose=/opt/quizforge/current/compose.json
test -s "$compose"
ops_image="$(python3 - "$compose" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
image=value["services"]["operations"]["image"]
if not re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}", image):
    raise SystemExit(31)
print(image)
PY
)"

run_import() {
  operation="$1"
  docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1     --user 0:0     -e PRODUCTION_DATABASE_TARGET=lightsail     -e PGHOST=db.quizforge.internal     -e PGPORT=5432     -e PGDATABASE=quizforge     -e PGUSER=quizforge_owner     -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem     -v /etc/quizforge:/etc/quizforge:ro     -v "$archive:/run/migration/source.qfh:ro"     -v "$key:/run/migration/key:ro"     -v "$importer:/app/live_history_import.py:ro"     -v "$transfer:/rds_rehearsal/history_transfer.py:ro"     "$ops_image" sh -ec '
      export PGPASSWORD="$(cat /etc/quizforge/postgres/owner-password)"
      exec python /app/live_history_import.py "$@"
    ' sh "$operation"       --archive /run/migration/source.qfh       --key-file /run/migration/key       --expected-sha256 "$expected"
}

stage="DRY_RUN_IMPORT"
dry="$(run_import dry-run)"
stage="COMMIT_IMPORT"
commit="$(run_import commit)"
stage="VERIFY_IMPORT"
verify="$(run_import verify)"

python3 - "$dry" "$commit" "$verify" <<'PY'
import json,sys
dry,commit,verify=(json.loads(value) for value in sys.argv[1:])
if dry["operation"]!="dry-run" or commit["operation"]!="commit" or verify["operation"]!="verify":
    raise SystemExit(41)
for value in (dry,commit,verify):
    if value["sha256"]!=commit["sha256"] or value["users"]!=commit["users"] or value["rows"]!=commit["rows"]:
        raise SystemExit(42)
if any(verify[name] for name in ("inserted_users","inserted_identities","inserted_rows")):
    raise SystemExit(43)
print("QF_RESULT="+json.dumps({
  "source_users":commit["users"],
  "source_rows":commit["rows"],
  "inserted_users":commit["inserted_users"],
  "inserted_identities":commit["inserted_identities"],
  "inserted_rows":commit["inserted_rows"],
  "existing_exact_rows":commit["existing_exact_rows"],
  "target_users":commit["target_users"],
  "target_identities":commit["target_identities"],
  "target_rows":commit["target_rows"],
  "source_digest":commit["sha256"],
  "dry_run_passed":True,
  "commit_passed":True,
  "verify_passed":True,
},sort_keys=True))
PY
"""


def retry_command(command: list[str], *, attempts: int, timeout: int, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    last: subprocess.CompletedProcess[str] | None = None
    for attempt in range(attempts):
        completed = subprocess.run(
            command,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if completed.returncode == 0:
            return completed
        last = completed
        if completed.returncode != 255 or attempt + 1 == attempts:
            break
        time.sleep(5)
    assert last is not None
    raise subprocess.CalledProcessError(
        last.returncode,
        command,
        output=last.stdout,
        stderr=last.stderr,
    )


def remote_failure_stage(stderr: str | bytes | None) -> str | None:
    text = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr or "")
    matches = re.findall(r"^QF_FAILURE_STAGE=([A-Z0-9_]+)$", text, flags=re.MULTILINE)
    allowed = {"VALIDATE_HOST", "RESOLVE_OPERATIONS_IMAGE", "DRY_RUN_IMPORT", "COMMIT_IMPORT", "VERIFY_IMPORT"}
    return matches[-1] if matches and matches[-1] in allowed else None


def ssh_failure_code(stderr: str | bytes | None) -> str:
    text = (stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr or "")).lower()
    checks = (
        ("permission denied", "AUTH_REJECTED"),
        ("connection timed out", "CONNECT_TIMEOUT"),
        ("operation timed out", "CONNECT_TIMEOUT"),
        ("connection refused", "CONNECT_REFUSED"),
        ("no route to host", "NO_ROUTE"),
        ("host key verification failed", "HOST_KEY_REJECTED"),
        ("connection closed", "CONNECTION_CLOSED"),
        ("connection reset", "CONNECTION_RESET"),
        ("kex_exchange_identification", "KEX_REJECTED"),
        ("certificate", "CERTIFICATE_ERROR"),
    )
    for needle, code in checks:
        if needle in text:
            return code
    return "SSH_UNKNOWN"


def refresh_temp_access(lightsail, temp: Path, known: str, forbidden: list[str]) -> tuple[Path, Path, Path, str]:
    access = lightsail.get_instance_access_details(instanceName=INSTANCE_NAME, protocol="ssh")["accessDetails"]
    private_key, cert_key, username = access.get("privateKey"), access.get("certKey"), access.get("username")
    if not all(isinstance(value, str) and value for value in (private_key, cert_key, username)):
        raise ValueError("Temporary SSH access incomplete")
    forbidden.extend([private_key, cert_key])

    ssh_key, ssh_cert, hosts = temp/"ssh-key", temp/"ssh-cert.pub", temp/"known_hosts"
    ssh_key.write_text(private_key); ssh_key.chmod(0o600)
    ssh_cert.write_text(cert_key + ("" if cert_key.endswith("\n") else "\n")); ssh_cert.chmod(0o600)
    hosts.write_text(known); hosts.chmod(0o600)
    return ssh_key, ssh_cert, hosts, username


def ssh_key_only_command(key: Path, known: Path, username: str, ip: str, *remote: str) -> list[str]:
    return [
        "ssh","-i",str(key),
        "-o",f"UserKnownHostsFile={known}","-o","StrictHostKeyChecking=yes",
        "-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","ConnectTimeout=15",
        f"{username}@{ip}",*remote,
    ]


def scp_key_only_command(key: Path, known: Path, username: str, ip: str, source: Path, destination: str) -> list[str]:
    return [
        "scp","-q","-i",str(key),
        "-o",f"UserKnownHostsFile={known}","-o","StrictHostKeyChecking=yes",
        "-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","ConnectTimeout=15",
        str(source),f"{username}@{ip}:{destination}",
    ]


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


def source_snapshot() -> dict[str, Any]:
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
        raw = response.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError("Source snapshot exceeds bound")
    value = json.loads(raw)
    if value.get("issuer") != SOURCE_ISSUER:
        raise ValueError("Unexpected source issuer")
    validate(value)
    return value


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def write_report(report: dict[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for item in forbidden:
        if item and item in raw:
            raise ValueError("Private migration value reached summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP reached migration summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "supabase_history_to_lightsail",
        "result": "migration_failed",
        "source_writers_frozen": True,
        "encrypted_archive_retained_off_host": False,
        "separate_key_retained_off_host": False,
        "dry_run_passed": False,
        "commit_passed": False,
        "destination_verified": False,
        "source_unchanged_after_import": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "dns_changed": False,
        "application_changed": False,
        "ai_configuration_changed": False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    temp: Path | None = None
    remote_paths: list[str] = []
    try:
        if (
            os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"
            or os.environ.get("GITHUB_RUN_ATTEMPT") != "1"
        ):
            raise ValueError("Live migration requires first trusted main push")

        baseline = source_snapshot()
        manifest = validate(baseline)
        report["source_users"] = manifest["users"]
        report["source_rows"] = manifest["rows"]
        report["source_digest"] = manifest["sha256"]

        key = os.urandom(32)
        encrypted = seal(baseline, key)
        encrypted_sha = hashlib.sha256(encrypted).hexdigest()
        account = boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]
        if not re.fullmatch(r"[0-9]{12}", account):
            raise ValueError("AWS account invalid")
        forbidden.append(account)
        bucket = "quizforge-production-backups-" + account
        object_key = "migration/" + encrypted_sha + ".qfh"
        parameter = "/quizforge/migration/" + os.environ["GITHUB_RUN_ID"] + "/key"
        forbidden.extend([bucket, object_key, parameter, base64.b64encode(key).decode()])

        s3 = boto3.client("s3", region_name=REGION)
        if s3.get_bucket_versioning(Bucket=bucket).get("Status") != "Enabled":
            raise ValueError("Backup bucket versioning is not enabled")
        block = s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        if not all(block.get(name) for name in ("BlockPublicAcls","BlockPublicPolicy","IgnorePublicAcls","RestrictPublicBuckets")):
            raise ValueError("Backup bucket public access block incomplete")
        s3.put_object(
            Bucket=bucket,
            Key=object_key,
            Body=encrypted,
            ServerSideEncryption="AES256",
            ContentType="application/octet-stream",
            IfNoneMatch="*",
        )
        report["encrypted_archive_retained_off_host"] = True

        ssm = boto3.client("ssm", region_name=REGION)
        ssm.put_parameter(
            Name=parameter,
            Description="Quiz From Notes seven-day Supabase history migration rollback key",
            Value=base64.b64encode(key).decode(),
            Type="SecureString",
            Overwrite=False,
            Tier="Standard",
        )
        report["separate_key_retained_off_host"] = True

        temp = Path(tempfile.mkdtemp(prefix="quizfromnotes-live-migration-", dir=os.environ.get("RUNNER_TEMP")))
        temp.chmod(0o700)
        archive_path = temp / "source.qfh"
        key_path = temp / "key"
        importer_path = Path("scripts/production/live_history_import.py")
        transfer_path = Path("scripts/rds_rehearsal/history_transfer.py")
        archive_path.write_bytes(encrypted); archive_path.chmod(0o600)
        key_path.write_bytes(key); key_path.chmod(0o600)

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
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"] = True

        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        known = scan_host(ip, pins)
        ssh_key, ssh_cert, hosts, username = refresh_temp_access(lightsail, temp, known, forbidden)
        report["temporary_ssh_credentials_refreshed"] = False

        remote_base = "/tmp/quizfromnotes-migration-" + os.environ["GITHUB_RUN_ID"]
        remote_archive, remote_key = remote_base+".qfh", remote_base+".key"
        remote_importer, remote_transfer = remote_base+"-import.py", remote_base+"-transfer.py"
        remote_paths = [remote_archive, remote_key, remote_importer, remote_transfer]

        report["migration_stage"] = "SSH_READY"
        try:
            with socket.create_connection((ip, 22), timeout=10):
                report["ssh_tcp_reachable"] = True
        except OSError:
            report["ssh_tcp_reachable"] = False

        use_certificate = True
        try:
            retry_command(
                ssh_command(ssh_key, ssh_cert, hosts, username, ip, "true"),
                attempts=2,
                timeout=30,
            )
        except subprocess.CalledProcessError as error:
            if error.returncode != 255 or ssh_failure_code(error.stderr) != "AUTH_REJECTED":
                raise
            time.sleep(3)
            ssh_key, ssh_cert, hosts, username = refresh_temp_access(lightsail, temp, known, forbidden)
            report["temporary_ssh_credentials_refreshed"] = True
            try:
                retry_command(
                    ssh_command(ssh_key, ssh_cert, hosts, username, ip, "true"),
                    attempts=2,
                    timeout=30,
                )
            except subprocess.CalledProcessError as refreshed:
                if refreshed.returncode != 255 or ssh_failure_code(refreshed.stderr) != "AUTH_REJECTED":
                    raise
                retry_command(
                    ssh_key_only_command(ssh_key, hosts, username, ip, "true"),
                    attempts=6,
                    timeout=30,
                )
                use_certificate = False
                report["ssh_key_only_fallback"] = True

        for index, (local, remote) in enumerate((
            (archive_path, remote_archive),
            (key_path, remote_key),
            (importer_path, remote_importer),
            (transfer_path, remote_transfer),
        ), start=1):
            report["migration_stage"] = "SCP_" + str(index)
            command = (
                scp_command(ssh_key, ssh_cert, hosts, username, ip, local, remote)
                if use_certificate
                else scp_key_only_command(ssh_key, hosts, username, ip, local, remote)
            )
            retry_command(
                command,
                attempts=3,
                timeout=120,
            )

        report["migration_stage"] = "REMOTE_IMPORT"
        command = (
            ssh_command(
                ssh_key, ssh_cert, hosts, username, ip,
                "sudo","bash","-s","--",remote_archive,remote_key,remote_importer,remote_transfer,manifest["sha256"],
            )
            if use_certificate
            else ssh_key_only_command(
                ssh_key, hosts, username, ip,
                "sudo","bash","-s","--",remote_archive,remote_key,remote_importer,remote_transfer,manifest["sha256"],
            )
        )
        completed = retry_command(
            command,
            input_text=REMOTE,
            attempts=2,
            timeout=300,
        )
        values = [line.removeprefix("QF_RESULT=") for line in completed.stdout.splitlines() if line.startswith("QF_RESULT=")]
        if len(values) != 1:
            raise ValueError("Unexpected migration result")
        state = json.loads(values[0])
        if state.get("source_digest") != manifest["sha256"] or state.get("source_users") != manifest["users"] or state.get("source_rows") != manifest["rows"]:
            raise ValueError("Destination migration result mismatch")
        if not all(state.get(name) is True for name in ("dry_run_passed","commit_passed","verify_passed")):
            raise ValueError("Destination acceptance incomplete")
        report.update({
            "dry_run_passed": True,
            "commit_passed": True,
            "destination_verified": True,
            "inserted_users": state["inserted_users"],
            "inserted_identities": state["inserted_identities"],
            "inserted_rows": state["inserted_rows"],
            "existing_exact_rows": state["existing_exact_rows"],
            "target_users": state["target_users"],
            "target_identities": state["target_identities"],
            "target_rows": state["target_rows"],
        })

        after = source_snapshot()
        after_manifest = validate(after)
        if after_manifest != manifest or after != baseline:
            raise ValueError("Frozen Supabase source changed during migration")
        report["source_unchanged_after_import"] = True
        report["result"] = "supabase_history_migration_succeeded"
    except ClientError as error:
        report["error_code"] = safe_code(error.response.get("Error", {}).get("Code"), "AWS_MIGRATION_FAILED")
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_MIGRATION_FAILED"
        report["remote_return_code"] = error.returncode
        stage = remote_failure_stage(error.stderr)
        if stage is not None:
            report["remote_failure_stage"] = stage
        report["ssh_failure_code"] = ssh_failure_code(error.stderr)
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "MIGRATION_FAILED")
    finally:
        if lightsail is not None and runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
                )
                report["temporary_ssh_rule_closed"] = True
                after_ports = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
                report["baseline_firewall_restored"] = normalized_ports(after_ports) == baseline_ports(os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"])
            except Exception as error:
                report["cleanup_error_code"] = safe_code(type(error).__name__, "FIREWALL_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
        if report.get("result") == "supabase_history_migration_succeeded" and not report.get("baseline_firewall_restored"):
            report["result"] = "migration_succeeded_firewall_cleanup_unverified"
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "supabase_history_migration_succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
