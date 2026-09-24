"""Read-only root-cause diagnostic for incomplete Lightsail base-host bootstrap."""
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

REGION = "ca-central-1"
RESULT = Path("lightsail-bootstrap-diagnostic/summary.json")

REMOTE = r"""set -eu
python3 - <<'PY'
import json, os, re, subprocess

def run(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def text(*args):
    p=run(*args)
    return p.stdout.strip() if p.returncode == 0 else ""

def unit(name):
    active=text("systemctl","show",name,"--property=ActiveState","--value")
    sub=text("systemctl","show",name,"--property=SubState","--value")
    result=text("systemctl","show",name,"--property=Result","--value")
    status=text("systemctl","show",name,"--property=ExecMainStatus","--value")
    return {"active":active,"sub":sub,"result":result,"exec_status":status}

def pkg(name):
    installed=run("dpkg-query","-W","-f=${Status}\n${Version}\n",name)
    version=""
    is_installed=False
    if installed.returncode==0:
        parts=installed.stdout.splitlines()
        is_installed=bool(parts and parts[0].strip()=="install ok installed")
        version=parts[1].strip() if len(parts)>1 else ""
    candidate=""
    policy=text("apt-cache","policy",name)
    for line in policy.splitlines():
        if line.strip().startswith("Candidate:"):
            candidate=line.split(":",1)[1].strip()
            break
    return {
        "installed":is_installed,
        "version": version if re.fullmatch(r"[A-Za-z0-9.+:~_-]{1,100}",version) else "",
        "candidate_available": bool(candidate and candidate!="(none)"),
        "candidate": candidate if re.fullmatch(r"[A-Za-z0-9.+:~_-]{1,100}",candidate) else "",
    }

log=""
for path in ("/var/log/cloud-init-output.log","/var/log/cloud-init.log"):
    try:
        with open(path,encoding="utf-8",errors="replace") as handle:
            log += "\n" + handle.read()[-200000:]
    except OSError:
        pass
lower=log.lower()
checks={
    "docker_compose_v2_missing": ("unable to locate package docker-compose-v2" in lower),
    "docker_io_missing": ("unable to locate package docker.io" in lower),
    "apt_dns_failure": ("temporary failure resolving" in lower or "could not resolve" in lower),
    "apt_fetch_failure": ("failed to fetch" in lower),
    "apt_lock_failure": ("could not get lock" in lower or "unable to acquire the dpkg frontend lock" in lower),
    "disk_full": ("no space left on device" in lower),
    "docker_service_failure": ("failed to start docker" in lower or "docker.service: failed" in lower),
    "bootstrap_shell_exit_error": ("scripts-user failed" in lower or "failed to run module scripts-user" in lower),
}
hints=[k for k,v in checks.items() if v]

status_json={}
try:
    p=subprocess.run(["cloud-init","status","--format","json"],text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
    if p.stdout.strip():
        raw=json.loads(p.stdout)
        status_json={
            "status": raw.get("status"),
            "extended_status": raw.get("extended_status"),
            "boot_status_code": raw.get("boot_status_code"),
            "recoverable_error_count": len(raw.get("recoverable_errors") or {}),
            "error_count": len(raw.get("errors") or []),
        }
except Exception:
    status_json={"status":"unavailable"}

result={
    "base_host_ready": os.path.isfile("/var/lib/quizforge/base-host-ready"),
    "boot_finished": os.path.isfile("/var/lib/cloud/instance/boot-finished"),
    "cloud_init": status_json,
    "cloud_final": unit("cloud-final.service"),
    "docker_unit": unit("docker.service"),
    "docker_io": pkg("docker.io"),
    "docker_compose_v2": pkg("docker-compose-v2"),
    "docker_compose_plugin": pkg("docker-compose-plugin"),
    "unattended_upgrades": pkg("unattended-upgrades"),
    "docker_binary_present": bool(text("sh","-lc","command -v docker")),
    "compose_command_present": run("docker","compose","version").returncode==0,
    "daemon_json_present": os.path.isfile("/etc/docker/daemon.json"),
    "bootstrap_failure_hints": hints,
}
print(json.dumps(result,sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str="UNKNOWN") -> str:
    s=str(value or "")
    return s if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}",s) else fallback


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value leak")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP leak")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
        "schema":1,
        "operation":"lightsail_bootstrap_root_cause",
        "result":"diagnostic_failed",
        "temporary_ssh_rule_opened":False,
        "temporary_ssh_rule_closed":False,
        "baseline_firewall_restored":False,
        "changes_performed":False,
    }
    forbidden=[]
    runner=None
    lightsail=None
    temp=None
    try:
        admin=os.environ["LIGHTSAIL_ADMIN_IPV4_CIDR"]
        pins=load_pins(Path("scripts/production/lightsail/ssh-host-pins.json"))
        lightsail=boto3.client("lightsail",region_name=REGION)
        instance=lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static=lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        ip=static.get("ipAddress")
        if static.get("attachedTo")!=INSTANCE_NAME or not isinstance(ip,str):
            raise ValueError("live contract mismatch")
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
        report["changes_performed"]=True
        report["temporary_ssh_rule_opened"]=True

        observed=scan_host(ip,pins)
        access=lightsail.get_instance_access_details(instanceName=INSTANCE_NAME,protocol="ssh")["accessDetails"]
        private_key=access.get("privateKey"); cert_key=access.get("certKey"); username=access.get("username")
        if not all(isinstance(v,str) and v for v in (private_key,cert_key,username)):
            raise ValueError("temporary SSH access incomplete")
        forbidden.extend([private_key,cert_key])

        temp=Path(tempfile.mkdtemp(prefix="quizforge-bootstrap-diag-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; known=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        known.write_text(observed); known.chmod(0o600)

        cmd=ssh_command(key,cert,known,username,ip,"bash","-s")
        completed=subprocess.run(cmd,input=REMOTE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,check=True)
        lines=[x for x in completed.stdout.splitlines() if x.strip()]
        if len(lines)!=1:
            raise ValueError("unexpected remote output")
        remote=json.loads(lines[0])
        report["host"]=remote
        report["result"]="diagnostic_completed"
    except ClientError as error:
        report["error_code"]="AWS_READ_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="SSH_DIAGNOSTIC_FAILED"
        report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="SSH_DIAGNOSTIC_TIMEOUT"
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
        if report.get("result")=="diagnostic_completed" and not report.get("baseline_firewall_restored"):
            report["result"]="diagnostic_completed_cleanup_unverified"
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="diagnostic_completed" else 1


if __name__=="__main__":
    raise SystemExit(main())
