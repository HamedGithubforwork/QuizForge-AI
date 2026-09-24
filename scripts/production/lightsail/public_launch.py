"""Perform the guarded public QuizForge DNS cutover and start the permanent release.

The operation is intentionally narrow:
- require the exact reviewed, AI-disabled release and initialized private runtime;
- atomically replace only apex/API A/AAAA/CNAME traffic records in the existing
  Route 53 zone with A records to the permanent Lightsail static IPv4;
- start the already-staged systemd release only after authoritative DNS is live;
- verify public TLS/frontend/API/identity behavior without enabling AI;
- restore the previous DNS records and stop/disable QuizForge if verification fails.

No model key is installed and the generation policy is not enabled here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any, Mapping

try:
    import boto3
    from botocore.exceptions import ClientError
except ModuleNotFoundError:
    boto3 = None

    class ClientError(Exception):
        response: dict[str, Any] = {}

from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    normalized_ports,
    load_pins,
    scan_host,
    runner_ipv4,
    ssh_command,
)

REGION = "ca-central-1"
DOMAIN = "quizfromnotes.com"
API_DOMAIN = "api.quizfromnotes.com"
RESULT = Path("lightsail-public-launch-results/summary.json")
RELEASE_RE = re.compile(r"^[0-9a-f]{40}$")
TRAFFIC_TYPES = {"A", "AAAA", "CNAME"}

REMOTE_LAUNCH = r"""set -euo pipefail
release_sha="$1"
case "$release_sha" in *[!0-9a-f]*|'') exit 31;; esac
test "$(printf %s "$release_sha" | wc -c)" -eq 40

test -f /var/lib/quizforge/base-host-ready
test -f /etc/quizforge/database-initialized
test "$(readlink -f /opt/quizforge/current)" = "/opt/quizforge/releases/$release_sha"
test -s /opt/quizforge/current/compose.json
test -s /opt/quizforge/frontend/index.html
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service

grep -q '^OPENAI_API_KEY=disabled-until-explicit-activation-' /etc/quizforge/generation.env
! grep -q '^OPENAI_API_KEY=sk-' /etc/quizforge/generation.env
test -z "$(docker compose -f /opt/quizforge/current/compose.json ps --status running -q)"

printf '%s\n' "$release_sha" | sudo tee /etc/quizforge/launch-approved >/dev/null
sudo chmod 0600 /etc/quizforge/launch-approved
sudo systemctl enable quizforge.service >/dev/null
sudo systemctl start quizforge.service

systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service
test -f /etc/quizforge/launch-approved

services="$(docker compose -f /opt/quizforge/current/compose.json ps --services --status running | sort)"
expected="$(printf '%s\n' api db guard identity redis web | sort)"
test "$services" = "$expected"

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "launch_marker_present": True,
  "systemd_service_active": True,
  "systemd_service_enabled": True,
  "all_six_services_running": True,
  "ai_key_placeholder_only": True,
},sort_keys=True))
PY
"""

REMOTE_ROLLBACK = r"""set -euo pipefail
sudo systemctl stop quizforge.service >/dev/null 2>&1 || true
sudo systemctl disable quizforge.service >/dev/null 2>&1 || true
sudo rm -f /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service
test ! -e /etc/quizforge/launch-approved
docker compose -f /opt/quizforge/current/compose.json stop --timeout 30 >/dev/null 2>&1 || true
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def desired_record(name: str, ip: str) -> dict[str, Any]:
    return {
        "Name": name.rstrip(".") + ".",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": ip}],
    }


def relevant_records(records: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    names = {DOMAIN, API_DOMAIN}
    result = []
    for record in records:
        name = str(record.get("Name", "")).rstrip(".").lower()
        rtype = record.get("Type")
        if name in names and rtype in TRAFFIC_TYPES:
            result.append(dict(record))
    return result


def record_matches(record: Mapping[str, Any], desired: Mapping[str, Any]) -> bool:
    return (
        str(record.get("Name", "")).rstrip(".").lower()
        == str(desired["Name"]).rstrip(".").lower()
        and record.get("Type") == "A"
        and record.get("AliasTarget") is None
        and record.get("ResourceRecords") == desired["ResourceRecords"]
    )


def cutover_changes(original: list[dict[str, Any]], ip: str) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for name in (DOMAIN, API_DOMAIN):
        desired = desired_record(name, ip)
        existing = [
            record for record in original
            if str(record.get("Name", "")).rstrip(".").lower() == name
        ]
        if len(existing) == 1 and record_matches(existing[0], desired):
            continue
        for record in existing:
            changes.append({"Action": "DELETE", "ResourceRecordSet": record})
        changes.append({"Action": "CREATE", "ResourceRecordSet": desired})
    return changes


def restore_changes(current: list[dict[str, Any]], original: list[dict[str, Any]]) -> list[dict[str, Any]]:
    changes = [
        {"Action": "DELETE", "ResourceRecordSet": record}
        for record in current
    ]
    changes.extend(
        {"Action": "CREATE", "ResourceRecordSet": record}
        for record in original
    )
    return changes


def wait_change(route53, change_id: str, timeout: int = 180) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = route53.get_change(Id=change_id)["ChangeInfo"]["Status"]
        if status == "INSYNC":
            return
        time.sleep(3)
    raise TimeoutError("Route53 change did not become INSYNC")


def dig(record_type: str, name: str, server: str | None = None) -> list[str]:
    command = ["dig", "+short", "+time=5", "+tries=1"]
    if server:
        command.append("@" + server.rstrip("."))
    command.extend([record_type, name])
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        return []
    return sorted(line.strip().rstrip(".") for line in completed.stdout.splitlines() if line.strip())


def authoritative_dns_ready(nameservers: list[str], ip: str) -> bool:
    if len(nameservers) != 4:
        return False
    for server in nameservers:
        if dig("A", DOMAIN, server) != [ip]:
            return False
        if dig("A", API_DOMAIN, server) != [ip]:
            return False
    return True


def https_status(host: str, path: str, ip: str) -> int:
    completed = subprocess.run(
        [
            "curl", "--silent", "--show-error", "--output", "/dev/null",
            "--write-out", "%{http_code}",
            "--connect-timeout", "5", "--max-time", "15",
            "--resolve", f"{host}:443:{ip}",
            f"https://{host}{path}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=20,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip().isdigit():
        return 0
    return int(completed.stdout.strip())


def verify_public_https(ip: str, timeout: int = 300) -> dict[str, bool]:
    deadline = time.time() + timeout
    last = {"frontend": False, "api_health": False, "identity_guard": False}
    while time.time() < deadline:
        last = {
            "frontend": https_status(DOMAIN, "/", ip) == 200,
            "api_health": https_status(API_DOMAIN, "/api/health", ip) == 200,
            "identity_guard": https_status(API_DOMAIN, "/identity/session", ip) == 403,
        }
        if all(last.values()):
            return last
        time.sleep(10)
    return last


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached public-launch summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP reached public-launch summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_public_dns_cutover_and_launch",
        "result": "launch_failed",
        "dns_cutover_performed": False,
        "application_launch_attempted": False,
        "application_started": False,
        "public_https_verified": False,
        "ai_enabled": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "rollback_attempted": False,
        "rollback_service_restored_inactive": False,
        "rollback_dns_restored": False,
    }
    forbidden: list[str] = []
    lightsail = None
    route53 = None
    runner = None
    temp: Path | None = None
    original_records: list[dict[str, Any]] = []
    zone_id = None
    dns_changed = False
    ssh_context: tuple[Path, Path, Path, str, str] | None = None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")

        lock = json.loads(Path("scripts/production/lightsail/release-lock.json").read_text())
        release_sha = lock.get("release_sha", "")
        if (
            lock.get("schema") != 1
            or lock.get("public_configuration_validated") is not True
            or lock.get("ai_enabled") is not False
            or not isinstance(release_sha, str)
            or not RELEASE_RE.fullmatch(release_sha)
        ):
            raise ValueError("release lock invalid")

        admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))

        lightsail = boto3.client("lightsail", region_name=REGION)
        instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip = static.get("ipAddress")
        if (
            instance.get("blueprintId") != "ubuntu_24_04"
            or instance.get("bundleId") != "small_3_0"
            or instance.get("location", {}).get("availabilityZone") != "ca-central-1a"
            or instance.get("isStaticIp") is not True
            or static.get("attachedTo") != INSTANCE_NAME
            or not isinstance(ip, str)
        ):
            raise ValueError("live instance contract mismatch")
        forbidden.extend([ip, admin])

        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if normalized_ports(before) != baseline_ports(admin):
            raise ValueError("baseline firewall mismatch")

        route53 = boto3.client("route53")
        zones = route53.list_hosted_zones_by_name(DNSName=DOMAIN, MaxItems="10").get("HostedZones", [])
        matches = [
            zone for zone in zones
            if str(zone.get("Name", "")).rstrip(".").lower() == DOMAIN
            and not zone.get("Config", {}).get("PrivateZone", False)
        ]
        if len(matches) != 1:
            raise ValueError("expected exactly one public Route53 zone")
        zone_id = str(matches[0]["Id"]).split("/")[-1]
        zone = route53.get_hosted_zone(Id=zone_id)
        nameservers = sorted(zone.get("DelegationSet", {}).get("NameServers") or [])
        public_ns = {value.lower() for value in dig("NS", DOMAIN)}
        expected_ns = {value.rstrip(".").lower() for value in nameservers}
        if public_ns != expected_ns:
            raise ValueError("public DNS delegation mismatch")

        all_records = route53.list_resource_record_sets(HostedZoneId=zone_id).get("ResourceRecordSets", [])
        original_records = relevant_records(all_records)
        changes = cutover_changes(original_records, ip)
        if changes:
            response = route53.change_resource_record_sets(
                HostedZoneId=zone_id,
                ChangeBatch={
                    "Comment": "QuizForge controlled permanent Lightsail cutover",
                    "Changes": changes,
                },
            )
            wait_change(route53, response["ChangeInfo"]["Id"])
            dns_changed = True
            report["dns_cutover_performed"] = True

        if not authoritative_dns_ready(nameservers, ip):
            raise ValueError("authoritative production DNS not ready")

        runner = runner_ipv4()
        forbidden.append(runner)
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={
                "fromPort": 22, "toPort": 22, "protocol": "tcp",
                "cidrs": [runner + "/32"], "ipv6Cidrs": [], "cidrListAliases": [],
            },
        )
        report["temporary_ssh_rule_opened"] = True

        known = scan_host(ip, pins)
        access = lightsail.get_instance_access_details(instanceName=INSTANCE_NAME, protocol="ssh")["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        if not all(isinstance(value, str) and value for value in (private_key, cert_key, username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key, cert_key])

        temp = Path(tempfile.mkdtemp(prefix="quizforge-public-launch-"))
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
        ssh_context = (key, cert, hosts, username, ip)

        report["application_launch_attempted"] = True
        completed = subprocess.run(
            ssh_command(key, cert, hosts, username, ip, "bash", "-s", "--", release_sha),
            input=REMOTE_LAUNCH,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=240,
            check=True,
        )
        values = [
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(values) != 1:
            raise ValueError("unexpected launch result")
        state = json.loads(values[0])
        if not all(state.get(name) is True for name in (
            "launch_marker_present",
            "systemd_service_active",
            "systemd_service_enabled",
            "all_six_services_running",
            "ai_key_placeholder_only",
        )):
            raise ValueError("service launch incomplete")
        report["application_started"] = True

        public = verify_public_https(ip)
        report["frontend_https_passed"] = public["frontend"]
        report["api_health_https_passed"] = public["api_health"]
        report["identity_guard_https_passed"] = public["identity_guard"]
        if not all(public.values()):
            raise ValueError("public HTTPS verification failed")

        report["public_https_verified"] = True
        report["result"] = "public_launch_verified_ai_disabled"
    except ClientError as error:
        report["error_code"] = "AWS_LAUNCH_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_LAUNCH_FAILED"
        report["remote_return_code"] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = "LAUNCH_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_LAUNCH_FAILED")
    finally:
        if report.get("result") != "public_launch_verified_ai_disabled":
            report["rollback_attempted"] = bool(dns_changed or report["application_launch_attempted"])
            if ssh_context and report["application_launch_attempted"]:
                key, cert, hosts, username, ip = ssh_context
                try:
                    subprocess.run(
                        ssh_command(key, cert, hosts, username, ip, "bash", "-s"),
                        input=REMOTE_ROLLBACK,
                        text=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=120,
                        check=True,
                    )
                    report["rollback_service_restored_inactive"] = True
                except Exception as error:
                    report["rollback_service_error"] = safe_code(
                        type(error).__name__, "PRIVATE_SERVICE_ROLLBACK_FAILED"
                    )

            if dns_changed and route53 is not None and zone_id:
                try:
                    now = route53.list_resource_record_sets(HostedZoneId=zone_id).get("ResourceRecordSets", [])
                    current = relevant_records(now)
                    changes = restore_changes(current, original_records)
                    if changes:
                        response = route53.change_resource_record_sets(
                            HostedZoneId=zone_id,
                            ChangeBatch={
                                "Comment": "Rollback failed QuizForge permanent cutover",
                                "Changes": changes,
                            },
                        )
                        wait_change(route53, response["ChangeInfo"]["Id"])
                    report["rollback_dns_restored"] = True
                except Exception as error:
                    report["rollback_dns_error"] = safe_code(
                        type(error).__name__, "PRIVATE_DNS_ROLLBACK_FAILED"
                    )

        if lightsail is not None and runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={
                        "fromPort": 22, "toPort": 22, "protocol": "tcp",
                        "cidrs": [runner + "/32"], "ipv6Cidrs": [], "cidrListAliases": [],
                    },
                )
                report["temporary_ssh_rule_closed"] = True
                after = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
                report["baseline_firewall_restored"] = (
                    normalized_ports(after)
                    == baseline_ports(os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"])
                )
            except Exception as error:
                report["cleanup_error_code"] = safe_code(
                    type(error).__name__, "PRIVATE_FIREWALL_CLEANUP_FAILED"
                )

        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass

        if (
            report.get("result") == "public_launch_verified_ai_disabled"
            and not report.get("baseline_firewall_restored")
        ):
            report["result"] = "public_launch_firewall_cleanup_unverified"

        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "public_launch_verified_ai_disabled" else 1


if __name__ == "__main__":
    raise SystemExit(main())
