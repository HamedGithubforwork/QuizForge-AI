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
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service

application_state="clean"
if [ -e /opt/quizforge/current ] || [ -e /opt/quizforge/frontend ]; then
    test -L /opt/quizforge/current
    test -s /opt/quizforge/current/compose.json
    test -s /opt/quizforge/frontend/index.html
    release_target="$(readlink -f /opt/quizforge/current)"
    case "$release_target" in
        /opt/quizforge/releases/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
            ;;
        *)
            exit 52
            ;;
    esac
    application_state="staged"
fi

sudo -n /usr/sbin/sshd -t

sshd_effective="$(sudo -n /usr/sbin/sshd -T)"
printf '%s\n' "$sshd_effective" | grep -qx 'passwordauthentication no'
printf '%s\n' "$sshd_effective" | grep -qx 'permitrootlogin no'
printf '%s\n' "$sshd_effective" | grep -qx 'allowtcpforwarding no'

expected_daemon='{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"},"exec-opts":["native.cgroupdriver=systemd"]}'

if [ -e /var/lib/quizforge/base-host-ready ]; then
    command -v docker >/dev/null 2>&1
    systemctl is-active --quiet docker
    test "$(sudo cat /etc/docker/daemon.json)" = "$expected_daemon"
else
    if ! command -v docker >/dev/null 2>&1; then
        sudo install -d -m 0755 /etc/docker
        printf '%s\n' "$expected_daemon" | sudo tee /etc/docker/daemon.json >/dev/null

        sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null

        docker_candidate="$(apt-cache policy docker.io | awk '/Candidate:/ && !found {print $2; found=1}')"
        compose_candidate="$(apt-cache policy docker-compose-v2 | awk '/Candidate:/ && !found {print $2; found=1}')"
        test -n "$docker_candidate"
        test "$docker_candidate" != "(none)"
        test -n "$compose_candidate"
        test "$compose_candidate" != "(none)"
        dpkg --compare-versions "$compose_candidate" ge "2.30"

        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
          docker.io docker-compose-v2 unattended-upgrades >/dev/null
    else
        dpkg-query -W -f='${Status}\n' docker.io | grep -qx 'install ok installed'
        dpkg-query -W -f='${Status}\n' docker-compose-v2 | grep -qx 'install ok installed'
        test "$(sudo cat /etc/docker/daemon.json)" = "$expected_daemon"
    fi

    sudo swapoff -a
    sudo systemctl enable --now docker
fi

docker_version="$(sudo docker version --format '{{.Server.Version}}')"
compose_version="$(sudo docker compose version --short)"
test -n "$docker_version"
test -n "$compose_version"
dpkg --compare-versions "$compose_version" ge "2.30"
test "$(stat -fc %T /sys/fs/cgroup)" = "cgroup2fs"
test -z "$(swapon --noheadings)"
sudo test "$(stat -c %a /etc/quizforge)" = "700"
sudo test "$(stat -c %a /var/lib/quizforge)" = "700"
systemctl is-active --quiet docker

sudo touch /var/lib/quizforge/base-host-ready
sudo test -f /var/lib/quizforge/base-host-ready
test ! -e /etc/quizforge/launch-approved
! systemctl is-active --quiet quizforge.service
! systemctl is-enabled --quiet quizforge.service
if [ "$application_state" = "staged" ]; then
    test -L /opt/quizforge/current
    test -s /opt/quizforge/current/compose.json
    test -s /opt/quizforge/frontend/index.html
else
    test ! -e /opt/quizforge/current
    test ! -e /opt/quizforge/frontend
fi

python3 - "$docker_version" "$compose_version" "$application_state" <<'PY'
import json,re,sys
docker,compose,application_state=sys.argv[1:4]
safe=r"^[A-Za-z0-9._+~-]{1,80}$"
assert re.fullmatch(safe,docker)
assert re.fullmatch(safe,compose)
value={
    "base_host_ready": True,
    "docker_active": True,
    "docker_version": docker,
    "compose_version": compose,
    "compose_2_30_or_newer": True,
    "cgroup_v2": True,
    "swap_disabled": True,
    "application_still_inactive": True,
    "application_state": application_state,
}
print("QF_RESULT="+json.dumps(value,sort_keys=True))
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
        results=[
            line.removeprefix("QF_RESULT=")
            for line in completed.stdout.splitlines()
            if line.startswith("QF_RESULT=")
        ]
        if len(results)!=1:
            raise ValueError("unexpected repair result output")
        after_state=json.loads(results[0])
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
