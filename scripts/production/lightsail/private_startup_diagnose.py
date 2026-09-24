"""Private staged-service startup diagnostic for the permanent Lightsail host.

Starts the already-initialized stack in bounded phases without creating the launch
marker, enabling systemd, changing DNS, or enabling AI. Captures only service
state/health and bounded error classifications, then stops all containers.
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
    INSTANCE_NAME, STATIC_IP_NAME, baseline_ports, normalized_ports,
    load_pins, scan_host, runner_ipv4, ssh_command,
)

REGION="ca-central-1"
RESULT=Path("lightsail-private-startup-diagnostic/summary.json")

REMOTE=r"""set -euo pipefail
compose=/opt/quizforge/current/compose.json
test -f /var/lib/quizforge/base-host-ready
test -f /etc/quizforge/database-initialized
test -s "$compose"
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service
grep -q '^OPENAI_API_KEY=disabled-until-explicit-activation-' /etc/quizforge/generation.env
test -z "$(docker compose -f "$compose" ps --status running -q)"

cleanup() {
  docker compose -f "$compose" stop --timeout 30 web guard api identity db redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

python_state() {
  stage="$1"
  python3 - "$compose" "$stage" <<'PY'
import json,subprocess,sys
compose,stage=sys.argv[1:3]

def run(*args):
    return subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)

def text(*args):
    p=run(*args)
    return p.stdout.strip()

def signals(raw):
    low=raw.lower()
    tests={
      "traceback":"traceback" in low,
      "module_error":"modulenotfounderror" in low or "importerror" in low,
      "permission_error":"permission denied" in low or "permissionerror" in low,
      "db_connection_error":"operationalerror" in low or "connection refused" in low or "connectionrefusederror" in low or "password authentication failed" in low,
      "tls_error":"certificate verify failed" in low or "ssl error" in low,
      "address_in_use":"address already in use" in low,
      "oom_signal":"out of memory" in low or "oom" in low or "killed" in low,
      "no_space":"no space left" in low,
      "uvicorn_started":"uvicorn running" in low or "application startup complete" in low,
      "caddy_error":"caddy" in low and ("error" in low or "failed" in low),
      "acme_error":"acme" in low and ("error" in low or "failed" in low or "challenge" in low),
      "certificate_error":"certificate" in low and ("error" in low or "failed" in low),
    }
    return sorted(k for k,v in tests.items() if v)

services={}
ids=text("docker","compose","-f",compose,"ps","-a","-q").splitlines()
for cid in ids:
    meta=text("docker","inspect","--format",
      '{{json .Config.Labels}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      cid)
    if not meta or "|" not in meta:
        continue
    labels_raw,status,exit_code,oom,health=meta.split("|",4)
    try: labels=json.loads(labels_raw)
    except Exception: continue
    name=labels.get("com.docker.compose.service")
    if name not in {"api","identity","guard","db","redis","web"}:
        continue
    logs=text("docker","logs","--tail","200",cid)
    health_raw=text("docker","inspect","--format",'{{if .State.Health}}{{json .State.Health.Log}}{{else}}[]{{end}}',cid)
    health_signals=[]
    try:
        for item in json.loads(health_raw or "[]")[-5:]:
            if isinstance(item,dict):
                health_signals.extend(signals(str(item.get("Output",""))))
    except Exception:
        pass
    services[name]={
      "status":status if status in {"created","running","paused","restarting","removing","exited","dead"} else "unknown",
      "exit_code":int(exit_code) if exit_code.isdigit() else -1,
      "oom_killed":oom.lower()=="true",
      "health":health if health in {"none","starting","healthy","unhealthy"} else "unknown",
      "log_signals":signals(logs),
      "health_signals":sorted(set(health_signals)),
    }
print("QF_STAGE="+json.dumps({"stage":stage,"services":services},sort_keys=True))
PY
}

wait_health() {
  service="$1"; timeout="$2"; elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "quizforge-production-$service-1" 2>/dev/null || true)"
    case "$status" in healthy|running) return 0;; unhealthy|exited|dead) return 1;; esac
    sleep 2; elapsed=$((elapsed+2))
  done
  return 2
}

docker compose -f "$compose" up -d db redis >/dev/null
infra_ok=true
wait_health db 90 || infra_ok=false
wait_health redis 90 || infra_ok=false
python_state infra

app_ok=true
if [ "$infra_ok" = true ]; then
  docker compose -f "$compose" up -d api identity guard >/dev/null
  wait_health api 90 || app_ok=false
  wait_health identity 90 || app_ok=false
else
  app_ok=false
fi
python_state app

web_ok=true
if [ "$app_ok" = true ]; then
  set +e
  docker compose -f "$compose" up -d web >/dev/null 2>&1
  web_up=$?
  set -e
  [ "$web_up" -eq 0 ] || web_ok=false
  if [ "$web_ok" = true ]; then
    sleep 15
    docker inspect quizforge-production-web-1 >/dev/null 2>&1 || web_ok=false
    [ "$(docker inspect --format '{{.State.Status}}' quizforge-production-web-1 2>/dev/null || true)" = running ] || web_ok=false
  fi
else
  web_ok=false
fi
python_state web

cleanup
trap - EXIT
test -z "$(docker compose -f "$compose" ps --status running -q)"

python3 - "$infra_ok" "$app_ok" "$web_ok" <<'PY'
import json,sys
print("QF_RESULT="+json.dumps({
  "infra_phase_ok":sys.argv[1]=="true",
  "app_phase_ok":sys.argv[2]=="true",
  "web_phase_ok":sys.argv[3]=="true",
  "containers_stopped_after_diagnostic":True,
  "launch_marker_absent":True,
  "systemd_service_inactive":True,
  "systemd_service_disabled":True,
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
            raise ValueError("private value reached startup diagnostic")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached startup diagnostic")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
      "schema":1,
      "operation":"lightsail_private_startup_sequence_diagnostic",
      "result":"diagnostic_failed",
      "dns_changes_performed":False,
      "launch_marker_created":False,
      "systemd_enabled":False,
      "ai_enabled":False,
      "temporary_ssh_rule_opened":False,
      "temporary_ssh_rule_closed":False,
      "baseline_firewall_restored":False,
    }
    forbidden=[]; lightsail=None; runner=None; temp=None
    try:
        if boto3 is None: raise RuntimeError("AWS SDK missing")
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
        ): raise ValueError("live instance contract mismatch")
        forbidden.extend([ip,admin])
        before=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
        if normalized_ports(before)!=baseline_ports(admin): raise ValueError("baseline firewall mismatch")

        runner=runner_ipv4(); forbidden.append(runner)
        lightsail.open_instance_public_ports(
          instanceName=INSTANCE_NAME,
          portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"]=True
        known=scan_host(ip,pins)
        access=lightsail.get_instance_access_details(instanceName=INSTANCE_NAME,protocol="ssh")["accessDetails"]
        private_key=access.get("privateKey"); cert_key=access.get("certKey"); username=access.get("username")
        if not all(isinstance(v,str) and v for v in (private_key,cert_key,username)): raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key,cert_key])
        temp=Path(tempfile.mkdtemp(prefix="quizforge-startup-diag-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)
        completed=subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s"),
          input=REMOTE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=420,check=True,
        )
        stages=[]
        final=[]
        for line in completed.stdout.splitlines():
            if line.startswith("QF_STAGE="): stages.append(json.loads(line.removeprefix("QF_STAGE=")))
            elif line.startswith("QF_RESULT="): final.append(json.loads(line.removeprefix("QF_RESULT=")))
        if len(stages)!=3 or len(final)!=1: raise ValueError("unexpected diagnostic output")
        report["stages"]=stages
        report["final"]=final[0]
        report["result"]="diagnostic_complete_services_stopped"
    except ClientError as error:
        report["error_code"]="AWS_DIAGNOSTIC_FAILED"; report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_DIAGNOSTIC_FAILED"; report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="REMOTE_DIAGNOSTIC_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_DIAGNOSTIC_FAILED")
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
            for child in temp.iterdir(): child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="diagnostic_complete_services_stopped" else 1

if __name__=="__main__":
    raise SystemExit(main())
