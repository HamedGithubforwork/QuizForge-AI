"""Temporary two-vantage SSH host-key probe for the permanent Lightsail instance.

This diagnostic temporarily opens SSH only to the current GitHub runner IPv4 /32,
scans the server host key, closes that exact temporary rule in a finally block,
and publishes only fingerprints/algorithms plus firewall restoration checks.
It does not authenticate to the host and does not modify host files.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
from typing import Any, Mapping

try:
    import boto3
    from botocore.exceptions import ClientError
except ModuleNotFoundError:
    boto3 = None

    class ClientError(Exception):
        response: dict[str, Any] = {}

REGION = "ca-central-1"
INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"
RESULT = Path("lightsail-ssh-trust-probe/summary.json")
EXPECTED_PUBLIC = {
    (22, 22, "tcp", ("__ADMIN_CIDR__",), (), ()),
    (80, 80, "tcp", ("0.0.0.0/0",), (), ()),
    (443, 443, "tcp", ("0.0.0.0/0",), (), ()),
}


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:-]{1,100}", text) else fallback


def runner_ipv4() -> str:
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10) as response:
        raw = response.read(128).decode("ascii").strip()
    ip = ipaddress.ip_address(raw)
    if ip.version != 4:
        raise ValueError("Runner did not expose IPv4")
    return str(ip)


def normalized_ports(items: list[Mapping[str, Any]]) -> set[tuple[Any, ...]]:
    return {
        (
            item.get("fromPort"),
            item.get("toPort"),
            item.get("protocol"),
            tuple(sorted(item.get("cidrs") or [])),
            tuple(sorted(item.get("ipv6Cidrs") or [])),
            tuple(sorted(item.get("cidrListAliases") or [])),
        )
        for item in items
        if isinstance(item, Mapping)
    }


def baseline_expected(items: list[Mapping[str, Any]], admin_cidr: str) -> bool:
    expected = {
        (
            a,
            b,
            c,
            tuple(admin_cidr if value == "__ADMIN_CIDR__" else value for value in d),
            e,
            f,
        )
        for a, b, c, d, e, f in EXPECTED_PUBLIC
    }
    return normalized_ports(items) == expected


def parse_keyscan(stdout: str, expected_ip: str) -> list[dict[str, str]]:
    result = []
    seen = set()
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[0] != expected_ip:
            continue
        algorithm, encoded = parts[1], parts[2]
        if not re.fullmatch(r"(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)", algorithm):
            continue
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception:
            continue
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
        key = (algorithm, fingerprint)
        if key not in seen:
            seen.add(key)
            result.append({"algorithm": algorithm, "fingerprint_sha256": fingerprint})
    return sorted(result, key=lambda item: (item["algorithm"], item["fingerprint_sha256"]))


def scan(ip: str) -> list[dict[str, str]]:
    completed = subprocess.run(
        ["ssh-keyscan", "-T", "10", "-t", "ed25519,ecdsa,rsa", ip],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=20,
        check=False,
    )
    if completed.returncode not in {0, 1}:
        raise RuntimeError("ssh-keyscan failed")
    keys = parse_keyscan(completed.stdout, ip)
    if not keys:
        raise RuntimeError("No SSH host keys observed")
    return keys


def write_report(report: Mapping[str, Any]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP leaked into public summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_ssh_host_trust_probe",
        "changes_performed": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "result": "probe_failed",
    }
    runner = None
    lightsail = None
    admin_cidr = os.environ.get("LIGHTSAIL_ADMIN_IPV4_CIDR", "")
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        network = ipaddress.ip_network(admin_cidr, strict=True)
        if network.version != 4 or network.prefixlen != 32:
            raise ValueError("Admin CIDR must be /32")

        report["diagnostic_stage"] = "live_contract"
        lightsail = boto3.client("lightsail", region_name=REGION)
        instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        if static.get("attachedTo") != INSTANCE_NAME or instance.get("isStaticIp") is not True:
            raise ValueError("Static IP contract mismatch")
        ip = static.get("ipAddress")
        if not isinstance(ip, str) or ipaddress.ip_address(ip).version != 4:
            raise ValueError("Static IPv4 unavailable")

        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if not baseline_expected(before, admin_cidr):
            raise ValueError("Baseline firewall mismatch")

        report["diagnostic_stage"] = "runner_ipv4"
        runner = runner_ipv4()
        runner_cidr = runner + "/32"
        if runner_cidr == admin_cidr:
            raise ValueError("Runner unexpectedly equals operator CIDR")

        report["diagnostic_stage"] = "open_temporary_ssh"
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={
                "fromPort": 22,
                "toPort": 22,
                "protocol": "tcp",
                "cidrs": [runner_cidr],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        )
        report["changes_performed"] = True
        report["temporary_ssh_rule_opened"] = True

        report["diagnostic_stage"] = "verify_temporary_ssh_rule"
        during = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        runner_visible = any(
            isinstance(item, Mapping)
            and item.get("fromPort") == 22
            and item.get("toPort") == 22
            and item.get("protocol") == "tcp"
            and runner_cidr in (item.get("cidrs") or [])
            for item in during
        )
        report["temporary_ssh_rule_visible"] = runner_visible
        if not runner_visible:
            raise ValueError("Temporary runner SSH rule not visible")

        report["diagnostic_stage"] = "ssh_keyscan"
        keys = scan(ip)
        report["diagnostic_stage"] = "host_keys_observed"
        report["host_keys"] = keys
        report["observed_key_count"] = len(keys)
        report["ed25519_observed"] = any(item["algorithm"] == "ssh-ed25519" for item in keys)
        report["result"] = "probe_succeeded_pending_cleanup"
    except ClientError as error:
        report["error_code"] = "AWS_OPERATION_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except subprocess.TimeoutExpired:
        report["error_code"] = "SSH_KEYSCAN_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_PROBE_FAILED")
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
                report["baseline_firewall_restored"] = baseline_expected(after, admin_cidr)
            except ClientError as error:
                report["cleanup_error_code"] = safe_code(
                    error.response.get("Error", {}).get("Code"),
                    "AWS_CLEANUP_FAILED",
                )
            except Exception as error:
                report["cleanup_error_code"] = safe_code(
                    type(error).__name__,
                    "PRIVATE_CLEANUP_FAILED",
                )

        if (
            report.get("result") == "probe_succeeded_pending_cleanup"
            and report.get("temporary_ssh_rule_closed") is True
            and report.get("baseline_firewall_restored") is True
        ):
            report["result"] = "probe_succeeded_firewall_restored"
        elif report.get("result") == "probe_succeeded_pending_cleanup":
            report["result"] = "probe_succeeded_cleanup_unverified"

        try:
            write_report(report)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "probe_succeeded_firewall_restored" else 1


if __name__ == "__main__":
    raise SystemExit(main())
