"""Read-only readiness check for deploying QuizForge onto the permanent Lightsail host.

This script may request temporary Lightsail SSH access details, but it never prints
or publishes the instance IP, SSH private key, certificate, or host key material.
It performs only read-only AWS calls and read-only SSH commands.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping

try:
    import boto3
    from botocore.exceptions import ClientError
except ModuleNotFoundError:  # Unit tests run without AWS SDK.
    boto3 = None

    class ClientError(Exception):
        response: dict[str, Any] = {}

REGION = "ca-central-1"
INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"
ECR_REPOSITORY = "quizforge-api"
RESULT = Path("lightsail-app-deploy-readiness/summary.json")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9._+~-]{1,80}$")

REMOTE_SCRIPT = r"""set -eu
python3 - <<'PY'
import json, os, re, shutil, subprocess

def run(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def mode(path):
    try:
        return oct(os.stat(path).st_mode & 0o777)
    except OSError:
        return ""

def command_text(*args):
    result = run(*args)
    return result.stdout.strip() if result.returncode == 0 else ""

os_release = {}
try:
    with open("/etc/os-release", encoding="utf-8") as handle:
        for line in handle:
            if "=" in line:
                key, value = line.rstrip().split("=", 1)
                os_release[key] = value.strip('"')
except OSError:
    pass

docker_server = command_text("sudo", "-n", "docker", "version", "--format", "{{.Server.Version}}")
compose = command_text("docker", "compose", "version", "--short")
if not compose:
    compose = command_text("sudo", "-n", "docker", "compose", "version", "--short")

sshd = command_text("sudo", "-n", "/usr/sbin/sshd", "-T")
settings = {}
for line in sshd.splitlines():
    parts = line.split(None, 1)
    if len(parts) == 2:
        settings[parts[0].lower()] = parts[1].strip().lower()

try:
    stat = os.statvfs("/")
    free_gib = int((stat.f_bavail * stat.f_frsize) / (1024**3))
    total_gib = int((stat.f_blocks * stat.f_frsize) / (1024**3))
except OSError:
    free_gib = -1
    total_gib = -1

swap = command_text("swapon", "--noheadings")
cgroup = command_text("stat", "-fc", "%T", "/sys/fs/cgroup")
docker_active = run("systemctl", "is-active", "--quiet", "docker").returncode == 0
quizforge_active = run("systemctl", "is-active", "--quiet", "quizforge.service").returncode == 0

result = {
    "base_host_ready": os.path.isfile("/var/lib/quizforge/base-host-ready"),
    "ubuntu_24_04": os_release.get("ID") == "ubuntu" and os_release.get("VERSION_ID") == "24.04",
    "sudo_noninteractive": run("sudo", "-n", "true").returncode == 0,
    "docker_active": docker_active,
    "docker_server_version": docker_server,
    "compose_version": compose,
    "cgroup_v2": cgroup == "cgroup2fs",
    "swap_disabled": swap == "",
    "etc_quizforge_mode_0700": mode("/etc/quizforge") == "0o700",
    "var_lib_quizforge_mode_0700": mode("/var/lib/quizforge") == "0o700",
    "current_release_present": os.path.lexists("/opt/quizforge/current"),
    "launch_marker_present": os.path.exists("/etc/quizforge/launch-approved"),
    "quizforge_service_active": quizforge_active,
    "quizforge_service_file_present": os.path.exists("/etc/systemd/system/quizforge.service"),
    "disk_free_gib": free_gib,
    "disk_total_gib": total_gib,
    "ssh_password_auth_disabled": settings.get("passwordauthentication") == "no",
    "ssh_root_login_disabled": settings.get("permitrootlogin") == "no",
    "ssh_tcp_forwarding_disabled": settings.get("allowtcpforwarding") == "no",
}
print(json.dumps(result, sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:-]{1,100}", text) else fallback


def private_values(access: Mapping[str, Any]) -> list[str]:
    values = []
    for key in ("privateKey", "certKey", "ipAddress"):
        value = access.get(key)
        if isinstance(value, str) and value:
            values.append(value)
    for item in access.get("hostKeys") or []:
        if isinstance(item, Mapping):
            value = item.get("publicKey")
            if isinstance(value, str) and value:
                values.append(value)
    return values


def access_shape(access: Mapping[str, Any]) -> dict[str, Any]:
    host_keys = access.get("hostKeys") or []
    algorithms = []
    prefixed = 0
    for item in host_keys:
        if not isinstance(item, Mapping):
            continue
        algorithm = item.get("algorithm")
        public = item.get("publicKey")
        if (
            isinstance(algorithm, str)
            and re.fullmatch(r"[A-Za-z0-9@._+-]{3,80}", algorithm)
        ):
            algorithms.append(algorithm)
            if isinstance(public, str) and public.startswith(algorithm + " "):
                prefixed += 1
    protocol = access.get("protocol")
    return {
        "has_private_key": isinstance(access.get("privateKey"), str)
        and bool(access.get("privateKey")),
        "has_cert_key": isinstance(access.get("certKey"), str)
        and bool(access.get("certKey")),
        "has_username": isinstance(access.get("username"), str)
        and bool(access.get("username")),
        "has_ip_address": isinstance(access.get("ipAddress"), str)
        and bool(access.get("ipAddress")),
        "protocol": protocol if protocol in {"ssh", "rdp"} else "unknown",
        "host_key_count": len(host_keys) if isinstance(host_keys, list) else 0,
        "host_key_algorithms": sorted(set(algorithms)),
        "host_key_public_prefixed_count": prefixed,
    }


def known_hosts_text(access: Mapping[str, Any]) -> str:
    ip = access.get("ipAddress")
    if not isinstance(ip, str) or not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", ip):
        raise ValueError("Missing instance IP")
    lines = []
    for item in access.get("hostKeys") or []:
        if not isinstance(item, Mapping):
            continue
        algorithm = item.get("algorithm")
        public = item.get("publicKey")
        if (
            isinstance(algorithm, str)
            and re.fullmatch(r"[A-Za-z0-9@._+-]{3,80}", algorithm)
            and isinstance(public, str)
            and public.startswith(algorithm + " ")
        ):
            lines.append(f"{ip} {public}")
    if not lines:
        raise ValueError("No trusted host keys returned by Lightsail")
    return "\n".join(lines) + "\n"


def validate_remote(remote: Mapping[str, Any]) -> dict[str, Any]:
    bool_fields = (
        "base_host_ready",
        "ubuntu_24_04",
        "sudo_noninteractive",
        "docker_active",
        "cgroup_v2",
        "swap_disabled",
        "etc_quizforge_mode_0700",
        "var_lib_quizforge_mode_0700",
        "current_release_present",
        "launch_marker_present",
        "quizforge_service_active",
        "quizforge_service_file_present",
        "ssh_password_auth_disabled",
        "ssh_root_login_disabled",
        "ssh_tcp_forwarding_disabled",
    )
    result: dict[str, Any] = {}
    for field in bool_fields:
        if type(remote.get(field)) is not bool:
            raise ValueError("Invalid remote boolean")
        result[field] = remote[field]
    for field in ("docker_server_version", "compose_version"):
        value = remote.get(field)
        if not isinstance(value, str) or (value and not SAFE_VERSION.fullmatch(value)):
            raise ValueError("Invalid version output")
        result[field] = value
    for field in ("disk_free_gib", "disk_total_gib"):
        value = remote.get(field)
        if type(value) is not int or not -1 <= value <= 10_000:
            raise ValueError("Invalid disk output")
        result[field] = value
    return result


def version_tuple(value: str) -> tuple[int, ...]:
    match = re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?", value)
    if not match:
        return ()
    return tuple(int(part or 0) for part in match.groups())


def deploy_prerequisites(remote: Mapping[str, Any], ecr_exists: bool) -> dict[str, Any]:
    compose_ok = version_tuple(str(remote.get("compose_version", ""))) >= (2, 30, 0)
    host_ok = all(
        remote.get(field) is True
        for field in (
            "base_host_ready",
            "ubuntu_24_04",
            "sudo_noninteractive",
            "docker_active",
            "cgroup_v2",
            "swap_disabled",
            "etc_quizforge_mode_0700",
            "var_lib_quizforge_mode_0700",
            "ssh_password_auth_disabled",
            "ssh_root_login_disabled",
            "ssh_tcp_forwarding_disabled",
        )
    )
    clean = (
        remote.get("current_release_present") is False
        and remote.get("launch_marker_present") is False
        and remote.get("quizforge_service_active") is False
    )
    disk_ok = type(remote.get("disk_free_gib")) is int and remote["disk_free_gib"] >= 20
    return {
        "host_base_contract_ok": host_ok,
        "compose_2_30_or_newer": compose_ok,
        "fresh_application_host": clean,
        "disk_capacity_ok": disk_ok,
        "ecr_repository_exists": ecr_exists,
        "ready_for_release_staging": host_ok and compose_ok and clean and disk_ok and ecr_exists,
    }


def write_report(report: Mapping[str, Any], forbidden: list[str] | None = None) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden or []:
        if value and value in raw:
            raise ValueError("Sensitive access detail reached public summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def ssh_probe(access: Mapping[str, Any]) -> dict[str, Any]:
    temp = Path(os.environ["RUNNER_TEMP"]) / "quizforge-host-readiness"
    temp.mkdir(mode=0o700, exist_ok=False)
    key = temp / "tempkey"
    cert = temp / "tempkey-cert.pub"
    known = temp / "known_hosts"
    private_key = access.get("privateKey")
    cert_key = access.get("certKey")
    username = access.get("username")
    ip = access.get("ipAddress")
    if not all(isinstance(value, str) and value for value in (private_key, cert_key, username, ip)):
        raise ValueError("Incomplete SSH access details")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", username):
        raise ValueError("Unexpected SSH username")
    key.write_text(private_key, encoding="utf-8")
    key.chmod(0o600)
    cert.write_text(cert_key + ("\n" if not cert_key.endswith("\n") else ""), encoding="utf-8")
    cert.chmod(0o600)
    known.write_text(known_hosts_text(access), encoding="utf-8")
    known.chmod(0o600)
    try:
        command = [
            "ssh",
            "-i",
            str(key),
            "-o",
            f"CertificateFile={cert}",
            "-o",
            f"UserKnownHostsFile={known}",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            f"{username}@{ip}",
            "bash",
            "-s",
        ]
        completed = subprocess.run(
            command,
            input=REMOTE_SCRIPT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=45,
            check=True,
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if len(lines) != 1:
            raise ValueError("Unexpected remote output")
        return validate_remote(json.loads(lines[0]))
    finally:
        for path in (key, cert, known):
            path.unlink(missing_ok=True)
        try:
            temp.rmdir()
        except OSError:
            pass


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_application_deploy_readiness",
        "result": "readiness_failed_no_changes",
        "changes_performed": False,
    }
    access: Mapping[str, Any] = {}
    stage = "startup"
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        stage = "aws_identity"
        sts = boto3.client("sts", region_name=REGION)
        caller = sts.get_caller_identity()
        report["aws_identity_verified"] = bool(caller.get("Account"))

        stage = "lightsail_instance_contract"
        lightsail = boto3.client("lightsail", region_name=REGION)
        instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        report["instance_contract"] = {
            "exists": True,
            "blueprint_expected": instance.get("blueprintId") == "ubuntu_24_04",
            "bundle_expected": instance.get("bundleId") == "small_3_0",
            "availability_zone_expected": (
                instance.get("location", {}).get("availabilityZone") == "ca-central-1a"
            ),
            "static_ip_attached": static.get("attachedTo") == INSTANCE_NAME,
            "instance_reports_static_ip": instance.get("isStaticIp") is True,
        }

        stage = "ecr_repository"
        ecr = boto3.client("ecr", region_name=REGION)
        try:
            response = ecr.describe_repositories(repositoryNames=[ECR_REPOSITORY])
            ecr_exists = len(response.get("repositories") or []) == 1
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code == "RepositoryNotFoundException":
                ecr_exists = False
            else:
                raise

        stage = "lightsail_access_details"
        access = lightsail.get_instance_access_details(
            instanceName=INSTANCE_NAME,
            protocol="ssh",
        )["accessDetails"]
        report["access_shape"] = access_shape(access)
        stage = "ssh_probe"
        remote = ssh_probe(access)
        stage = "evaluate_prerequisites"
        report["host"] = remote
        report["prerequisites"] = deploy_prerequisites(remote, ecr_exists)
        report["result"] = (
            "ready_for_release_staging_no_changes"
            if report["prerequisites"]["ready_for_release_staging"]
            else "prerequisites_incomplete_no_changes"
        )
        write_report(report, private_values(access))
        return 0
    except ClientError as error:
        report["diagnostic_stage"] = stage
        report["error_code"] = "AWS_READ_FAILED"
        report["aws_error_code"] = safe_code(
            error.response.get("Error", {}).get("Code"),
            "UNKNOWN_AWS_ERROR",
        )
    except subprocess.CalledProcessError:
        report["diagnostic_stage"] = stage
        report["error_code"] = "SSH_PROBE_FAILED"
    except subprocess.TimeoutExpired:
        report["diagnostic_stage"] = stage
        report["error_code"] = "SSH_PROBE_TIMEOUT"
    except Exception as error:
        report["diagnostic_stage"] = stage
        report["error_code"] = "PRIVATE_READINESS_FAILED"
        report["exception_type"] = safe_code(type(error).__name__, "UnknownException")
    try:
        write_report(report, private_values(access))
    except Exception:
        RESULT.unlink(missing_ok=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
