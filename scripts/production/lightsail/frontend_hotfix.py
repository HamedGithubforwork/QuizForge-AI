"""Atomically replace the live static frontend with the pinned application candidate.

This is a bounded corrective deployment for the already-running permanent
Lightsail host. It changes only /opt/quizforge/frontend and recreates only the
Caddy web container. Backend images, database state, DNS, systemd enablement and
AI policy are not changed. Any failed verification restores the previous
frontend and recreates Caddy against that rollback directory.
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
    scp_command,
)

REGION = "ca-central-1"
RESULT = Path("lightsail-frontend-hotfix-results/summary.json")
TREE_RE = re.compile(r"^[a-f0-9]{64}$")

REMOTE_APPLY = r"""set -euo pipefail
archive="$1"
expected="$2"
compose=/opt/quizforge/current/compose.json
stage="/opt/quizforge/.frontend-hotfix-$expected"
backup="/opt/quizforge/.frontend-rollback-$expected"
swapped=0

case "$expected" in *[!0-9a-f]*|'') exit 31;; esac
test "$(printf %s "$expected" | wc -c)" -eq 64
test -s "$archive"
test -s "$compose"
test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service
test -d /opt/quizforge/frontend
test ! -e "$stage"
test ! -e "$backup"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$swapped" -eq 1 ] && [ -d "$backup" ]; then
    rm -rf /opt/quizforge/frontend
    mv "$backup" /opt/quizforge/frontend
    docker compose -f "$compose" up -d --force-recreate --no-deps web >/dev/null 2>&1 || true
  fi
  rm -rf "$stage"
  if [ "$status" -eq 0 ]; then
    rm -rf "$backup"
  fi
  rm -f "$archive"
  exit "$status"
}
trap cleanup EXIT

install -d -m 0755 -o root -g root "$stage"
python3 - "$archive" "$stage" "$expected" <<'PY'
import hashlib
from pathlib import Path, PurePosixPath
import sys, tarfile

archive=Path(sys.argv[1])
root=Path(sys.argv[2])
expected=sys.argv[3]

with tarfile.open(archive,"r:gz") as handle:
    members=handle.getmembers()
    if not members:
        raise ValueError("empty frontend archive")
    for member in members:
        path=PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
            raise ValueError("unsafe frontend archive member")
    handle.extractall(root,filter="data")

index=root/"index.html"
if not index.is_file() or index.stat().st_size <= 0:
    raise ValueError("frontend index missing")

h=hashlib.sha256()
for path in sorted(p for p in root.rglob("*") if p.is_file()):
    rel=path.relative_to(root).as_posix().encode()
    h.update(rel+b"\0")
    h.update(hashlib.sha256(path.read_bytes()).digest())
if h.hexdigest()!=expected:
    raise ValueError("frontend tree digest mismatch")

markers={
    b"Continue to your existing account":False,
    b"New here? Start with a fresh account":False,
}
for path in root.rglob("*"):
    if path.is_file() and path.stat().st_size <= 8*1024*1024:
        try:
            raw=path.read_bytes()
        except OSError:
            continue
        for marker in markers:
            if marker in raw:
                markers[marker]=True
if not all(markers.values()):
    raise ValueError("Distinct Cognito production UI markers missing")
PY

chown -R root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +

mv /opt/quizforge/frontend "$backup"
mv "$stage" /opt/quizforge/frontend
swapped=1

docker compose -f "$compose" up -d --force-recreate --no-deps web >/dev/null

for _ in $(seq 1 30); do
  state="$(docker inspect --format '{{.State.Status}}' quizforge-production-web-1 2>/dev/null || true)"
  [ "$state" = running ] && break
  sleep 1
done
test "$(docker inspect --format '{{.State.Status}}' quizforge-production-web-1)" = running

curl --silent --show-error --fail --max-time 15 \
  --resolve quizfromnotes.com:443:127.0.0.1 \
  https://quizfromnotes.com/ >/dev/null
curl --silent --show-error --fail --max-time 15 \
  --resolve api.quizfromnotes.com:443:127.0.0.1 \
  https://api.quizfromnotes.com/api/health >/dev/null

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "frontend_tree_verified":True,
  "cognito_ui_marker_verified":True,
  "web_container_recreated":True,
  "frontend_https_verified":True,
  "api_health_verified":True,
  "public_service_remains_active":True,
},sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached frontend-hotfix summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        raise ValueError("IP reached frontend-hotfix summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    if len(os.sys.argv) != 4:
        print("usage: frontend_hotfix.py FRONTEND_TAR TREE_SHA256 PINS", file=os.sys.stderr)
        return 2

    archive = Path(os.sys.argv[1])
    tree = os.sys.argv[2]
    pins_path = Path(os.sys.argv[3])
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "lightsail_cognito_frontend_hotfix",
        "result": "hotfix_failed",
        "frontend_replacement_attempted": False,
        "backend_changed": False,
        "database_changed": False,
        "dns_changed": False,
        "ai_policy_changed": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    temp = None
    remote_archive = None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        if not archive.is_file() or archive.stat().st_size <= 0 or not TREE_RE.fullmatch(tree):
            raise ValueError("frontend hotfix input invalid")
        pins = load_pins(pins_path)
        admin = os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]

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
            raise ValueError("live instance contract mismatch")
        forbidden.extend([ip, admin])

        before = lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates", [])
        if normalized_ports(before) != baseline_ports(admin):
            raise ValueError("baseline firewall mismatch")

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
        if not all(isinstance(v, str) and v for v in (private_key, cert_key, username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key, cert_key])

        temp = Path(tempfile.mkdtemp(prefix="quizforge-frontend-hotfix-"))
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

        remote_archive = f"/tmp/quizforge-frontend-hotfix-{tree}.tar.gz"
        subprocess.run(
            scp_command(key, cert, hosts, username, ip, archive, remote_archive),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=True,
        )
        report["frontend_replacement_attempted"] = True
        completed = subprocess.run(
            ssh_command(
                key, cert, hosts, username, ip,
                "sudo", "bash", "-s", "--", remote_archive, tree,
            ),
            input=REMOTE_APPLY,
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
            raise ValueError("unexpected frontend hotfix result")
        state = json.loads(values[0])
        required = (
            "frontend_tree_verified",
            "cognito_ui_marker_verified",
            "web_container_recreated",
            "frontend_https_verified",
            "api_health_verified",
            "public_service_remains_active",
        )
        if not all(state.get(name) is True for name in required):
            raise ValueError("frontend hotfix acceptance incomplete")
        report["acceptance"] = state
        report["result"] = "cognito_frontend_hotfix_verified"
    except ClientError as error:
        report["error_code"] = "AWS_FRONTEND_HOTFIX_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_FRONTEND_HOTFIX_FAILED"
        report["remote_return_code"] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = "FRONTEND_HOTFIX_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_FRONTEND_HOTFIX_FAILED")
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
                report["baseline_firewall_restored"] = normalized_ports(after) == baseline_ports(admin)
            except Exception as error:
                report["cleanup_error_code"] = safe_code(type(error).__name__, "PRIVATE_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try:
                temp.rmdir()
            except OSError:
                pass
        if report.get("result") == "cognito_frontend_hotfix_verified" and not report.get("baseline_firewall_restored"):
            report["result"] = "cognito_frontend_hotfix_firewall_cleanup_unverified"
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "cognito_frontend_hotfix_verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
