"""Deploy one bounded production API image hotfix with atomic compose rollback.

The controller replaces only services.api.image in the already-running
Lightsail Compose file, recreates API + guard, verifies health and the cached
page-reuse quota regression, and restores the previous compose/image on any
failure. Database, identity container, frontend, DNS and AI policy are not
changed.
"""
from __future__ import annotations

import base64
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
RESULT = Path("lightsail-backend-hotfix-results/summary.json")
IMAGE_RE = re.compile(
    r"^[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/"
    r"quizforge-api@sha256:[a-f0-9]{64}$"
)

REMOTE_APPLY = r"""set -euo pipefail
old_image="$1"
new_image="$2"
compose=/opt/quizforge/current/compose.json
suffix="${new_image##*@sha256:}"
candidate="/opt/quizforge/current/.compose-api-hotfix-$suffix.json"
backup="/opt/quizforge/current/.compose-api-rollback-$suffix.json"
swapped=0

test -s "$compose"
test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
test ! -e "$candidate"
test ! -e "$backup"
docker image inspect "$new_image" >/dev/null

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$swapped" -eq 1 ] && [ -s "$backup" ]; then
    cp "$backup" "$compose"
    docker compose -f "$compose" stop --timeout 30 guard >/dev/null 2>&1 || true
    docker compose -f "$compose" up -d --force-recreate --no-deps api >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      api_id="$(docker compose -f "$compose" ps -q api 2>/dev/null || true)"
      state="$(test -n "$api_id" && docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_id" 2>/dev/null || true)"
      [ "$state" = healthy ] && break
      sleep 1
    done
    docker compose -f "$compose" up -d --force-recreate --no-deps guard >/dev/null 2>&1 || true
  fi
  rm -f "$candidate"
  if [ "$status" -eq 0 ]; then
    rm -f "$backup"
  fi
  exit "$status"
}
trap cleanup EXIT

python3 - "$compose" "$candidate" "$old_image" "$new_image" <<'PYCONFIG'
import copy
import json
from pathlib import Path
import re
import sys

source=Path(sys.argv[1])
destination=Path(sys.argv[2])
old_image=sys.argv[3]
new_image=sys.argv[4]
pattern=re.compile(r"^[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}$")
if not pattern.fullmatch(old_image) or not pattern.fullmatch(new_image) or old_image == new_image:
    raise ValueError("invalid image transition")
value=json.loads(source.read_text())
services=value.get("services")
if not isinstance(services,dict) or set(("api","identity","guard","db","redis","web")) - set(services):
    raise ValueError("unexpected compose services")
if services["api"].get("image") != old_image:
    raise ValueError("live API image does not match reviewed baseline")
if services["identity"].get("image") != old_image:
    raise ValueError("identity image no longer matches reviewed baseline")
before=copy.deepcopy(value)
value["services"]["api"]["image"]=new_image
expected=copy.deepcopy(before)
expected["services"]["api"]["image"]=new_image
if value != expected:
    raise ValueError("hotfix changes more than API image")
destination.write_text(json.dumps(value,indent=2)+"\n")
PYCONFIG

docker compose -f "$candidate" config --quiet
cp "$compose" "$backup"
mv "$candidate" "$compose"
swapped=1

docker compose -f "$compose" stop --timeout 30 guard >/dev/null 2>&1 || true
docker compose -f "$compose" up -d --force-recreate --no-deps api >/dev/null

api_ready=0
for _ in $(seq 1 45); do
  api_id="$(docker compose -f "$compose" ps -q api 2>/dev/null || true)"
  state="$(test -n "$api_id" && docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_id" 2>/dev/null || true)"
  if [ "$state" = healthy ]; then
    api_ready=1
    break
  fi
  sleep 1
done
test "$api_ready" -eq 1

docker compose -f "$compose" up -d --force-recreate --no-deps guard >/dev/null
guard_id="$(docker compose -f "$compose" ps -q guard)"
test -n "$guard_id"
for _ in $(seq 1 30); do
  state="$(docker inspect --format '{{.State.Status}}' "$guard_id" 2>/dev/null || true)"
  [ "$state" = running ] && break
  sleep 1
done
test "$(docker inspect --format '{{.State.Status}}' "$guard_id")" = running

health_ready=0
for _ in $(seq 1 30); do
  if curl --silent --show-error --fail --max-time 10 http://127.0.0.1:8000/api/health >/dev/null 2>&1 \
    && curl --silent --show-error --fail --max-time 10 \
      --resolve api.quizfromnotes.com:443:127.0.0.1 \
      https://api.quizfromnotes.com/api/health >/dev/null 2>&1; then
    health_ready=1
    break
  fi
  sleep 1
done
test "$health_ready" -eq 1

docker compose -f "$compose" exec -T api python - <<'PYPROBE'
import hashlib
import tempfile

import pdf_job_store
from pdf_job_store import JobStore

TEXT = "Cached page reuse probe contains enough extractable study text. " * 12
raw = b"quiz-from-notes-cached-reuse-hotfix-probe"
source = hashlib.sha256(raw).hexdigest()

with tempfile.TemporaryDirectory(prefix="qf-cache-reuse-probe-") as directory:
    store = JobStore(directory)
    try:
        for number in [1, 2, 3, 4]:
            row = store.submit("probe-user", "probe.pdf", raw, [number])
            claimed = store.claim()
            assert claimed is not None and claimed["id"] == row["id"]
            store.finish(
                row["id"],
                [{"page_number": number, "text": TEXT + str(number)}],
            )
        with store.connect() as db:
            before = db.execute(
                "SELECT count(*) FROM admissions WHERE owner=?",
                ("probe-user",),
            ).fetchone()[0]
        assert before == pdf_job_store.MAX_OWNER_JOBS
        reused = store.reuse_selection("probe-user", source, [1, 2, 3, 4])
        assert reused is not None
        assert reused["reused_pages"] == 4
        assert [page["page_number"] for page in reused["result"]] == [1, 2, 3, 4]
        with store.connect() as db:
            after = db.execute(
                "SELECT count(*) FROM admissions WHERE owner=?",
                ("probe-user",),
            ).fetchone()[0]
        assert after == before
    finally:
        store.close()
PYPROBE

python3 - "$compose" "$new_image" <<'PYVERIFY'
import json
import sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
assert value["services"]["api"]["image"] == sys.argv[2]
PYVERIFY

python3 - <<'PYRESULT'
import json
print("QF_RESULT="+json.dumps({
  "api_image_replaced": True,
  "api_healthy": True,
  "public_api_https_verified": True,
  "guard_recreated": True,
  "cached_reselection_quota_probe_passed": True,
  "identity_container_unchanged": True,
  "database_unchanged": True,
  "frontend_unchanged": True,
  "dns_unchanged": True,
  "ai_policy_unchanged": True,
},sort_keys=True))
PYRESULT
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}", text) else fallback


def write_report(report: Mapping[str, Any], forbidden: list[str]) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True) + "\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached backend-hotfix summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw) or re.search(r"\b\d{12}\b", raw):
        raise ValueError("network/account identifier reached backend-hotfix summary")
    if "sha256:" in raw:
        raise ValueError("image digest reached backend-hotfix summary")
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(raw, encoding="utf-8")


def main() -> int:
    if len(os.sys.argv) != 4:
        print("usage: backend_hotfix.py OLD_IMAGE NEW_IMAGE PINS", file=os.sys.stderr)
        return 2

    old_image, new_image = os.sys.argv[1], os.sys.argv[2]
    pins_path = Path(os.sys.argv[3])
    report: dict[str, Any] = {
        "schema": 1,
        "operation": "cached_page_reuse_api_hotfix",
        "result": "hotfix_failed",
        "api_image_replacement_attempted": False,
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "identity_container_changed": False,
        "database_changed": False,
        "frontend_changed": False,
        "dns_changed": False,
        "ai_policy_changed": False,
    }
    forbidden = [old_image, new_image]
    lightsail = None
    runner = None
    temp = None
    admin = ""
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        if (
            not IMAGE_RE.fullmatch(old_image)
            or not IMAGE_RE.fullmatch(new_image)
            or old_image == new_image
            or old_image.split("@", 1)[0] != new_image.split("@", 1)[0]
        ):
            raise ValueError("backend hotfix image contract invalid")

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
        access = lightsail.get_instance_access_details(
            instanceName=INSTANCE_NAME,
            protocol="ssh",
        )["accessDetails"]
        private_key = access.get("privateKey")
        cert_key = access.get("certKey")
        username = access.get("username")
        if not all(isinstance(v, str) and v for v in (private_key, cert_key, username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key, cert_key])

        temp = Path(tempfile.mkdtemp(prefix="quizforge-backend-hotfix-"))
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

        ecr = boto3.client("ecr", region_name=REGION)
        auth = ecr.get_authorization_token()["authorizationData"][0]
        decoded = base64.b64decode(auth["authorizationToken"]).decode("utf-8")
        ecr_user, ecr_password = decoded.split(":", 1)
        registry = auth["proxyEndpoint"].removeprefix("https://")
        forbidden.extend([ecr_password, registry])

        login = ssh_command(
            key, cert, hosts, username, ip,
            "sudo", "docker", "login", "--username", ecr_user, "--password-stdin", registry,
        )
        subprocess.run(
            login,
            input=ecr_password,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
            check=True,
        )
        try:
            subprocess.run(
                ssh_command(key, cert, hosts, username, ip, "sudo", "docker", "pull", new_image),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=300,
                check=True,
            )
        finally:
            subprocess.run(
                ssh_command(key, cert, hosts, username, ip, "sudo", "docker", "logout", registry),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=20,
                check=False,
            )

        report["api_image_replacement_attempted"] = True
        completed = subprocess.run(
            ssh_command(
                key, cert, hosts, username, ip,
                "sudo", "bash", "-s", "--", old_image, new_image,
            ),
            input=REMOTE_APPLY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=420,
            check=True,
        )
        values = [
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(values) != 1:
            raise ValueError("unexpected backend hotfix result")
        state = json.loads(values[0])
        required = (
            "api_image_replaced",
            "api_healthy",
            "public_api_https_verified",
            "guard_recreated",
            "cached_reselection_quota_probe_passed",
            "identity_container_unchanged",
            "database_unchanged",
            "frontend_unchanged",
            "dns_unchanged",
            "ai_policy_unchanged",
        )
        if not all(state.get(name) is True for name in required):
            raise ValueError("backend hotfix acceptance incomplete")
        report["acceptance"] = state
        report["result"] = "cached_page_reuse_api_hotfix_verified"
    except ClientError as error:
        report["error_code"] = "AWS_BACKEND_HOTFIX_FAILED"
        report["aws_error_code"] = safe_code(error.response.get("Error", {}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"] = "REMOTE_BACKEND_HOTFIX_FAILED"
        report["remote_return_code"] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = "BACKEND_HOTFIX_TIMEOUT"
    except Exception as error:
        report["error_code"] = safe_code(type(error).__name__, "PRIVATE_BACKEND_HOTFIX_FAILED")
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
        if report.get("result") == "cached_page_reuse_api_hotfix_verified" and not report.get("baseline_firewall_restored"):
            report["result"] = "cached_page_reuse_api_hotfix_firewall_cleanup_unverified"
        try:
            write_report(report, forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result") == "cached_page_reuse_api_hotfix_verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
