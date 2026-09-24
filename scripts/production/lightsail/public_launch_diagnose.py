"""Read-only diagnostic for a rolled-back permanent Lightsail launch failure."""
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
RESULT = Path("lightsail-public-launch-diagnostic/summary.json")

REMOTE_DIAG = r"""set -euo pipefail
compose=/opt/quizforge/current/compose.json
test -s "$compose"

python3 - "$compose" <<'PY'
import json, subprocess, sys

compose=sys.argv[1]

def text(*args):
    p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    return p.stdout.strip() if p.returncode==0 else ""

service_active=subprocess.run(["systemctl","is-active","--quiet","quizforge.service"]).returncode==0
service_enabled=subprocess.run(["systemctl","is-enabled","--quiet","quizforge.service"]).returncode==0
show=text("systemctl","show","quizforge.service","--property=Result,ExecMainStatus,ActiveState,SubState","--value").splitlines()
systemd={
    "active": service_active,
    "enabled": service_enabled,
    "launch_marker_present": subprocess.run(["test","-e","/etc/quizforge/launch-approved"]).returncode==0,
}
keys=("Result","ExecMainStatus","ActiveState","SubState")
for key,value in zip(keys,show):
    value=value.strip()
    if key=="ExecMainStatus":
        try: systemd[key]=int(value)
        except ValueError: systemd[key]=-1
    elif value and len(value)<=40 and all(c.isalnum() or c in "._-" for c in value):
        systemd[key]=value
    else:
        systemd[key]="unknown"

def signals(value):
    low=value.lower()
    checks={
        "traceback": "traceback" in low,
        "module_error": "modulenotfounderror" in low or "importerror" in low,
        "permission_error": "permission denied" in low or "permissionerror" in low,
        "db_connection_error": "operationalerror" in low or "connection refused" in low or "password authentication failed" in low,
        "tls_error": "certificate verify failed" in low or "ssl error" in low,
        "address_in_use": "address already in use" in low,
        "oom_signal": "out of memory" in low or "oom" in low or "killed" in low,
        "no_space": "no space left" in low,
        "uvicorn_started": "uvicorn running" in low or "application startup complete" in low,
        "caddy_error": "caddy" in low and ("error" in low or "failed" in low),
    }
    return sorted(name for name,hit in checks.items() if hit)

services={}
ids=text("docker","compose","-f",compose,"ps","-a","-q").splitlines()
for cid in ids:
    raw=text("docker","inspect","--format",
        '{{json .Config.Labels}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        cid)
    if not raw or "|" not in raw:
        continue
    labels_raw,status,exit_code,oom,health=raw.split("|",4)
    try:
        labels=json.loads(labels_raw)
    except Exception:
        continue
    name=labels.get("com.docker.compose.service")
    if name not in {"api","identity","guard","db","redis","web"}:
        continue
    log_text=text("docker","logs","--tail","200",cid)
    health_raw=text("docker","inspect","--format",'{{if .State.Health}}{{json .State.Health.Log}}{{else}}[]{{end}}',cid)
    health_signals=[]
    try:
        for item in json.loads(health_raw or "[]")[-3:]:
            if isinstance(item,dict):
                health_signals.extend(signals(str(item.get("Output",""))))
    except Exception:
        pass
    services[name]={
        "status": status if status in {"created","running","paused","restarting","removing","exited","dead"} else "unknown",
        "exit_code": int(exit_code) if exit_code.isdigit() else -1,
        "oom_killed": oom.lower()=="true",
        "health": health if health in {"none","starting","healthy","unhealthy"} else "unknown",
        "log_signals": signals(log_text),
        "health_signals": sorted(set(health_signals)),
    }

print("QF_RESULT="+json.dumps({
    "systemd": systemd,
    "services": services,
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
            raise ValueError("private value reached launch diagnostic")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached launch diagnostic")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
        "schema":1,
        "operation":"lightsail_public_launch_failure_diagnostic",
        "result":"diagnostic_failed",
        "changes_performed":False,
        "temporary_ssh_rule_opened":False,
        "temporary_ssh_rule_closed":False,
        "baseline_firewall_restored":False,
    }
    forbidden=[]
    runner=None
    lightsail=None
    temp=None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
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

        temp=Path(tempfile.mkdtemp(prefix="quizforge-launch-diag-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)

        completed=subprocess.run(
            ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s"),
            input=REMOTE_DIAG,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            timeout=90,check=True,
        )
        values=[line.removeprefix("QF_RESULT=") for line in completed.stdout.splitlines() if line.startswith("QF_RESULT=")]
        if len(values)!=1:
            raise ValueError("unexpected diagnostic output")
        state=json.loads(values[0])
        if not isinstance(state.get("systemd"),dict) or not isinstance(state.get("services"),dict):
            raise ValueError("invalid diagnostic state")
        report["diagnostic"]=state
        report["result"]="diagnostic_complete_no_changes"
    except ClientError as error:
        report["error_code"]="AWS_DIAGNOSTIC_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_DIAGNOSTIC_FAILED"
        report["remote_return_code"]=error.returncode
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
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="diagnostic_complete_no_changes" else 1


if __name__=="__main__":
    raise SystemExit(main())
