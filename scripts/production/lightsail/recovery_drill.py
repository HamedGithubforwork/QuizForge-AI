"""Real off-host recovery drill using the latest permanent production backup.

The controller keeps production untouched. It reads the independently retained
backup key and the newest authenticated receipt, downloads only the encrypted
archive to the GitHub runner, then restores it on one temporary Canadian
Lightsail host. The temporary host uses the existing capacity-lab deletion
schedule and is deleted even when the drill fails.

Plaintext application data is decrypted only on the temporary AWS host.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Any, Mapping
from urllib.request import urlopen

import boto3
from botocore.exceptions import ClientError

PRODUCTION_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PRODUCTION_DIR))
from scripts.production import lightsail_backup as backup  # noqa: E402
from scripts.production import lightsail_backup_job as backup_job  # noqa: E402

CAPACITY_DIR = Path(__file__).resolve().parents[2] / "lightsail_test"
sys.path.insert(0, str(CAPACITY_DIR))
import control as capacity  # noqa: E402
import policy as capacity_policy  # noqa: E402

REGION = "ca-central-1"
KEY_PARAM = "/quizforge/production/backup-key-v1"
RESULT = Path("lightsail-recovery-drill/summary.json")
REMOTE = Path("scripts/production/lightsail/recovery_drill_remote.sh")


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def recovery_session_policy(account: str, ident: str) -> dict[str, Any]:
    """Reuse the reviewed temporary-host boundary and add read-only recovery data."""
    value = capacity_policy.session_policy(account, "run", ident)
    bucket = f"quizforge-production-backups-{account}"
    value["Statement"].extend([
        {
            "Effect": "Allow",
            "Action": ["s3:GetBucketVersioning"],
            "Resource": f"arn:aws:s3:::{bucket}",
        },
        {
            "Effect": "Allow",
            "Action": ["s3:ListBucketVersions"],
            "Resource": f"arn:aws:s3:::{bucket}",
            "Condition": {"StringLike": {"s3:prefix": "receipts/*"}},
        },
        {
            "Effect": "Allow",
            "Action": ["s3:GetObjectVersion"],
            "Resource": [
                f"arn:aws:s3:::{bucket}/receipts/*",
                f"arn:aws:s3:::{bucket}/lightsail/*",
            ],
        },
        {
            "Effect": "Allow",
            "Action": ["ssm:GetParameter"],
            "Resource": f"arn:aws:ssm:{REGION}:{account}:parameter{KEY_PARAM}",
        },
    ])
    return value


def latest_receipt_version(s3, bucket: str, account: str) -> tuple[str, str]:
    """Select the newest current receipt version; never fall back past a bad newest point."""
    candidates: list[tuple[datetime, str, str]] = []
    paginator = s3.get_paginator("list_object_versions")
    for page in paginator.paginate(
        Bucket=bucket,
        Prefix="receipts/",
        ExpectedBucketOwner=account,
        PaginationConfig={"PageSize": 1000},
    ):
        for item in page.get("Versions", []):
            key = item.get("Key")
            version = item.get("VersionId")
            modified = item.get("LastModified")
            if (
                item.get("IsLatest") is True
                and isinstance(key, str)
                and re.fullmatch(r"receipts/[a-f0-9]{64}\.json", key)
                and isinstance(version, str)
                and version
                and version != "null"
                and isinstance(modified, datetime)
            ):
                candidates.append((modified, key, version))
    if not candidates:
        raise ValueError("No current authenticated recovery receipt exists")
    _, key, version = max(candidates, key=lambda item: item[0])
    return key, version


def recovery_material(s3, ssm, account: str) -> tuple[bytes, bytes, dict[str, Any], list[str]]:
    bucket = f"quizforge-production-backups-{account}"
    if s3.get_bucket_versioning(Bucket=bucket, ExpectedBucketOwner=account).get("Status") != "Enabled":
        raise ValueError("Recovery bucket versioning is not enabled")

    encoded = ssm.get_parameter(Name=KEY_PARAM, WithDecryption=True)["Parameter"]["Value"]
    key = base64.b64decode(encoded, validate=True)
    if len(key) != 32:
        raise ValueError("Retained backup key is invalid")

    receipt_key, receipt_version = latest_receipt_version(s3, bucket, account)
    response = s3.get_object(
        Bucket=bucket,
        Key=receipt_key,
        VersionId=receipt_version,
        ExpectedBucketOwner=account,
    )
    body = response["Body"]
    try:
        if response.get("VersionId") != receipt_version or response.get("ContentLength", 0) > backup_job.MAX_METADATA:
            raise ValueError("Receipt version or size mismatch")
        raw = body.read(backup_job.MAX_METADATA + 1)
    finally:
        body.close()
    receipt = backup_job.verify_receipt(raw, key, bucket, account)
    if receipt["ciphertext_sha256"] not in receipt_key:
        raise ValueError("Receipt content address mismatch")

    archive = backup.download_archive(
        s3,
        bucket,
        account,
        receipt["object_key"],
        receipt["version_id"],
    )
    if hashlib.sha256(archive).hexdigest() != receipt["ciphertext_sha256"]:
        raise ValueError("Encrypted archive digest mismatch")

    private = [
        account,
        encoded,
        receipt_key,
        receipt_version,
        receipt["object_key"],
        receipt["version_id"],
    ]
    return key, archive, receipt, private


def build_bundle(root: Path) -> Path:
    bundle = root / "recovery-bundle.tar.gz"
    members = {
        "scripts/production/lightsail_backup.py": "lightsail_backup.py",
        "scripts/production/schema.sql": "schema.sql",
        "scripts/production/generation_budget.sql": "generation_budget.sql",
        "scripts/rds_rehearsal/requirements.lock": "requirements.lock",
    }
    with tarfile.open(bundle, "w:gz") as tar:
        for source, target in members.items():
            path = Path(source)
            if not path.is_file() or path.is_symlink():
                raise ValueError("Recovery source file missing")
            tar.add(path, arcname=target, recursive=False)
    bundle.chmod(0o600)
    return bundle


def private_file(path: Path, raw: bytes) -> Path:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(raw)
    return path


def postgres_image() -> str:
    lock = json.loads(Path("scripts/production/lightsail/release-lock.json").read_text(encoding="utf-8"))
    digest = lock.get("image_digests", {}).get("postgres")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("Reviewed PostgreSQL image digest missing")
    return "docker.io/library/postgres@" + digest


def wait_bootstrap(ls, instance, pinned_host_key: str) -> None:
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        with capacity.ssh_connection(ls, instance, pinned_host_key) as (options, target):
            result = subprocess.run(
                ["ssh", *options, target, "test -f /var/lib/quizforge-capacity-ready"],
                capture_output=True,
                timeout=25,
            )
        if result.returncode == 0:
            return
        time.sleep(5)
    raise RuntimeError("Temporary recovery host bootstrap deadline exceeded")


def transfer_and_restore(
    ls,
    instance,
    pinned_host_key: str,
    root: Path,
    archive: bytes,
    key: bytes,
    expected_content_sha256: str,
) -> dict[str, Any]:
    archive_path = private_file(root / "recovery.qflb", archive)
    key_path = private_file(root / "backup.key", key)
    bundle = build_bundle(root)
    image = postgres_image()

    with capacity.ssh_connection(ls, instance, pinned_host_key) as (options, target):
        subprocess.run(
            [
                "scp",
                *options,
                str(archive_path),
                str(key_path),
                str(bundle),
                target + ":/home/ubuntu/",
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
    with capacity.ssh_connection(ls, instance, pinned_host_key) as (options, target):
        completed = subprocess.run(
            [
                "ssh",
                *options,
                target,
                "sudo",
                "bash",
                "-s",
                "--",
                "/home/ubuntu/recovery.qflb",
                "/home/ubuntu/backup.key",
                "/home/ubuntu/recovery-bundle.tar.gz",
                image,
                expected_content_sha256,
            ],
            stdin=REMOTE.open("rb"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1200,
            check=True,
        )
    values = [
        line.removeprefix("QF_RESULT=")
        for line in completed.stdout.decode("utf-8", "strict").splitlines()
        if line.startswith("QF_RESULT=")
    ]
    if len(values) != 1:
        raise ValueError("Unexpected recovery-host result")
    value = json.loads(values[0])
    required = {
        "archive_decrypted",
        "target_schema_matched",
        "dry_run_reconciled",
        "committed_restore_reconciled",
        "model_spending_disabled",
        "identity_challenges_invalidated",
        "production_services_touched",
    }
    if set(value) != required or not all(value[name] is True for name in required - {"production_services_touched"}):
        raise ValueError("Recovery acceptance is incomplete")
    if value["production_services_touched"] is not False:
        raise ValueError("Recovery drill touched production services")
    return value


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("Private recovery material reached summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("Private infrastructure identifier reached summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def run() -> int:
    if (
        os.environ.get("GITHUB_EVENT_NAME") != "push"
        or os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("GITHUB_RUN_ATTEMPT") != "1"
        or os.environ.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"
    ):
        raise ValueError("Live recovery drill requires the first trusted main-branch push")

    report: dict[str, Any] = {
        "schema": 1,
        "operation": "production_backup_recovery_drill",
        "result": "recovery_failed",
        "latest_receipt_found": False,
        "retained_key_recovered": False,
        "receipt_authenticated": False,
        "archive_exact_version_verified": False,
        "temporary_cleanup_schedule_armed": False,
        "temporary_recovery_host_created": False,
        "restore_target_fresh_bootstrap": False,
        "archive_decrypted": False,
        "target_schema_matched": False,
        "dry_run_reconciled": False,
        "committed_restore_reconciled": False,
        "model_spending_disabled": False,
        "identity_challenges_invalidated": False,
        "temporary_recovery_host_deleted": False,
        "production_services_touched": False,
        "production_dns_changed": False,
        "production_backup_mutated": False,
        "ai_configuration_changed": False,
    }
    forbidden: list[str] = []
    ls = None
    instance_name = None
    temp: Path | None = None
    created = False

    try:
        account = boto3.client("sts", config=capacity.CONFIG).get_caller_identity()["Account"]
        capacity_policy.account_id(account)
        forbidden.append(account)
        ident = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
        instance_name = capacity_policy.test_name(ident)

        clients = (
            boto3.client("lightsail", region_name=REGION, config=capacity.CONFIG),
            boto3.client("scheduler", region_name=REGION, config=capacity.CONFIG),
            boto3.client("iam", config=capacity.CONFIG),
            boto3.client("freetier", region_name="us-east-1", config=capacity.CONFIG),
        )
        ls, scheduler, _, _ = clients
        inspected = capacity.preflight(clients, account)

        s3 = boto3.client("s3", region_name=REGION, config=capacity.CONFIG)
        ssm = boto3.client("ssm", region_name=REGION, config=capacity.CONFIG)
        key, archive, receipt, more_private = recovery_material(s3, ssm, account)
        forbidden.extend(more_private)
        report.update({
            "latest_receipt_found": True,
            "retained_key_recovered": True,
            "receipt_authenticated": True,
            "archive_exact_version_verified": True,
        })

        with urlopen("https://checkip.amazonaws.com", timeout=10) as response:
            runner_ip = str(ipaddress.IPv4Address(response.read(64).decode().strip()))
        forbidden.append(runner_ip)

        started = datetime.now(timezone.utc)
        deadline = started + timedelta(seconds=capacity_policy.TTL_SECONDS)
        capacity.arm(scheduler, instance_name, account, deadline)
        report["temporary_cleanup_schedule_armed"] = True

        user_data, pinned_host_key = capacity.host_bootstrap()
        ls.create_instances(
            instanceNames=[instance_name],
            availabilityZone=inspected["checks"]["availability_zone"],
            blueprintId=capacity_policy.BLUEPRINT,
            bundleId=capacity_policy.BUNDLE,
            ipAddressType="ipv4",
            addOns=[],
            tags=[
                {"key": "Purpose", "value": capacity_policy.PURPOSE},
                {"key": "TestId", "value": ident},
                {"key": "DeleteAfter", "value": deadline.isoformat()},
            ],
            userData=user_data,
        )
        created = True
        report["temporary_recovery_host_created"] = True
        instance = capacity.wait_running(ls, instance_name)
        public_ip = instance.get("publicIpAddress")
        if isinstance(public_ip, str):
            forbidden.append(public_ip)

        port = {
            "fromPort": 22,
            "toPort": 22,
            "protocol": "tcp",
            "cidrs": [runner_ip + "/32"],
            "ipv6Cidrs": [],
        }
        ls.put_instance_public_ports(instanceName=instance_name, portInfos=[port])
        states = ls.get_instance_port_states(instanceName=instance_name).get("portStates", [])
        opened = [item for item in states if item.get("state") == "open"]
        if len(opened) != 1 or opened[0].get("fromPort") != 22 or opened[0].get("toPort") != 22:
            raise ValueError("Temporary recovery firewall differs from SSH-only contract")

        wait_bootstrap(ls, instance, pinned_host_key)
        temp = Path(tempfile.mkdtemp(prefix="quizforge-recovery-drill-", dir=os.environ.get("RUNNER_TEMP")))
        temp.chmod(0o700)
        state = transfer_and_restore(
            ls,
            instance,
            pinned_host_key,
            temp,
            archive,
            key,
            receipt["content_sha256"],
        )
        report["restore_target_fresh_bootstrap"] = True
        report.update(state)
        report["result"] = "recovery_succeeded"
    except ClientError as error:
        report["error_code"] = safe_code(error.response.get("Error", {}).get("Code"), "AWS_RECOVERY_DRILL_FAILED")
    except subprocess.CalledProcessError:
        report["error_code"] = "REMOTE_RECOVERY_DRILL_FAILED"
    except subprocess.TimeoutExpired:
        report["error_code"] = "RECOVERY_DRILL_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "RECOVERY_DRILL_FAILED")
    finally:
        if temp is not None:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
        if ls is not None and instance_name:
            try:
                cleanup = capacity.cleanup_instance(ls, instance_name)
                report["temporary_recovery_host_deleted"] = cleanup.get("instance_absent") is True
            except Exception as error:
                report["cleanup_error_code"] = safe_code(type(error).__name__, "RECOVERY_CLEANUP_FAILED")
        if created and not report["temporary_recovery_host_deleted"]:
            report["result"] = "recovery_succeeded_cleanup_unverified" if report["result"] == "recovery_succeeded" else report["result"]
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report["result"] == "recovery_succeeded" and report["temporary_recovery_host_deleted"] else 1


def emit_policy() -> int:
    account = os.environ["RECOVERY_ACCOUNT_ID"]
    ident = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    value = json.dumps(recovery_session_policy(account, ident), separators=(",", ":"))
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write("json=" + value + "\n")
    else:
        print(value)
    return 0


def main() -> int:
    operation = sys.argv[1] if len(sys.argv) > 1 else "run"
    if operation == "policy":
        return emit_policy()
    if operation == "run":
        return run()
    raise ValueError("Unsupported recovery-drill operation")


if __name__ == "__main__":
    raise SystemExit(main())
