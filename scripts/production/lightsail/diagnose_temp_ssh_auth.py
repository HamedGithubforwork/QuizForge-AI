"""Sanitized diagnostic for Lightsail temporary SSH authentication."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

import boto3

from scripts.production.lightsail.stage_release import (
    INSTANCE_NAME, STATIC_IP_NAME, baseline_ports, normalized_ports,
    load_pins, runner_ipv4, scan_host, ssh_command,
)

REGION = "ca-central-1"
RESULT = Path("lightsail-temp-ssh-results/summary.json")


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=30, check=False)


def fingerprint(path: Path) -> str | None:
    completed = run(["ssh-keygen", "-lf", str(path), "-E", "sha256"])
    if completed.returncode != 0:
        return None
    match = re.search(r"SHA256:[A-Za-z0-9+/]+", completed.stdout)
    return match.group(0) if match else None


def safe_summary(stderr: str) -> dict[str, bool]:
    text = stderr.lower()
    return {
        "server_offered_publickey_auth": "authentications that can continue: publickey" in text,
        "client_offered_certificate": "certificate" in text and "offering public key" in text,
        "server_accepted_key": "server accepts key" in text,
        "permission_denied": "permission denied" in text,
        "host_key_verified": "host key verification failed" not in text,
    }


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_temporary_ssh_auth_diagnostic",
        "result": "diagnostic_failed",
        "tcp_22_reachable": False,
        "temporary_private_key_valid": False,
        "temporary_certificate_valid": False,
        "temporary_key_certificate_match": False,
        "temporary_access_not_expired": False,
        "temporary_username_present": False,
        "certificate_auth_succeeded": False,
        "key_only_auth_succeeded": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
    }
    lightsail = None
    runner = None
    temp: Path | None = None
    try:
        if (
            os.environ.get("GITHUB_EVENT_NAME") != "push"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_REPOSITORY") != "HamedGithubforwork/QuizForge-AI"
        ):
            raise ValueError("Trusted main push required")
        admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        lightsail = boto3.client("lightsail", region_name=REGION)
        instance = lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static = lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip = static.get("ipAddress")
        if not isinstance(ip, str) or static.get("attachedTo") != INSTANCE_NAME:
            raise ValueError("Production host contract mismatch")
        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if normalized_ports(before) != baseline_ports(admin):
            raise ValueError("Baseline firewall mismatch")

        runner = runner_ipv4()
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],
                      "ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"] = True

        pins = load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        known = scan_host(ip, pins)
        report["tcp_22_reachable"] = True

        access = lightsail.get_instance_access_details(instanceName=INSTANCE_NAME, protocol="ssh")["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        expires = access.get("expiresAt")
        if not all(isinstance(value, str) and value for value in (private_key, cert_key, username)):
            raise ValueError("Temporary SSH material incomplete")
        report["temporary_username_present"] = True
        if isinstance(expires, datetime):
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            report["temporary_access_not_expired"] = expires > datetime.now(timezone.utc)

        temp = Path(tempfile.mkdtemp(prefix="qf-temp-ssh-diag-", dir=os.environ.get("RUNNER_TEMP")))
        temp.chmod(0o700)
        key = temp/"key"
        cert = temp/"key-cert.pub"
        hosts = temp/"known_hosts"
        pub = temp/"key.pub"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key + ("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)

        derived = run(["ssh-keygen", "-y", "-f", str(key)])
        if derived.returncode == 0 and derived.stdout.strip():
            pub.write_text(derived.stdout.strip()+"\n")
            report["temporary_private_key_valid"] = True
        cert_check = run(["ssh-keygen", "-L", "-f", str(cert)])
        report["temporary_certificate_valid"] = cert_check.returncode == 0
        key_fp = fingerprint(pub) if pub.exists() else None
        cert_fp = fingerprint(cert)
        report["temporary_key_certificate_match"] = bool(key_fp and cert_fp and key_fp == cert_fp)

        cert_auth = run(
            ssh_command(key, cert, hosts, username, ip, "true")[:-1] +
            ["-vv", f"{username}@{ip}", "true"]
        )
        report["certificate_auth_succeeded"] = cert_auth.returncode == 0
        report["certificate_auth"] = safe_summary(cert_auth.stderr)

        key_only = run([
            "ssh","-vv","-i",str(key),
            "-o",f"UserKnownHostsFile={hosts}","-o","StrictHostKeyChecking=yes",
            "-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","ConnectTimeout=15",
            f"{username}@{ip}","true",
        ])
        report["key_only_auth_succeeded"] = key_only.returncode == 0
        report["key_only_auth"] = safe_summary(key_only.stderr)
        report["result"] = "diagnostic_complete"
    except Exception as error:
        report["error_code"] = type(error).__name__
    finally:
        if lightsail is not None and runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],
                              "ipv6Cidrs":[],"cidrListAliases":[]},
                )
                report["temporary_ssh_rule_closed"] = True
                after = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
                report["baseline_firewall_restored"] = normalized_ports(after) == baseline_ports(
                    os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
                )
            except Exception:
                report["cleanup_error_code"] = "FIREWALL_CLEANUP_FAILED"
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        RESULT.parent.mkdir(parents=True, exist_ok=True)
        RESULT.write_text(json.dumps(report, indent=2, sort_keys=True)+"\n", encoding="utf-8")

    return 0 if report["result"] == "diagnostic_complete" and report["baseline_firewall_restored"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
