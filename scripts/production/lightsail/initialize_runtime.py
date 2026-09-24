"""Initialize the staged Lightsail runtime privately, test it, then leave it stopped.

This is a fresh-only/idempotent preparation step. It creates local PostgreSQL TLS
material and runtime database credentials, initializes the reviewed schema with AI
disabled, starts DB/cache/API/identity/gateway only for loopback acceptance, then
stops every application container again. It never creates the launch marker,
changes DNS, starts Caddy, or enables model spending.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
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
)

REGION="ca-central-1"
RESULT=Path("lightsail-runtime-init-results/summary.json")
RELEASE_RE=re.compile(r"^[0-9a-f]{40}$")

REMOTE_INIT=r"""set -euo pipefail
release_sha="$1"
case "$release_sha" in *[!0-9a-f]*|'') exit 31;; esac
test "$(printf %s "$release_sha" | wc -c)" -eq 40
test -f /var/lib/quizforge/base-host-ready
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
test "$(readlink -f /opt/quizforge/current)" = "/opt/quizforge/releases/$release_sha"
test -s /opt/quizforge/current/compose.json
test -s /opt/quizforge/current/reviewed-ai-policy.sql
test -s /opt/quizforge/frontend/index.html

compose_file=/opt/quizforge/current/compose.json
compose_started=0
cleanup() {
  if [ "$compose_started" -eq 1 ]; then
    docker compose -f "$compose_file" stop --timeout 30 guard api identity db redis >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ops_image="$(python3 - "$compose_file" <<'PY'
import json,sys,re
value=json.load(open(sys.argv[1],encoding="utf-8"))
image=value["services"]["guard"]["image"]
assert re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}",image)
print(image)
PY
)"
docker image inspect "$ops_image" >/dev/null

initialized=0
if [ -f /etc/quizforge/database-initialized ]; then
  for path in     /etc/quizforge/db-ca.pem     /etc/quizforge/postgres/server.crt     /etc/quizforge/postgres/server.key     /etc/quizforge/postgres/owner-password     /etc/quizforge/api.env     /etc/quizforge/identity.env     /etc/quizforge/generation-db.env     /etc/quizforge/generation.env
  do
    test -s "$path"
  done
else
  test ! -e /etc/quizforge/db-ca.pem
  test ! -e /etc/quizforge/postgres/server.crt
  test ! -e /etc/quizforge/postgres/server.key
  test ! -e /etc/quizforge/postgres/owner-password
  test ! -e /etc/quizforge/api.env
  test ! -e /etc/quizforge/identity.env
  test ! -e /etc/quizforge/generation-db.env
  test ! -e /etc/quizforge/generation.env
  if [ -d /var/lib/quizforge/postgres ]; then
    test -z "$(find /var/lib/quizforge/postgres -mindepth 1 -maxdepth 1 -print -quit)"
  fi

  install -d -m 0700 -o 999 -g 999 /etc/quizforge/postgres
  install -d -m 0700 -o 999 -g 999 /var/lib/quizforge/postgres
  install -d -m 0700 -o 10001 -g 10001     /var/lib/quizforge/pdf-jobs     /var/lib/quizforge/caddy-data     /var/lib/quizforge/caddy-config

  work="$(mktemp -d)"
  chmod 0700 "$work"
  trap 'rm -rf "$work"; cleanup' EXIT
  command -v openssl >/dev/null
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 397     -subj '/CN=QuizForge Local Database CA'     -addext 'basicConstraints=critical,CA:TRUE'     -addext 'keyUsage=critical,keyCertSign,cRLSign'     -keyout "$work/ca.key" -out "$work/ca.crt" >/dev/null 2>&1
  openssl req -new -newkey rsa:3072 -sha256 -nodes     -subj '/CN=db.quizforge.internal'     -addext 'subjectAltName=DNS:db.quizforge.internal'     -keyout "$work/server.key" -out "$work/server.csr" >/dev/null 2>&1
  cat > "$work/server.ext" <<'EOF'
subjectAltName=DNS:db.quizforge.internal
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
  openssl x509 -req -sha256 -days 397     -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key"     -CAcreateserial -extfile "$work/server.ext" -out "$work/server.crt" >/dev/null 2>&1

  openssl verify -CAfile "$work/ca.crt" "$work/server.crt" >/dev/null
  openssl x509 -in "$work/server.crt" -noout -checkend 31536000 >/dev/null
  openssl x509 -in "$work/server.crt" -noout -ext subjectAltName | grep -q 'DNS:db.quizforge.internal'

  install -m 0644 -o root -g root "$work/ca.crt" /etc/quizforge/db-ca.pem
  install -m 0644 -o 999 -g 999 "$work/server.crt" /etc/quizforge/postgres/server.crt
  install -m 0600 -o 999 -g 999 "$work/server.key" /etc/quizforge/postgres/server.key

  python3 - <<'PY'
from pathlib import Path
import secrets, os
path=Path("/etc/quizforge/postgres/owner-password")
path.write_text(secrets.token_urlsafe(48)+"\n",encoding="utf-8")
os.chmod(path,0o600)
os.chown(path,999,999)
for name in ("api.env","identity.env","generation.env"):
    p=Path("/etc/quizforge")/name
    p.write_text("",encoding="utf-8")
    os.chmod(p,0o600)
PY

  docker compose -f "$compose_file" config --quiet
  docker compose -f "$compose_file" up -d --wait db redis >/dev/null
  compose_started=1

  rm -f /etc/quizforge/api.env /etc/quizforge/identity.env

  docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1     --user 0:0     -e PRODUCTION_DATABASE_TARGET=lightsail     -e PGHOST=db.quizforge.internal     -e PGDATABASE=quizforge     -e PGUSER=quizforge_owner     -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem     -v /etc/quizforge:/etc/quizforge     "$ops_image" python lightsail_initialize.py >/dev/null

  cat /etc/quizforge/generation-db.env > /etc/quizforge/generation.env
  python3 - <<'PY'
from pathlib import Path
import secrets, os
p=Path("/etc/quizforge/generation.env")
with p.open("a",encoding="utf-8") as h:
    h.write("OPENAI_API_KEY=disabled-until-explicit-activation-"+secrets.token_urlsafe(24)+"\n")
os.chmod(p,0o600)
PY

  docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1     --user 0:0     -e PRODUCTION_DATABASE_TARGET=lightsail     -e PGHOST=db.quizforge.internal     -e PGDATABASE=quizforge     -e PGUSER=quizforge_owner     -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem     -v /etc/quizforge:/etc/quizforge     -v /opt/quizforge/current:/release:ro     "$ops_image" python -c '
import os
from pathlib import Path
import psycopg
from database import options
os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
with psycopg.connect(**options(os.environ)) as conn:
    conn.execute(Path("/release/reviewed-ai-policy.sql").read_text())
' >/dev/null

  touch /etc/quizforge/database-initialized
  chmod 0600 /etc/quizforge/database-initialized
  initialized=1
  rm -rf "$work"
  trap cleanup EXIT
fi

for path in   /etc/quizforge/db-ca.pem   /etc/quizforge/postgres/server.crt   /etc/quizforge/postgres/server.key   /etc/quizforge/postgres/owner-password   /etc/quizforge/api.env   /etc/quizforge/identity.env   /etc/quizforge/generation-db.env   /etc/quizforge/generation.env
do
  test -s "$path"
done

docker compose -f "$compose_file" up -d --wait db redis >/dev/null
compose_started=1

docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1   --user 0:0   -e PRODUCTION_DATABASE_TARGET=lightsail   -e PGHOST=db.quizforge.internal   -e PGDATABASE=quizforge   -e PGUSER=quizforge_owner   -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem   -v /etc/quizforge:/etc/quizforge   "$ops_image" python -c '
import os
from pathlib import Path
import psycopg
from database import options
os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
with psycopg.connect(**options(os.environ)) as conn:
    row=conn.execute("SELECT enabled,daily_requests,monthly_requests,monthly_nano_usd FROM billing.generation_policy WHERE singleton").fetchone()
    assert row["enabled"] is False
    assert row["daily_requests"]==0
    assert row["monthly_requests"]==0
    assert row["monthly_nano_usd"]==5000000000
' >/dev/null

docker compose -f "$compose_file" up -d --wait api identity guard >/dev/null

python3 - <<'PY'
from urllib.request import urlopen,Request
from urllib.error import HTTPError
import json,subprocess,sys

with urlopen("http://127.0.0.1:8000/api/health",timeout=5) as r:
    assert r.status==200
try:
    urlopen("http://127.0.0.1:8001/identity/session",timeout=5)
except HTTPError as e:
    assert e.code==403
else:
    raise AssertionError("identity accepted unauthenticated request")

probe="""import urllib.request,urllib.error,json
body=json.dumps({"model":"gpt-5.6-luna","input":[{"role":"user","content":"local disabled-budget acceptance"}]}).encode()
try:
 urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8002/v1/responses",body,{"Authorization":"Bearer production-budget-guard","Content-Type":"application/json"}),timeout=5)
except urllib.error.HTTPError as e:
 assert e.code==429,e.code
else:
 raise AssertionError("disabled budget allowed generation")
"""
subprocess.run(["docker","compose","-f","/opt/quizforge/current/compose.json","exec","-T","api","python","-c",probe],check=True,stdout=subprocess.DEVNULL)
PY

docker compose -f "$compose_file" stop --timeout 30 guard api identity db redis >/dev/null
compose_started=0
test -z "$(docker compose -f "$compose_file" ps --status running -q)"
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service

python3 - "$initialized" <<'PY'
import json,sys
print("QF_RESULT="+json.dumps({
  "database_initialized": True,
  "runtime_credentials_present": True,
  "database_tls_verified": True,
  "ai_policy_disabled": True,
  "local_api_health_passed": True,
  "local_identity_guard_passed": True,
  "local_generation_disabled_passed": True,
  "containers_stopped_after_acceptance": True,
  "launch_marker_absent": True,
  "systemd_service_inactive": True,
  "fresh_initialization_performed": sys.argv[1]=="1",
},sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str="UNKNOWN") -> str:
    text=str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}",text) else fallback


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached summary")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
        "schema":1,
        "operation":"lightsail_runtime_initialize_and_local_acceptance",
        "result":"initialization_failed",
        "temporary_ssh_rule_opened":False,
        "temporary_ssh_rule_closed":False,
        "baseline_firewall_restored":False,
        "public_launch_attempted":False,
        "dns_changes_performed":False,
        "ai_enabled":False,
    }
    forbidden=[]
    runner=None
    lightsail=None
    temp=None
    try:
        release_sha=os.environ.get("QF_RELEASE_SHA","")
        if not RELEASE_RE.fullmatch(release_sha):
            raise ValueError("release SHA invalid")
        admin=os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        pins=load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))

        lightsail=boto3.client("lightsail",region_name=REGION)
        instance=lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static=lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip=static.get("ipAddress")
        if (
            instance.get("blueprintId")!="ubuntu_24_04"
            or instance.get("bundleId")!="small_3_0"
            or instance.get("location",{}).get("availabilityZone")!="ca-central-1a"
            or instance.get("isStaticIp") is not True
            or static.get("attachedTo")!=INSTANCE_NAME
            or not isinstance(ip,str)
        ):
            raise ValueError("live instance contract mismatch")
        forbidden.extend([ip,admin])

        before=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
        if normalized_ports(before)!=baseline_ports(admin):
            raise ValueError("baseline firewall mismatch")

        runner=runner_ipv4()
        forbidden.append(runner)
        runner_cidr=runner+"/32"
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner_cidr],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"]=True

        known=scan_host(ip,pins)
        access=lightsail.get_instance_access_details(instanceName=INSTANCE_NAME,protocol="ssh")["accessDetails"]
        private_key=access.get("privateKey"); cert_key=access.get("certKey"); username=access.get("username")
        if not all(isinstance(v,str) and v for v in (private_key,cert_key,username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key,cert_key])

        temp=Path(tempfile.mkdtemp(prefix="quizforge-runtime-init-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)

        cmd=ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s","--",release_sha)
        completed=subprocess.run(
            cmd,input=REMOTE_INIT,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            timeout=1200,check=True,
        )
        results=[
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(results)!=1:
            raise ValueError("unexpected initialization result")
        state=json.loads(results[0])
        required=(
            "database_initialized","runtime_credentials_present","database_tls_verified",
            "ai_policy_disabled","local_api_health_passed","local_identity_guard_passed",
            "local_generation_disabled_passed","containers_stopped_after_acceptance",
            "launch_marker_absent","systemd_service_inactive",
        )
        if not all(state.get(key) is True for key in required):
            raise ValueError("local runtime acceptance incomplete")
        report["acceptance"]=state
        report["result"]="runtime_initialized_local_acceptance_passed_services_stopped"
    except ClientError as error:
        report["error_code"]="AWS_INITIALIZATION_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_INITIALIZATION_FAILED"
        report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="REMOTE_INITIALIZATION_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_INITIALIZATION_FAILED")
    finally:
        if lightsail is not None and runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
                )
                report["temporary_ssh_rule_closed"]=True
                after=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
                report["baseline_firewall_restored"]=normalized_ports(after)==baseline_ports(os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"])
            except Exception as error:
                report["cleanup_error_code"]=safe_code(type(error).__name__,"PRIVATE_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        if report.get("result")=="runtime_initialized_local_acceptance_passed_services_stopped" and not report.get("baseline_firewall_restored"):
            report["result"]="runtime_initialized_firewall_cleanup_unverified"
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="runtime_initialized_local_acceptance_passed_services_stopped" else 1


if __name__=="__main__":
    raise SystemExit(main())
