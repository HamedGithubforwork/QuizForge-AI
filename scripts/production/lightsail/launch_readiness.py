"""Read-only/safely temporary readiness check before public QuizForge cutover.

This verifies the already-staged permanent Lightsail release, initialized runtime,
baseline firewall, Route 53 delegation, and current DNS posture. It may
temporarily open SSH only to the GitHub runner /32 and always restores the
baseline firewall. It never creates the launch marker, starts QuizForge, changes
DNS, or enables AI.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
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
RESULT = Path("lightsail-public-launch-readiness/summary.json")
RELEASE_RE = re.compile(r"^[0-9a-f]{40}$")

REMOTE_CHECK = r"""set -euo pipefail
release_sha="$1"
case "$release_sha" in *[!0-9a-f]*|'') exit 31;; esac
test "$(printf %s "$release_sha" | wc -c)" -eq 40

test -f /var/lib/quizforge/base-host-ready
test -f /etc/quizforge/database-initialized
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service

test "$(readlink -f /opt/quizforge/current)" = "/opt/quizforge/releases/$release_sha"
test -s /opt/quizforge/current/compose.json
test -s /opt/quizforge/current/Caddyfile
test -s /opt/quizforge/frontend/index.html

for path in \
  /etc/quizforge/db-ca.pem \
  /etc/quizforge/postgres/server.crt \
  /etc/quizforge/postgres/server.key \
  /etc/quizforge/postgres/owner-password \
  /etc/quizforge/api.env \
  /etc/quizforge/identity.env \
  /etc/quizforge/generation-db.env \
  /etc/quizforge/generation.env
do
  test -s "$path"
done

grep -q '^OPENAI_API_KEY=disabled-until-explicit-activation-' /etc/quizforge/generation.env
! grep -q '^OPENAI_API_KEY=sk-' /etc/quizforge/generation.env

compose_file=/opt/quizforge/current/compose.json
docker compose -f "$compose_file" config --quiet
test -z "$(docker compose -f "$compose_file" ps --status running -q)"

python3 - "$compose_file" <<'PY'
import json, subprocess, sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
services=value.get("services") or {}
assert set(services)=={"api","identity","guard","db","redis","web"}
images=[]
for service in services.values():
    image=service.get("image")
    assert isinstance(image,str) and "@sha256:" in image
    images.append(image)
assert len(images)==6
for image in sorted(set(images)):
    subprocess.run(["docker","image","inspect",image],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
PY

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "base_host_ready": True,
  "database_initialized": True,
  "exact_release_staged": True,
  "frontend_present": True,
  "runtime_credentials_present": True,
  "generation_key_placeholder_only": True,
  "compose_valid": True,
  "reviewed_images_present": True,
  "containers_stopped": True,
  "launch_marker_absent": True,
  "systemd_service_inactive": True,
  "systemd_service_disabled": True,
},sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def _record_values(records: list[Mapping[str, Any]], name: str) -> list[str]:
    normalized = name.rstrip(".").lower()
    values: list[str] = []
    for record in records:
        if str(record.get("Name", "")).rstrip(".").lower() != normalized:
            continue
        if record.get("Type") != "A":
            continue
        for item in record.get("ResourceRecords") or []:
            value = item.get("Value") if isinstance(item, Mapping) else None
            if isinstance(value, str):
                values.append(value)
    return values


def evaluate_dns(
    records: list[Mapping[str, Any]],
    instance_ip: str,
    authoritative_ns: list[str],
    public_ns: list[str],
    public_apex_a: list[str],
    public_api_a: list[str],
) -> dict[str, Any]:
    apex = _record_values(records, DOMAIN)
    api = _record_values(records, API_DOMAIN)
    expected_ns = {value.rstrip(".").lower() for value in authoritative_ns}
    observed_ns = {value.rstrip(".").lower() for value in public_ns}
    return {
        "route53_zone_present": len(expected_ns) == 4,
        "public_delegation_matches_route53": observed_ns == expected_ns,
        "route53_apex_points_to_lightsail": apex == [instance_ip],
        "route53_api_points_to_lightsail": api == [instance_ip],
        "public_apex_points_to_lightsail": public_apex_a == [instance_ip],
        "public_api_points_to_lightsail": public_api_a == [instance_ip],
        "dns_cutover_required": not (apex == [instance_ip] and api == [instance_ip]),
    }


def _dig(record_type: str, name: str) -> list[str]:
    completed = subprocess.run(
        ["dig", "+short", "+time=5", "+tries=1", record_type, name],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        return []
    return sorted(line.strip() for line in completed.stdout.splitlines() if line.strip())


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached launch-readiness summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP reached launch-readiness summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_public_launch_readiness",
        "result": "readiness_failed",
        "public_launch_attempted": False,
        "dns_changes_performed": False,
        "ai_enabled": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
    }
    forbidden: list[str] = []
    runner = None
    lightsail = None
    temp: Path | None = None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")

        lock = json.loads(Path("scripts/production/lightsail/release-lock.json").read_text())
        release_sha = lock.get("release_sha", "")
        if (
            lock.get("schema") != 1
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
        records = route53.list_resource_record_sets(HostedZoneId=zone_id).get("ResourceRecordSets", [])
        public_ns = _dig("NS", DOMAIN)
        public_apex = _dig("A", DOMAIN)
        public_api = _dig("A", API_DOMAIN)
        dns = evaluate_dns(records, ip, nameservers, public_ns, public_apex, public_api)
        report["dns"] = dns

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
        access = lightsail.get_instance_access_details(
            instanceName=INSTANCE_NAME, protocol="ssh"
        )["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        if not all(isinstance(value, str) and value for value in (private_key, cert_key, username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key, cert_key])

        temp = Path(tempfile.mkdtemp(prefix="quizforge-launch-readiness-"))
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

        completed = subprocess.run(
            ssh_command(key, cert, hosts, username, ip, "sudo", "bash", "-s", "--", release_sha),
            input=REMOTE_CHECK,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=True,
        )
        values = [
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(values) != 1:
            raise ValueError("unexpected launch-readiness result")
        host = json.loads(values[0])
        required = (
            "base_host_ready",
            "database_initialized",
            "exact_release_staged",
            "frontend_present",
            "runtime_credentials_present",
            "generation_key_placeholder_only",
            "compose_valid",
            "reviewed_images_present",
            "containers_stopped",
            "launch_marker_absent",
            "systemd_service_inactive",
            "systemd_service_disabled",
        )
        if not all(host.get(name) is True for name in required):
            raise ValueError("host launch prerequisites incomplete")
        report["host"] = host

        if not dns["public_delegation_matches_route53"]:
            report["result"] = "host_ready_public_dns_delegation_not_verified"
        elif dns["dns_cutover_required"]:
            report["result"] = "launch_readiness_passed_dns_cutover_required"
        else:
            report["result"] = "launch_readiness_passed_dns_already_pointing"
    except ClientError as error:
        report["error_code"] = "AWS_READINESS_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_READINESS_FAILED"
        report["remote_return_code"] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = "REMOTE_READINESS_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_READINESS_FAILED")
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
                report["baseline_firewall_restored"] = (
                    normalized_ports(after)
                    == baseline_ports(os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"])
                )
            except Exception as error:
                report["cleanup_error_code"] = safe_code(
                    type(error).__name__, "PRIVATE_CLEANUP_FAILED"
                )
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
        if (
            str(report.get("result", "")).startswith("launch_readiness_passed")
            and not report.get("baseline_firewall_restored")
        ):
            report["result"] = "launch_readiness_firewall_cleanup_unverified"
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if str(report.get("result", "")).startswith("launch_readiness_passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
