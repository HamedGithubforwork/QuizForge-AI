"""Install the reviewed backup job on permanent Lightsail and run one real backup.

This one-time controller:
- requires the already-verified backup infrastructure,
- creates three tightly named IAM identities and attaches only the pre-existing
  uploader/recovery/health policies,
- creates one uploader key and one health-publisher key and stores encrypted
  recovery copies in SSM SecureString parameters,
- stores the 256-bit backup encryption key off-host in SSM and installs a copy
  through systemd LoadCredential,
- installs the reviewed backup code and units on the permanent host,
- keeps both recurring timers disabled,
- runs exactly one explicit backup and verifies its versioned S3 archive/receipt,
- verifies the receipt HMAC and a recent BackupFresh=1 metric,
- sends one clearly marked SNS delivery canary.

No application route, database row, Cognito resource, DNS record, model setting,
or recurring timer is changed.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import tempfile
import time
from typing import Any, Mapping

import boto3
from botocore.exceptions import ClientError

from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    normalized_ports,
    load_pins,
    scan_host,
    runner_ipv4,
    ssh_command,
    scp_command,
)

REGION = "ca-central-1"
RESULT = Path("lightsail-first-backup-results/summary.json")
UPLOADER_USER = "quizforge-production-backup-uploader"
HEALTH_USER = "quizforge-production-backup-health"
RECOVERY_USER = "quizforge-production-backup-recovery"
UPLOADER_POLICY = "quizforge-production-backup-upload"
HEALTH_POLICY = "quizforge-production-backup-health"
RECOVERY_POLICY = "quizforge-production-backup-recovery"
KEY_PARAM = "/quizforge/production/backup-key-v1"
UPLOADER_PARAM = "/quizforge/production/backup-uploader-credentials-v1"
HEALTH_PARAM = "/quizforge/production/backup-health-credentials-v1"

# Explicitly tracks a reviewed retry of the guarded one-shot backup runtime.
BACKUP_RUNTIME_RETRY_REVISION = 2

REMOTE_INSTALL_AND_RUN = r"""set -euo pipefail
archive="$1"
backup_key="$2"
uploader_json="$3"
health_json="$4"
bucket="$5"
account="$6"

case "$account" in *[!0-9]*|'') exit 31;; esac
test "$(printf %s "$account" | wc -c)" -eq 12
test "$bucket" = "quizforge-production-backups-$account"

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service
test -s /etc/quizforge/postgres/owner-password
test -s /etc/quizforge/db-ca.pem
test -s "$archive"
test -s "$backup_key"
test -s "$uploader_json"
test -s "$health_json"

if ! id -u quizforge-backup >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin quizforge-backup
fi
test "$(getent passwd quizforge-backup | cut -d: -f7)" = "/usr/sbin/nologin"

stage="$(mktemp -d /tmp/quizforge-backup-install.XXXXXX)"
trap 'rm -rf "$stage" "$archive" "$backup_key" "$uploader_json" "$health_json"' EXIT
tar -xzf "$archive" -C "$stage"

install -d -o root -g root -m 0755 /opt/quizforge/operations
install -m 0644 "$stage/operations/lightsail_backup.py" /opt/quizforge/operations/lightsail_backup.py
install -m 0644 "$stage/operations/lightsail_backup_job.py" /opt/quizforge/operations/lightsail_backup_job.py
install -m 0644 "$stage/requirements.lock" /opt/quizforge/operations/requirements.lock
install -m 0644 /etc/quizforge/db-ca.pem /opt/quizforge/operations/db-ca.pem

if ! /opt/quizforge/backup-venv/bin/python -m pip --version >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-venv >/dev/null
  rm -rf /opt/quizforge/backup-venv
  python3 -m venv /opt/quizforge/backup-venv
fi
/opt/quizforge/backup-venv/bin/python -m pip install --disable-pip-version-check --require-hashes -r /opt/quizforge/operations/requirements.lock >/dev/null
/opt/quizforge/backup-venv/bin/python -m pip check >/dev/null

install -m 0600 "$backup_key" /etc/quizforge/backup.key

python3 - "$uploader_json" "$health_json" "$bucket" "$account" <<'PY'
import json,os,sys
from pathlib import Path

uploader_path,health_path,bucket,account=sys.argv[1:5]
owner=Path("/etc/quizforge/postgres/owner-password").read_text(encoding="utf-8").strip()
assert owner and "\n" not in owner and "\r" not in owner

def credentials(path):
    value=json.loads(Path(path).read_text(encoding="utf-8"))
    assert set(value)=={"aws_access_key_id","aws_secret_access_key"}
    for item in value.values():
        assert isinstance(item,str) and item and "\n" not in item and "\r" not in item
    return value

def q(value):
    return '"' + value.replace("\\","\\\\").replace('"','\\"') + '"'

up=credentials(uploader_path)
health=credentials(health_path)
common={
    "AWS_REGION":"ca-central-1",
    "AWS_DEFAULT_REGION":"ca-central-1",
    "AWS_EC2_METADATA_DISABLED":"true",
}
backup={
    **common,
    "AWS_ACCESS_KEY_ID":up["aws_access_key_id"],
    "AWS_SECRET_ACCESS_KEY":up["aws_secret_access_key"],
    "BACKUP_BUCKET":bucket,
    "BACKUP_ACCOUNT":account,
    "PGHOST":"db.quizforge.internal",
    "PGHOSTADDR":"127.0.0.1",
    "PGDATABASE":"quizforge",
    "PGUSER":"quizforge_owner",
    "PGPASSWORD":owner,
    "PGPORT":"5432",
    "PGSSLROOTCERT":"/opt/quizforge/operations/db-ca.pem",
}
monitor={
    **common,
    "AWS_ACCESS_KEY_ID":health["aws_access_key_id"],
    "AWS_SECRET_ACCESS_KEY":health["aws_secret_access_key"],
}
for path,value in ((Path("/etc/quizforge/backup.env"),backup),(Path("/etc/quizforge/backup-health.env"),monitor)):
    text="".join(f"{key}={q(item)}\n" for key,item in value.items())
    path.write_text(text,encoding="utf-8")
    os.chmod(path,0o600)
PY

for unit in quizforge-backup.service quizforge-backup.timer quizforge-backup-health.service quizforge-backup-health.timer quizforge-backup-failure.service; do
  install -m 0644 "$stage/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl disable --now quizforge-backup.timer quizforge-backup-health.timer >/dev/null 2>&1 || true
! systemctl is-enabled --quiet quizforge-backup.timer
! systemctl is-enabled --quiet quizforge-backup-health.timer
! systemctl is-active --quiet quizforge-backup.timer
! systemctl is-active --quiet quizforge-backup-health.timer

systemctl reset-failed quizforge-backup.service >/dev/null 2>&1 || true
systemctl start quizforge-backup.service
test "$(systemctl show quizforge-backup.service -p Result --value)" = "success"
! systemctl is-failed --quiet quizforge-backup.service

python3 - <<'PY'
import json
from pathlib import Path
value=json.loads(Path("/var/lib/quizforge-backup/status.json").read_text())
assert value["format"]=="quizforge-backup-job-v1"
attempt=value["last_attempt"]; success=value["last_success"]
assert attempt["outcome"]=="succeeded"
receipt=success["receipt"]; payload=receipt["payload"]
assert payload["bucket"].startswith("quizforge-production-backups-")
result={
  "receipt_key":receipt["object_key"],
  "receipt_version":receipt["version_id"],
  "archive_key":payload["object_key"],
  "archive_version":payload["version_id"],
  "ciphertext_sha256":payload["ciphertext_sha256"],
  "content_sha256":payload["content_sha256"],
  "created_at":payload["created_at"],
  "backup_service_succeeded":True,
  "backup_timer_enabled":False,
  "health_timer_enabled":False,
}
print("QF_RESULT="+json.dumps(result,sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def aws_not_found(error: Exception, *codes: str) -> bool:
    response = getattr(error, "response", {})
    return isinstance(response, dict) and response.get("Error", {}).get("Code") in set(codes)


def get_parameter(ssm, name: str) -> str | None:
    try:
        return ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except ClientError as error:
        if aws_not_found(error, "ParameterNotFound"):
            return None
        raise


def put_secure_parameter(ssm, name: str, value: str) -> None:
    ssm.put_parameter(
        Name=name,
        Value=value,
        Type="SecureString",
        Tier="Standard",
        Overwrite=False,
        Tags=[
            {"Key": "Project", "Value": "QuizForge"},
            {"Key": "Purpose", "Value": "production-backup"},
        ],
    )


def ensure_backup_key(ssm) -> bytes:
    value = get_parameter(ssm, KEY_PARAM)
    if value is None:
        key = secrets.token_bytes(32)
        put_secure_parameter(ssm, KEY_PARAM, base64.b64encode(key).decode("ascii"))
        return key
    key = base64.b64decode(value, validate=True)
    if len(key) != 32:
        raise ValueError("Stored backup key is invalid")
    return key


def exact_attached_policies(iam, username: str) -> list[str]:
    values = []
    marker = None
    while True:
        request = {"UserName": username}
        if marker:
            request["Marker"] = marker
        response = iam.list_attached_user_policies(**request)
        values.extend(item["PolicyArn"] for item in response.get("AttachedPolicies", []))
        if not response.get("IsTruncated"):
            return values
        marker = response.get("Marker")
        if not marker:
            raise ValueError("IAM attachment pagination invalid")


def ensure_user(iam, account: str, username: str, policy_name: str) -> None:
    try:
        iam.get_user(UserName=username)
    except ClientError as error:
        if not aws_not_found(error, "NoSuchEntity"):
            raise
        iam.create_user(
            UserName=username,
            Tags=[
                {"Key": "Project", "Value": "QuizForge"},
                {"Key": "Purpose", "Value": "production-backup"},
            ],
        )
    policy_arn = f"arn:aws:iam::{account}:policy/{policy_name}"
    attached = exact_attached_policies(iam, username)
    if not attached:
        iam.attach_user_policy(UserName=username, PolicyArn=policy_arn)
        attached = exact_attached_policies(iam, username)
    if attached != [policy_arn]:
        raise ValueError("Backup IAM user has unexpected attached policies")
    inline = iam.list_user_policies(UserName=username)
    if inline.get("PolicyNames") or inline.get("IsTruncated"):
        raise ValueError("Backup IAM user has inline policies")
    groups = iam.list_groups_for_user(UserName=username)
    if groups.get("Groups") or groups.get("IsTruncated"):
        raise ValueError("Backup IAM user belongs to a group")


def ensure_access_key(iam, ssm, username: str, parameter: str) -> dict[str, str]:
    stored = get_parameter(ssm, parameter)
    metadata = iam.list_access_keys(UserName=username).get("AccessKeyMetadata", [])
    if stored is None:
        if metadata:
            raise ValueError("Untracked backup IAM access key exists")
        created = iam.create_access_key(UserName=username)["AccessKey"]
        value = {
            "aws_access_key_id": created["AccessKeyId"],
            "aws_secret_access_key": created["SecretAccessKey"],
        }
        try:
            put_secure_parameter(ssm, parameter, json.dumps(value, sort_keys=True))
        except Exception:
            try:
                iam.delete_access_key(UserName=username, AccessKeyId=created["AccessKeyId"])
            except Exception:
                pass
            raise
        metadata = iam.list_access_keys(UserName=username).get("AccessKeyMetadata", [])
    else:
        value = json.loads(stored)
    if set(value) != {"aws_access_key_id", "aws_secret_access_key"}:
        raise ValueError("Stored IAM credentials invalid")
    if len(metadata) != 1 or metadata[0].get("AccessKeyId") != value["aws_access_key_id"] or metadata[0].get("Status") != "Active":
        raise ValueError("Backup IAM access key state mismatch")
    if not re.fullmatch(r"AKIA[A-Z0-9]{16}", value["aws_access_key_id"]):
        raise ValueError("Backup access key id invalid")
    if not isinstance(value["aws_secret_access_key"], str) or len(value["aws_secret_access_key"]) < 30:
        raise ValueError("Backup secret key invalid")
    return value


def ensure_recovery_has_no_key(iam) -> None:
    keys = iam.list_access_keys(UserName=RECOVERY_USER).get("AccessKeyMetadata", [])
    if keys:
        raise ValueError("Recovery identity must not have a persistent access key on the host path")


def build_bundle(root: Path) -> Path:
    bundle = root / "backup-host-bundle.tar.gz"
    members = {
        "scripts/production/lightsail_backup.py": "operations/lightsail_backup.py",
        "scripts/production/lightsail_backup_job.py": "operations/lightsail_backup_job.py",
        "scripts/rds_rehearsal/requirements.lock": "requirements.lock",
        "scripts/production/systemd/quizforge-backup.service": "systemd/quizforge-backup.service",
        "scripts/production/systemd/quizforge-backup.timer": "systemd/quizforge-backup.timer",
        "scripts/production/systemd/quizforge-backup-health.service": "systemd/quizforge-backup-health.service",
        "scripts/production/systemd/quizforge-backup-health.timer": "systemd/quizforge-backup-health.timer",
        "scripts/production/systemd/quizforge-backup-failure.service": "systemd/quizforge-backup-failure.service",
    }
    with tarfile.open(bundle, "w:gz") as tar:
        for source, target in members.items():
            path = Path(source)
            if not path.is_file() or path.is_symlink():
                raise ValueError("Backup activation source file missing")
            tar.add(path, arcname=target, recursive=False)
    bundle.chmod(0o600)
    return bundle


def private_file(path: Path, raw: bytes) -> Path:
    with open(path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        handle.write(raw)
    return path


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("Private value reached first-backup summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP reached first-backup summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def recent_health_metric(cloudwatch) -> bool:
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=15)
    result = cloudwatch.get_metric_statistics(
        Namespace="QuizForge/Backup",
        MetricName="BackupFresh",
        Dimensions=[{"Name": "Deployment", "Value": "production-lightsail"}],
        StartTime=start,
        EndTime=end,
        Period=60,
        Statistics=["Minimum"],
    )
    return any(float(item.get("Minimum", 0)) >= 1 for item in result.get("Datapoints", []))


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_first_production_backup",
        "result": "first_backup_failed",
        "iam_identities_ready": False,
        "recovery_identity_has_no_access_key": False,
        "backup_key_retained_off_host": False,
        "host_backup_installed": False,
        "first_backup_succeeded": False,
        "archive_version_verified": False,
        "receipt_version_verified": False,
        "receipt_hmac_verified": False,
        "health_metric_published": False,
        "sns_delivery_canary_published": False,
        "backup_timer_enabled": False,
        "health_timer_enabled": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "production_routing_changes_performed": False,
        "ai_configuration_changed": False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    temp: Path | None = None
    remote_files: list[str] = []
    try:
        account = boto3.client("sts").get_caller_identity()["Account"]
        if not re.fullmatch(r"[0-9]{12}", account):
            raise ValueError("AWS account id invalid")
        forbidden.append(account)
        bucket = f"quizforge-production-backups-{account}"
        topic = f"arn:aws:sns:{REGION}:{account}:quizforge-production-backup-alerts"

        iam = boto3.client("iam")
        ssm = boto3.client("ssm", region_name=REGION)
        s3 = boto3.client("s3", region_name=REGION)
        cw = boto3.client("cloudwatch", region_name=REGION)
        sns = boto3.client("sns", region_name=REGION)

        if s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account).get("Status") != "Enabled":
            raise ValueError("Backup infrastructure is not ready")
        ensure_user(iam, account, UPLOADER_USER, UPLOADER_POLICY)
        ensure_user(iam, account, HEALTH_USER, HEALTH_POLICY)
        ensure_user(iam, account, RECOVERY_USER, RECOVERY_POLICY)
        uploader = ensure_access_key(iam, ssm, UPLOADER_USER, UPLOADER_PARAM)
        health = ensure_access_key(iam, ssm, HEALTH_USER, HEALTH_PARAM)
        ensure_recovery_has_no_key(iam)
        key = ensure_backup_key(ssm)
        report["iam_identities_ready"] = True
        report["recovery_identity_has_no_access_key"] = True
        report["backup_key_retained_off_host"] = True
        forbidden.extend([
            uploader["aws_access_key_id"],
            uploader["aws_secret_access_key"],
            health["aws_access_key_id"],
            health["aws_secret_access_key"],
            base64.b64encode(key).decode("ascii"),
        ])

        admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        lightsail = boto3.client("lightsail", region_name=REGION)
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
            raise ValueError("Permanent Lightsail instance mismatch")
        forbidden.extend([admin, ip])

        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if normalized_ports(before) != baseline_ports(admin):
            raise ValueError("Baseline firewall mismatch")

        runner = runner_ipv4()
        forbidden.append(runner)
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
        report["temporary_ssh_rule_opened"] = True
        known = scan_host(ip, pins)
        access = lightsail.get_instance_access_details(instanceName=INSTANCE_NAME, protocol="ssh")["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        if not all(isinstance(item, str) and item for item in (private_key, cert_key, username)):
            raise ValueError("Temporary SSH access incomplete")
        forbidden.extend([private_key, cert_key])

        temp = Path(tempfile.mkdtemp(prefix="quizforge-first-backup-"))
        temp.chmod(0o700)
        ssh_key = private_file(temp / "key", private_key.encode())
        ssh_cert = private_file(temp / "key-cert.pub", (cert_key + ("" if cert_key.endswith("\n") else "\n")).encode())
        known_hosts = private_file(temp / "known_hosts", known.encode())
        bundle = build_bundle(temp)
        backup_key_file = private_file(temp / "backup.key", key)
        uploader_file = private_file(temp / "uploader.json", json.dumps(uploader, sort_keys=True).encode())
        health_file = private_file(temp / "health.json", json.dumps(health, sort_keys=True).encode())

        run_id = os.environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[0-9]{1,20}", run_id):
            raise ValueError("GitHub run id invalid")
        destinations = {
            bundle: f"/tmp/qf-backup-{run_id}.tgz",
            backup_key_file: f"/tmp/qf-backup-{run_id}.key",
            uploader_file: f"/tmp/qf-backup-{run_id}.uploader.json",
            health_file: f"/tmp/qf-backup-{run_id}.health.json",
        }
        remote_files = list(destinations.values())
        for source, destination in destinations.items():
            subprocess.run(
                scp_command(ssh_key, ssh_cert, known_hosts, username, ip, source, destination),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                check=True,
            )

        completed = subprocess.run(
            ssh_command(
                ssh_key, ssh_cert, known_hosts, username, ip,
                "sudo", "bash", "-s", "--",
                destinations[bundle],
                destinations[backup_key_file],
                destinations[uploader_file],
                destinations[health_file],
                bucket,
                account,
            ),
            input=REMOTE_INSTALL_AND_RUN,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
            check=True,
        )
        values = [
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(values) != 1:
            raise ValueError("Unexpected first-backup host result")
        host = json.loads(values[0])
        for field in ("receipt_key", "receipt_version", "archive_key", "archive_version", "ciphertext_sha256", "content_sha256", "created_at"):
            if not isinstance(host.get(field), str) or not host[field]:
                raise ValueError("First-backup host metadata incomplete")
        if host.get("backup_service_succeeded") is not True or host.get("backup_timer_enabled") is not False or host.get("health_timer_enabled") is not False:
            raise ValueError("First-backup host state invalid")
        report["host_backup_installed"] = True
        report["first_backup_succeeded"] = True

        receipt_response = s3.get_object(
            Bucket=bucket,
            Key=host["receipt_key"],
            VersionId=host["receipt_version"],
            ExpectedBucketOwner=account,
        )
        try:
            receipt_raw = receipt_response["Body"].read(8193)
        finally:
            receipt_response["Body"].close()
        if len(receipt_raw) > 8192 or receipt_response.get("VersionId") != host["receipt_version"]:
            raise ValueError("Retained receipt mismatch")
        report["receipt_version_verified"] = True

        sys_path = str(Path("scripts/production").resolve())
        if sys_path not in os.sys.path:
            os.sys.path.insert(0, sys_path)
        import lightsail_backup_job as backup_job
        verified = backup_job.verify_receipt(receipt_raw, key, bucket, account)
        if (
            verified["object_key"] != host["archive_key"]
            or verified["version_id"] != host["archive_version"]
            or verified["ciphertext_sha256"] != host["ciphertext_sha256"]
            or verified["content_sha256"] != host["content_sha256"]
            or verified["created_at"] != host["created_at"]
        ):
            raise ValueError("Receipt does not match host backup metadata")
        report["receipt_hmac_verified"] = True

        archive_head = s3.head_object(
            Bucket=bucket,
            Key=host["archive_key"],
            VersionId=host["archive_version"],
            ExpectedBucketOwner=account,
        )
        if archive_head.get("VersionId") != host["archive_version"] or archive_head.get("ServerSideEncryption") != "AES256":
            raise ValueError("Retained archive mismatch")
        report["archive_version_verified"] = True

        deadline = time.time() + 90
        while time.time() < deadline and not recent_health_metric(cw):
            time.sleep(5)
        report["health_metric_published"] = recent_health_metric(cw)
        if not report["health_metric_published"]:
            raise ValueError("Backup health metric was not observed")

        marker = f"QuizForge first-backup alert delivery canary run {run_id}"
        sns.publish(
            TopicArn=topic,
            Subject="QuizForge backup alert delivery canary",
            Message=marker,
        )
        report["sns_delivery_canary_published"] = True
        report["delivery_marker"] = marker

        alarm = cw.describe_alarms(
            AlarmNames=["quizforge-production-backup-unhealthy"],
            AlarmTypes=["MetricAlarm"],
        ).get("MetricAlarms", [])
        report["alarm_state_after_backup"] = alarm[0].get("StateValue") if len(alarm) == 1 else "UNKNOWN"
        report["result"] = "first_production_backup_stored_timers_still_disabled"
    except ClientError as error:
        report["error_code"] = safe_code(error.response.get("Error", {}).get("Code"), "AWS_FIRST_BACKUP_FAILED")
    except subprocess.CalledProcessError as error:
        report["error_code"] = "HOST_FIRST_BACKUP_FAILED"
        report["remote_return_code"] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = "FIRST_BACKUP_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_FIRST_BACKUP_FAILED")
    finally:
        if lightsail is not None and runner:
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
                report["temporary_ssh_rule_closed"] = True
                after = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
                report["baseline_firewall_restored"] = normalized_ports(after) == baseline_ports(os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"])
            except Exception as error:
                report["cleanup_error_code"] = safe_code(type(error).__name__, "PRIVATE_FIREWALL_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
        if report.get("result") == "first_production_backup_stored_timers_still_disabled" and not report.get("baseline_firewall_restored"):
            report["result"] = "first_backup_firewall_cleanup_unverified"
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "first_production_backup_stored_timers_still_disabled" else 1


if __name__ == "__main__":
    raise SystemExit(main())
