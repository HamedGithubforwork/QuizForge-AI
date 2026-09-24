"""Guarded one-time activation of paid QuizForge generation on permanent Lightsail.

Requires the existing GitHub Actions OPENAI_API_KEY secret. The key is transferred
through SSH stdin into a root-only temporary file and is never printed. Activation
sets the persistent PostgreSQL generation policy to the approved USD5 monthly
ceiling, recreates only the guard container, makes one synthetic paid provider
canary, and leaves the public application running. Any failed activation attempts
to disable the policy and replace the live key with a local disabled placeholder.
"""
from __future__ import annotations

from datetime import date
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

from scripts.production.generation_costs import (
    APPROVED_MONTHLY_NANO_USD,
    PRICING_KEY,
    PRICING_VALID_UNTIL,
)
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
RESULT=Path("lightsail-ai-activation-results/summary.json")
DAILY_REQUESTS=100
MONTHLY_REQUESTS=1000
CANARY_MAX_OUTPUT_TOKENS=64

REMOTE_ACTIVATE=r"""set -euo pipefail
daily="$1"
monthly="$2"
monthly_nano="$3"
pricing_key="$4"
pricing_valid_until="$5"
canary_tokens="$6"

compose=/opt/quizforge/current/compose.json
pending=/etc/quizforge/openai-api-key.pending

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service
test -s "$compose"
test -s "$pending"
test "$(stat -c %a "$pending")" = "600"

case "$daily:$monthly:$monthly_nano:$canary_tokens" in *[!0-9:]*|'') exit 31;; esac
test "$daily" -eq 100
test "$monthly" -eq 1000
test "$monthly_nano" -eq 5000000000
test "$canary_tokens" -eq 64
printf '%s' "$pricing_key" | grep -Eq '^[A-Za-z0-9._+-]{1,120}$'
printf '%s' "$pricing_valid_until" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

ops_image="$(python3 - "$compose" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
image=value["services"]["guard"]["image"]
assert re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api@sha256:[a-f0-9]{64}",image)
print(image)
PY
)"

python3 - <<'PY'
from pathlib import Path
import os,re
pending=Path("/etc/quizforge/openai-api-key.pending")
target=Path("/etc/quizforge/generation.env")
key=pending.read_text(encoding="utf-8").strip()
assert 20 <= len(key) <= 512
assert not re.search(r"\s",key)
lines=target.read_text(encoding="utf-8").splitlines()
old=[line for line in lines if line.startswith("OPENAI_API_KEY=")]
assert len(old)==1 and old[0].startswith("OPENAI_API_KEY=disabled-until-explicit-activation-")
kept=[line for line in lines if not line.startswith("OPENAI_API_KEY=")]
assert len([line for line in kept if line.startswith("PGPASSWORD=")])==1
target.write_text("\n".join(kept)+f"\nOPENAI_API_KEY={key}\n",encoding="utf-8")
os.chmod(target,0o600)
pending.unlink()
PY

docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1 \
  --user 0:0 \
  -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e PGHOST=db.quizforge.internal \
  -e PGDATABASE=quizforge \
  -e PGUSER=quizforge_owner \
  -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem \
  -e QF_DAILY="$daily" \
  -e QF_MONTHLY="$monthly" \
  -e QF_MONTHLY_NANO="$monthly_nano" \
  -e QF_PRICING_KEY="$pricing_key" \
  -e QF_PRICING_VALID_UNTIL="$pricing_valid_until" \
  -v /etc/quizforge:/etc/quizforge \
  "$ops_image" python -c '
import os
from pathlib import Path
from datetime import date
import psycopg
from database import options
os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
daily=int(os.environ["QF_DAILY"]); monthly=int(os.environ["QF_MONTHLY"])
nano=int(os.environ["QF_MONTHLY_NANO"])
pricing=os.environ["QF_PRICING_KEY"]; valid=os.environ["QF_PRICING_VALID_UNTIL"]
assert date.today() < date.fromisoformat(valid)
with psycopg.connect(**options(os.environ)) as conn:
    before=conn.execute("SELECT enabled,daily_requests,monthly_requests,monthly_nano_usd FROM billing.generation_policy WHERE singleton FOR UPDATE").fetchone()
    assert before["enabled"] is False
    assert before["daily_requests"]==0 and before["monthly_requests"]==0
    assert before["monthly_nano_usd"]==5000000000
    conn.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=%s,monthly_requests=%s,monthly_nano_usd=%s,pricing_key=%s,pricing_valid_until=%s WHERE singleton",
                 (daily,monthly,nano,pricing,valid))
' >/dev/null

docker compose -f "$compose" up -d --force-recreate --no-deps guard >/dev/null

for _ in $(seq 1 30); do
  if docker compose -f "$compose" exec -T api python -c 'import socket; s=socket.create_connection(("127.0.0.1",8002),2); s.close()' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker compose -f "$compose" exec -T api python -c 'import socket; s=socket.create_connection(("127.0.0.1",8002),2); s.close()' >/dev/null

canary_status="$(docker compose -f "$compose" exec -T api python - "$canary_tokens" <<'PY'
import json,sys,urllib.request,urllib.error
tokens=int(sys.argv[1])
body=json.dumps({
  "model":"gpt-5.6-luna",
  "input":[{"role":"user","content":"Return only the word READY. This is the QuizForge production activation canary."}],
  "max_output_tokens":tokens,
}).encode()
req=urllib.request.Request(
  "http://127.0.0.1:8002/v1/responses",
  body,
  {"Authorization":"Bearer production-budget-guard","Content-Type":"application/json"},
)
try:
    with urllib.request.urlopen(req,timeout=110) as response:
        response.read(1024)
        print(response.status)
except urllib.error.HTTPError as error:
    error.read(1024)
    print(error.code)
PY
)"
test "$canary_status" = "200"

docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1 \
  --user 0:0 \
  -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e PGHOST=db.quizforge.internal \
  -e PGDATABASE=quizforge \
  -e PGUSER=quizforge_owner \
  -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem \
  -e QF_DAILY="$daily" \
  -e QF_MONTHLY="$monthly" \
  -e QF_MONTHLY_NANO="$monthly_nano" \
  -e QF_PRICING_KEY="$pricing_key" \
  -e QF_PRICING_VALID_UNTIL="$pricing_valid_until" \
  -v /etc/quizforge:/etc/quizforge \
  "$ops_image" python -c '
import os
from pathlib import Path
import psycopg
from database import options
os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
with psycopg.connect(**options(os.environ)) as conn:
    row=conn.execute("SELECT enabled,daily_requests,monthly_requests,monthly_nano_usd,pricing_key,pricing_valid_until FROM billing.generation_policy WHERE singleton").fetchone()
    assert row["enabled"] is True
    assert row["daily_requests"]==int(os.environ["QF_DAILY"])
    assert row["monthly_requests"]==int(os.environ["QF_MONTHLY"])
    assert row["monthly_nano_usd"]==int(os.environ["QF_MONTHLY_NANO"])
    assert row["pricing_key"]==os.environ["QF_PRICING_KEY"]
    assert str(row["pricing_valid_until"])==os.environ["QF_PRICING_VALID_UNTIL"]
    used=conn.execute("SELECT coalesce(sum(requests),0) AS n FROM billing.generation_usage WHERE period='month' AND starts_on=date_trunc('month',current_date)::date").fetchone()["n"]
    assert used >= 1
' >/dev/null

systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "ai_enabled":True,
  "monthly_budget_usd":5,
  "daily_request_limit":100,
  "monthly_request_limit":1000,
  "paid_canary_status":200,
  "public_service_remains_active":True,
},sort_keys=True))
PY
"""

REMOTE_DISABLE=r"""set -euo pipefail
compose=/opt/quizforge/current/compose.json
rm -f /etc/quizforge/openai-api-key.pending

ops_image="$(python3 - "$compose" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8"))["services"]["guard"]["image"])
PY
)"

python3 - <<'PY'
from pathlib import Path
import os,secrets
target=Path("/etc/quizforge/generation.env")
if target.exists():
    lines=target.read_text(encoding="utf-8").splitlines()
    kept=[line for line in lines if not line.startswith("OPENAI_API_KEY=")]
    if any(line.startswith("PGPASSWORD=") for line in kept):
        target.write_text("\n".join(kept)+"\nOPENAI_API_KEY=disabled-until-explicit-activation-"+secrets.token_urlsafe(24)+"\n",encoding="utf-8")
        os.chmod(target,0o600)
PY

docker run --rm --network host --add-host db.quizforge.internal:127.0.0.1 \
  --user 0:0 \
  -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e PGHOST=db.quizforge.internal \
  -e PGDATABASE=quizforge \
  -e PGUSER=quizforge_owner \
  -e PGSSLROOTCERT=/etc/quizforge/db-ca.pem \
  -v /etc/quizforge:/etc/quizforge \
  "$ops_image" python -c '
import os
from pathlib import Path
import psycopg
from database import options
os.environ["PGPASSWORD"]=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
with psycopg.connect(**options(os.environ)) as conn:
    conn.execute("UPDATE billing.generation_policy SET enabled=false,daily_requests=0,monthly_requests=0 WHERE singleton")
' >/dev/null || true

docker compose -f "$compose" up -d --force-recreate --no-deps guard >/dev/null 2>&1 || true
"""


def safe_code(value: Any, fallback: str="UNKNOWN") -> str:
    text=str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}",text) else fallback


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached AI activation summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached AI activation summary")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
      "schema":1,
      "operation":"lightsail_ai_activation",
      "result":"activation_failed",
      "ai_enabled":False,
      "paid_model_request_attempted":False,
      "monthly_budget_usd":5,
      "daily_request_limit":DAILY_REQUESTS,
      "monthly_request_limit":MONTHLY_REQUESTS,
      "temporary_ssh_rule_opened":False,
      "temporary_ssh_rule_closed":False,
      "baseline_firewall_restored":False,
      "rollback_attempted":False,
      "rollback_disabled_ai":False,
    }
    forbidden=[]
    lightsail=None
    runner=None
    temp=None
    ssh_context=None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        if APPROVED_MONTHLY_NANO_USD != 5_000_000_000:
            raise ValueError("approved budget mismatch")
        if date.today() >= date.fromisoformat(PRICING_VALID_UNTIL):
            raise ValueError("pricing review expired")

        api_key=os.environ.get("OPENAI_API_KEY","").strip()
        if not 20 <= len(api_key) <= 512 or re.search(r"\s",api_key):
            report["error_code"]="MISSING_OR_INVALID_OPENAI_API_KEY_SECRET"
            write_report(report,[])
            return 1
        forbidden.append(api_key)

        admin=os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        pins=load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        lightsail=boto3.client("lightsail",region_name=REGION)
        instance=lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static=lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip=static.get("ipAddress")
        if (
          instance.get("blueprintId")!="ubuntu_24_04"
          or instance.get("bundleId")!="small_3_0"
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
        lightsail.open_instance_public_ports(
          instanceName=INSTANCE_NAME,
          portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"]=True

        known=scan_host(ip,pins)
        access=lightsail.get_instance_access_details(instanceName=INSTANCE_NAME,protocol="ssh")["accessDetails"]
        private_key=access.get("privateKey"); cert_key=access.get("certKey"); username=access.get("username")
        if not all(isinstance(v,str) and v for v in (private_key,cert_key,username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key,cert_key])

        temp=Path(tempfile.mkdtemp(prefix="quizforge-ai-activate-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)
        ssh_context=(key,cert,hosts,username,ip)

        subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","install","-m","0600","-o","root","-g","root","/dev/null","/etc/quizforge/openai-api-key.pending"),
          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=True,
        )
        subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","tee","/etc/quizforge/openai-api-key.pending"),
          input=api_key+"\n",text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=True,
        )

        report["paid_model_request_attempted"]=True
        subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s","--",
                      str(DAILY_REQUESTS),str(MONTHLY_REQUESTS),str(APPROVED_MONTHLY_NANO_USD),
                      PRICING_KEY,PRICING_VALID_UNTIL,str(CANARY_MAX_OUTPUT_TOKENS)),
          input=REMOTE_ACTIVATE,text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
          timeout=420,check=True,
        )
        # REMOTE_ACTIVATE itself asserts the exact persisted policy, verifies a
        # paid HTTP 200 canary, and requires the public systemd service to remain
        # active. A zero exit status is therefore the guarded acceptance signal;
        # do not depend on parsing SSH stdout from a secret-bearing operation.
        report.update({
          "ai_enabled":True,
          "monthly_budget_usd":5,
          "daily_request_limit":DAILY_REQUESTS,
          "monthly_request_limit":MONTHLY_REQUESTS,
          "paid_canary_status":200,
          "public_service_remains_active":True,
        })
        report["result"]="ai_enabled_paid_canary_passed_usd5_budget"
    except ClientError as error:
        report["error_code"]="AWS_ACTIVATION_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_AI_ACTIVATION_FAILED"
        report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="AI_ACTIVATION_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_AI_ACTIVATION_FAILED")
    finally:
        if report.get("result")!="ai_enabled_paid_canary_passed_usd5_budget" and ssh_context:
            report["rollback_attempted"]=True
            key,cert,hosts,username,ip=ssh_context
            try:
                subprocess.run(
                  ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s"),
                  input=REMOTE_DISABLE,text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                  timeout=180,check=True,
                )
                report["rollback_disabled_ai"]=True
            except Exception as error:
                report["rollback_error_code"]=safe_code(type(error).__name__,"PRIVATE_AI_ROLLBACK_FAILED")

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
                report["cleanup_error_code"]=safe_code(type(error).__name__,"PRIVATE_FIREWALL_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        if report.get("result")=="ai_enabled_paid_canary_passed_usd5_budget" and not report.get("baseline_firewall_restored"):
            report["result"]="ai_enabled_firewall_cleanup_unverified"
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)

    return 0 if report.get("result")=="ai_enabled_paid_canary_passed_usd5_budget" else 1


if __name__=="__main__":
    raise SystemExit(main())
