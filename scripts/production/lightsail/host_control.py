"""Shared Lightsail host access and firewall primitives.

These helpers contain the production instance identity, exact baseline firewall,
runner-IP discovery, pinned host-key verification, and strict SSH/SCP command
construction reused by bounded maintenance controllers.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import urllib.request
from typing import Any, Mapping

INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"
FP_RE = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")


def runner_ipv4() -> str:
    with urllib.request.urlopen(
        "https://checkip.amazonaws.com",
        timeout=10,
    ) as response:
        raw = response.read(128).decode("ascii").strip()
    ip = ipaddress.ip_address(raw)
    if ip.version != 4:
        raise ValueError("Runner IPv4 unavailable")
    return str(ip)


def normalized_ports(
    items: list[Mapping[str, Any]],
) -> set[tuple[Any, ...]]:
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


def baseline_ports(admin_cidr: str) -> set[tuple[Any, ...]]:
    return {
        (22, 22, "tcp", (admin_cidr,), (), ()),
        (80, 80, "tcp", ("0.0.0.0/0",), (), ()),
        (443, 443, "tcp", ("0.0.0.0/0",), (), ()),
    }


def load_pins(path: Path) -> set[tuple[str, str]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        value.get("schema") != 1
        or value.get("instance_name") != INSTANCE_NAME
        or value.get("trust_basis")
        != "two_independent_github_runner_network_observations"
    ):
        raise ValueError("SSH pin metadata invalid")

    result: set[tuple[str, str]] = set()
    for item in value.get("host_keys") or []:
        if not isinstance(item, Mapping):
            raise ValueError("SSH pin entry invalid")
        algorithm = item.get("algorithm")
        fingerprint = item.get("fingerprint_sha256")
        if (
            algorithm
            not in {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"}
            or not isinstance(fingerprint, str)
            or not FP_RE.fullmatch(fingerprint)
        ):
            raise ValueError("SSH pin invalid")
        result.add((algorithm, fingerprint))

    if len(result) != 3 or not any(
        algorithm == "ssh-ed25519"
        for algorithm, _ in result
    ):
        raise ValueError("SSH pin set incomplete")
    return result


def scan_host(ip: str, pins: set[tuple[str, str]]) -> str:
    completed = subprocess.run(
        [
            "ssh-keyscan",
            "-T",
            "10",
            "-t",
            "ed25519,ecdsa,rsa",
            ip,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=20,
        check=False,
    )
    lines: list[str] = []
    found: set[tuple[str, str]] = set()
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[0] != ip:
            continue
        algorithm, encoded = parts[1], parts[2]
        if algorithm not in {
            "ssh-ed25519",
            "ssh-rsa",
            "ecdsa-sha2-nistp256",
        }:
            continue
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception:
            continue
        fingerprint = (
            "SHA256:"
            + base64.b64encode(hashlib.sha256(raw).digest())
            .decode()
            .rstrip("=")
        )
        found.add((algorithm, fingerprint))
        lines.append(line)

    if found != pins:
        raise ValueError(
            "Observed SSH host key does not match pinned set"
        )
    return "\n".join(lines) + "\n"


def ssh_command(
    key: Path,
    cert: Path,
    known: Path,
    username: str,
    ip: str,
    *remote: str,
) -> list[str]:
    return [
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
        *remote,
    ]


def scp_command(
    key: Path,
    cert: Path,
    known: Path,
    username: str,
    ip: str,
    source: Path,
    destination: str,
) -> list[str]:
    return [
        "scp",
        "-q",
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
        str(source),
        f"{username}@{ip}:{destination}",
    ]
