"""Guarded repair for the incomplete secret-free Lightsail base-host bootstrap."""
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
RESULT = Path("lightsail-base-host-repair/summary.json")

REMOTE_REPAIR = r"""set -euo pipefail
python3 - <<'PY'
import json, os, subprocess

def run(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def text(*args):
    p=run(*args)
    return p.stdout.strip() if p.returncode == 0 else ""

sshd=text("sudo","-n","/usr/sbin/sshd","-T")
settings={}
for line in sshd.splitlines():
    parts=line.split(None,1)
    if len(parts)==2:
        settings[parts[0].lower()]=parts[1].strip().lower()

before={
    "base_host_ready": os.path.isfile("/var/lib/quizforge/base-host-ready"),
    "docker_binary_present": bool(text("sh","-lc","command -v docker")),
    "docker_active": run("systemctl","is-active","--quiet","docker").returncode==0,
    "current_release_present": os.path.lexists("/opt/quizforge/current"),
    "frontend_present": os.path.lexists("/opt/quizforge/frontend"),
    "launch_marker_present": os.path.exists("/etc/quizforge/launch-approved"),
    "ssh_password_disabled": settings.get("passwordauthentication")=="no",
    "ssh_root_disabled": settings.get("permitrootlogin")=="no",
    "ssh_forwarding_disabled": settings.get("allowtcpforwarding")=="no",
}
print(json.dumps(before,sort_keys=True))
PY

test ! -e /var/lib/quizforge/base-host-ready
test ! -e /opt/quizforge/current
test ! -e /opt/quizforge/frontend
test ! -e /etc/quizforge/launch-approved
! command -v docker >/dev/null 2>&1
! systemctl is-active --quiet docker
sudo -n /usr/sbin/sshd -t

sudo install -d -m 0755 /etc/docker
printf '%s\n' '{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"},"exec-opts":["native.cgroupdriver=systemd"]}' \
  | sudo tee /etc/docker/daemon.json >/dev/null

sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq

docker_candidate="$(apt-cache policy docker.io | awk '/Candidate:/ {print $2; exit}')"
compose_candidate="$(apt-cache policy docker-compose-v2 | awk '/Candidate:/ {print $2; exit}')"
test -n "$docker_candidate"
test "$docker_candidate" != "(none)"
test -n "$compose_candidate"
test "$compose_candidate" != "(none)"
dpkg --compare-versions "$compose_candidate" ge "2.30"

sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  docker.io docker-compose-v2 unattended-upgrades

sudo swapoff -a
sudo systemctl enable --now docker

docker_version="$(sudo docker version --format '{{.Server.Version}}')"
compose_version="$(sudo docker compose version --short)"
test -n "$docker_version"
test -n "$compose_version"
dpkg --compare-versions "$compose_version" ge "2.30"
test "$(stat -fc %T /sys/fs/cgroup)" = "cgroup2fs"
test -z "$(swapon --noheadings)"
sudo test "$(stat -c %a /etc/quizforge)" = "700"
sudo test "$(stat -c %a /var/lib/quizforge)" = "700"

sudo touch /var/lib/quizforge/base-host-ready

python3 - "$docker_version" "$compose_version" <<'PY'
import json,re,sys
docker,compose=sys.argv[1:3]
safe=r"^[A-Za-z0-9._+~-]{1,80}$"
assert re.fullmatch(safe,docker)
assert re.fullmatch(safe,compose)
print(json.dumps({
    "base_host_ready": True,
    "docker_active": True,
    "docker_version": docker,
    "compose_version": compose,
    "compose_2_30_or_newer": True,
    "cgroup_v2": True,
    "swap_disabled": True,
    "application_still_inactive": True,
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
        "operation":"lightsail_base_host_bootstrap_repair",
        "result":"repair_failed",
        "repair_attempted":False,
        "temporary_ssh_rule_opened":False,
        "temporary_ssh_rule_closed":False,
        "baseline_firewall_restored":False,
        "application_launch_attempted":False,
        "dns_changes_performed":False,
        "ai_enabled":False,
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

        temp=Path(tempfile.mkdtemp(prefix="quizforge-base-repair-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)

        cmd=ssh_command(key,cert,hosts,username,ip,"bash","-s")
        report["repair_attempted"]=True
        completed=subprocess.run(
            cmd,input=REMOTE_REPAIR,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            timeout=900,check=True,
        )
        lines=[line for line in completed.stdout.splitlines() if line.strip()]
        if len(lines)!=2:
            raise ValueError("unexpected repair output")
        before_state=json.loads(lines[0])
        after_state=json.loads(lines[1])
        if not (
            before_state.get("base_host_ready") is False
            and before_state.get("docker_binary_present") is False
            and before_state.get("docker_active") is False
            and before_state.get("current_release_present") is False
            and before_state.get("frontend_present") is False
            and before_state.get("launch_marker_present") is False
            and before_state.get("ssh_password_disabled") is True
            and before_state.get("ssh_root_disabled") is True
            and before_state.get("ssh_forwarding_disabled") is True
        ):
            raise ValueError("pre-repair host state was not exact")
        if not all(after_state.get(k) is True for k in (
            "base_host_ready","docker_active","compose_2_30_or_newer",
            "cgroup_v2","swap_disabled","application_still_inactive",
        )):
            raise ValueError("post-repair host state incomplete")
        report["host"]=after_state
        report["result"]="base_host_repaired_application_inactive"
    except ClientError as error:
        report["error_code"]="AWS_REPAIR_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_REPAIR_COMMAND_FAILED"
        report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="REMOTE_REPAIR_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_REPAIR_FAILED")
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
        if report.get("result")=="base_host_repaired_application_inactive" and not report.get("baseline_firewall_restored"):
            report["result"]="base_host_repaired_firewall_cleanup_unverified"
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="base_host_repaired_application_inactive" else 1


if __name__=="__main__":
    raise SystemExit(main())
