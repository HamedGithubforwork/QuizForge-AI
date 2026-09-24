"""Guarded inactive application staging onto the permanent Lightsail host.

The workflow prepares a reviewed bundle before opening SSH. This script then:
- verifies the exact baseline firewall,
- temporarily opens SSH only to the current runner /32,
- verifies the server host key against the pinned two-vantage fingerprints,
- uses AWS temporary Lightsail SSH credentials,
- checks the base host is ready and still application-clean,
- pulls only digest-pinned reviewed images,
- installs the release, frontend and inactive systemd units,
- never creates the launch marker or starts QuizForge,
- closes the temporary SSH rule and proves the baseline firewall is restored.

No IP addresses, SSH material, ECR token, Cognito IDs, account IDs or private
configuration are emitted in the public summary.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
from typing import Any, Mapping

try:
    import boto3
    from botocore.exceptions import ClientError
except ModuleNotFoundError:
    boto3 = None

    class ClientError(Exception):
        response: dict[str, Any] = {}

REGION = "ca-central-1"
INSTANCE_NAME = "quizforge-production-lightsail-server"
STATIC_IP_NAME = "quizforge-production-lightsail"
RESULT = Path("lightsail-app-stage-results/summary.json")
RELEASE_RE = re.compile(r"^[0-9a-f]{40}$")
FP_RE = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
IMAGE_RE = re.compile(
    r"^(?:[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api|"
    r"docker\.io/library/(?:postgres|redis))@sha256:[a-f0-9]{64}$"
)

REMOTE_PREFLIGHT = r"""set -eu
python3 - <<'PY'
import json, os, re, subprocess

def run(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

def text(*args):
    p=run(*args)
    return p.stdout.strip() if p.returncode == 0 else ""

def ver(value):
    m=re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?", value or "")
    return tuple(int(x or 0) for x in m.groups()) if m else ()

os_release={}
try:
    for line in open("/etc/os-release", encoding="utf-8"):
        if "=" in line:
            k,v=line.rstrip().split("=",1)
            os_release[k]=v.strip('"')
except OSError:
    pass

docker=text("sudo","-n","docker","version","--format","{{.Server.Version}}")
compose=text("sudo","-n","docker","compose","version","--short")
sshd=text("sudo","-n","/usr/sbin/sshd","-T")

def package_installed(name):
    return run("dpkg-query","-W","-f=\${Status}",name).stdout.strip()=="install ok installed"

def candidate(name):
    value=text("apt-cache","policy",name)
    for line in value.splitlines():
        line=line.strip()
        if line.startswith("Candidate:"):
            result=line.split(":",1)[1].strip()
            return result if re.fullmatch(r"[A-Za-z0-9.+:~_-]{1,80}",result) else "invalid"
    return "none"

cloud_status="unknown"
cloud_extended="unknown"
cloud_errors=-1
cloud_recoverable=-1
cloud=text("cloud-init","status","--format","json")
if cloud:
    try:
        value=json.loads(cloud)
        status=value.get("status")
        extended=value.get("extended_status")
        if isinstance(status,str) and re.fullmatch(r"[a-z_-]{1,40}",status):
            cloud_status=status
        if isinstance(extended,str) and re.fullmatch(r"[a-z_ -]{1,80}",extended):
            cloud_extended=extended
        errors=value.get("errors")
        recoverable=value.get("recoverable_errors")
        cloud_errors=len(errors) if isinstance(errors,list) else 0
        cloud_recoverable=sum(len(v) for v in recoverable.values()) if isinstance(recoverable,dict) else 0
    except Exception:
        pass
settings={}
for line in sshd.splitlines():
    parts=line.split(None,1)
    if len(parts)==2:
        settings[parts[0].lower()]=parts[1].strip().lower()
stat=os.statvfs("/")
free_gib=int((stat.f_bavail*stat.f_frsize)/(1024**3))
result={
 "base_host_ready": os.path.isfile("/var/lib/quizforge/base-host-ready"),
 "ubuntu_24_04": os_release.get("ID")=="ubuntu" and os_release.get("VERSION_ID")=="24.04",
 "sudo_noninteractive": run("sudo","-n","true").returncode==0,
 "docker_active": run("systemctl","is-active","--quiet","docker").returncode==0,
 "docker_version": docker,
 "compose_version": compose,
 "compose_ok": ver(compose)>=(2,30,0),
 "cgroup_v2": text("stat","-fc","%T","/sys/fs/cgroup")=="cgroup2fs",
 "swap_disabled": text("swapon","--noheadings")=="",
 "etc_private": oct(os.stat("/etc/quizforge").st_mode & 0o777)=="0o700",
 "var_private": oct(os.stat("/var/lib/quizforge").st_mode & 0o777)=="0o700",
 "current_release_absent": not os.path.lexists("/opt/quizforge/current"),
 "frontend_absent": not os.path.lexists("/opt/quizforge/frontend"),
 "launch_marker_absent": not os.path.exists("/etc/quizforge/launch-approved"),
 "service_inactive": run("systemctl","is-active","--quiet","quizforge.service").returncode!=0,
 "ssh_password_disabled": settings.get("passwordauthentication")=="no",
 "ssh_root_disabled": settings.get("permitrootlogin")=="no",
 "ssh_forwarding_disabled": settings.get("allowtcpforwarding")=="no",
 "disk_free_gib": free_gib,
 "cloud_boot_finished": os.path.isfile("/var/lib/cloud/instance/boot-finished"),
 "cloud_status": cloud_status,
 "cloud_extended_status": cloud_extended,
 "cloud_error_count": cloud_errors,
 "cloud_recoverable_error_count": cloud_recoverable,
 "docker_io_installed": package_installed("docker.io"),
 "docker_compose_v2_installed": package_installed("docker-compose-v2"),
 "docker_compose_plugin_installed": package_installed("docker-compose-plugin"),
 "docker_compose_legacy_installed": package_installed("docker-compose"),
 "docker_io_candidate": candidate("docker.io"),
 "docker_compose_v2_candidate": candidate("docker-compose-v2"),
 "docker_compose_plugin_candidate": candidate("docker-compose-plugin"),
 "docker_daemon_config_present": os.path.isfile("/etc/docker/daemon.json")
}
print(json.dumps(result,sort_keys=True))
PY
"""

REMOTE_STAGE = r"""set -euo pipefail
release_sha="$1"
archive="$2"
case "$release_sha" in
  *[!0-9a-f]*|'') exit 31 ;;
esac
[ "$(printf %s "$release_sha" | wc -c)" -eq 40 ] || exit 32
[ ! -e /opt/quizforge/current ] || exit 33
[ ! -e /opt/quizforge/frontend ] || exit 34
[ ! -e /etc/quizforge/launch-approved ] || exit 35
! systemctl is-active --quiet quizforge.service || exit 36
final="/opt/quizforge/releases/$release_sha"
stage="/opt/quizforge/releases/.staging-$release_sha"
frontend_stage="/opt/quizforge/.frontend-staging-$release_sha"
[ ! -e "$final" ] || exit 37
sudo rm -rf "$stage" "$frontend_stage"
sudo install -d -m 0755 /opt/quizforge/releases
sudo install -d -m 0700 "$stage"
sudo install -d -m 0755 "$frontend_stage"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
python3 - "$work/manifest.json" "$release_sha" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
assert value.get("schema")==1
assert value.get("release_sha")==sys.argv[2]
assert re.fullmatch(r"[0-9a-f]{64}",value.get("frontend_tree_sha256",""))
images=value.get("images")
assert isinstance(images,list) and len(images)==5 and len(set(images))==5
PY
sudo cp -a "$work/release/." "$stage/"
sudo chmod 0600 "$stage/compose.json" "$stage/reviewed-ai-policy.sql"
sudo chmod 0644 "$stage/Caddyfile" "$stage/postgresql.conf" "$stage/pg_hba.conf"
sudo cp -a "$work/frontend/." "$frontend_stage/"
sudo find "$frontend_stage" -type d -exec chmod 0755 {} +
sudo find "$frontend_stage" -type f -exec chmod 0644 {} +
sudo install -d -m 0755 /opt/quizforge/operations
sudo cp -a "$work/operations/." /opt/quizforge/operations/
sudo find /opt/quizforge/operations -type f -exec chmod 0644 {} +
sudo install -m 0644 "$work/systemd/quizforge.slice" /etc/systemd/system/quizforge.slice
sudo install -m 0644 "$work/systemd/quizforge.service" /etc/systemd/system/quizforge.service
sudo systemctl daemon-reload
sudo mv "$stage" "$final"
sudo mv "$frontend_stage" /opt/quizforge/frontend
sudo ln -s "$final" /opt/quizforge/current
[ ! -e /etc/quizforge/launch-approved ] || exit 38
! systemctl is-active --quiet quizforge.service || exit 39
! systemctl is-enabled --quiet quizforge.service || exit 40
test "$(readlink -f /opt/quizforge/current)" = "$final" || exit 41
test -s /opt/quizforge/frontend/index.html || exit 42
test -s "$final/compose.json" || exit 43
printf '{"release_staged":true,"frontend_present":true,"service_inactive":true,"launch_marker_absent":true}\n'
"""


def safe_code(value: Any, fallback: str = "UNKNOWN") -> str:
    text=str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:-]{1,100}",text) else fallback


def runner_ipv4() -> str:
    with urllib.request.urlopen("https://checkip.amazonaws.com",timeout=10) as response:
        raw=response.read(128).decode("ascii").strip()
    ip=ipaddress.ip_address(raw)
    if ip.version!=4:
        raise ValueError("Runner IPv4 unavailable")
    return str(ip)


def normalized_ports(items: list[Mapping[str,Any]]) -> set[tuple[Any,...]]:
    return {
        (
            item.get("fromPort"),item.get("toPort"),item.get("protocol"),
            tuple(sorted(item.get("cidrs") or [])),
            tuple(sorted(item.get("ipv6Cidrs") or [])),
            tuple(sorted(item.get("cidrListAliases") or [])),
        )
        for item in items if isinstance(item,Mapping)
    }


def baseline_ports(admin_cidr: str) -> set[tuple[Any,...]]:
    return {
        (22,22,"tcp",(admin_cidr,),(),()),
        (80,80,"tcp",("0.0.0.0/0",),(),()),
        (443,443,"tcp",("0.0.0.0/0",),(),()),
    }


def load_pins(path: Path) -> set[tuple[str,str]]:
    value=json.loads(path.read_text(encoding="utf-8"))
    if (
        value.get("schema")!=1
        or value.get("instance_name")!=INSTANCE_NAME
        or value.get("trust_basis")!="two_independent_github_runner_network_observations"
    ):
        raise ValueError("SSH pin metadata invalid")
    result=set()
    for item in value.get("host_keys") or []:
        if not isinstance(item,Mapping):
            raise ValueError("SSH pin entry invalid")
        alg=item.get("algorithm")
        fp=item.get("fingerprint_sha256")
        if (
            alg not in {"ssh-ed25519","ssh-rsa","ecdsa-sha2-nistp256"}
            or not isinstance(fp,str)
            or not FP_RE.fullmatch(fp)
        ):
            raise ValueError("SSH pin invalid")
        result.add((alg,fp))
    if len(result)!=3 or not any(a=="ssh-ed25519" for a,_ in result):
        raise ValueError("SSH pin set incomplete")
    return result


def scan_host(ip: str, pins: set[tuple[str,str]]) -> str:
    completed=subprocess.run(
        ["ssh-keyscan","-T","10","-t","ed25519,ecdsa,rsa",ip],
        stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=20,check=False,
    )
    lines=[]
    found=set()
    for line in completed.stdout.splitlines():
        parts=line.split()
        if len(parts)<3 or parts[0]!=ip:
            continue
        alg,encoded=parts[1],parts[2]
        if alg not in {"ssh-ed25519","ssh-rsa","ecdsa-sha2-nistp256"}:
            continue
        try:
            raw=base64.b64decode(encoded,validate=True)
        except Exception:
            continue
        fp="SHA256:"+base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
        found.add((alg,fp))
        lines.append(line)
    if found != pins:
        raise ValueError("Observed SSH host key does not match pinned set")
    return "\n".join(lines)+"\n"


def validate_manifest(path: Path) -> dict[str,Any]:
    value=json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema")!=1 or not RELEASE_RE.fullmatch(str(value.get("release_sha",""))):
        raise ValueError("Manifest invalid")
    images=value.get("images")
    if (
        not isinstance(images,list)
        or len(images)!=5
        or len(set(images))!=5
        or any(not isinstance(x,str) or not IMAGE_RE.fullmatch(x) for x in images)
    ):
        raise ValueError("Image manifest invalid")
    tree=value.get("frontend_tree_sha256")
    if not isinstance(tree,str) or not re.fullmatch(r"[a-f0-9]{64}",tree):
        raise ValueError("Frontend digest invalid")
    return value


def ssh_command(key: Path,cert: Path,known: Path,username: str,ip: str,*remote: str) -> list[str]:
    return [
        "ssh","-i",str(key),"-o",f"CertificateFile={cert}",
        "-o",f"UserKnownHostsFile={known}","-o","StrictHostKeyChecking=yes",
        "-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","ConnectTimeout=15",
        f"{username}@{ip}",*remote,
    ]


def scp_command(key: Path,cert: Path,known: Path,username: str,ip: str,source: Path,destination: str) -> list[str]:
    return [
        "scp","-q","-i",str(key),"-o",f"CertificateFile={cert}",
        "-o",f"UserKnownHostsFile={known}","-o","StrictHostKeyChecking=yes",
        "-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","ConnectTimeout=15",
        str(source),f"{username}@{ip}:{destination}",
    ]


def remote_json(command: list[str],script: str) -> dict[str,Any]:
    completed=subprocess.run(
        command,input=script,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        timeout=60,check=True,
    )
    lines=[line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines)!=1:
        raise ValueError("Unexpected remote output")
    value=json.loads(lines[0])
    if not isinstance(value,dict):
        raise ValueError("Invalid remote JSON")
    return value


def preflight_ok(value: Mapping[str,Any]) -> bool:
    required_true=(
        "base_host_ready","ubuntu_24_04","sudo_noninteractive","docker_active",
        "compose_ok","cgroup_v2","swap_disabled","etc_private","var_private",
        "current_release_absent","frontend_absent","launch_marker_absent",
        "service_inactive","ssh_password_disabled","ssh_root_disabled",
        "ssh_forwarding_disabled",
    )
    return all(value.get(k) is True for k in required_true) and type(value.get("disk_free_gib")) is int and value["disk_free_gib"]>=20


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("Private value reached staging summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached staging summary")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    if len(os.sys.argv)!=4:
        print("usage: stage_release.py BUNDLE MANIFEST PINS",file=os.sys.stderr)
        return 2
    bundle=Path(os.sys.argv[1])
    manifest_path=Path(os.sys.argv[2])
    pins_path=Path(os.sys.argv[3])
    report: dict[str,Any]={
        "schema":1,
        "operation":"lightsail_application_stage",
        "result":"stage_failed",
        "temporary_ssh_rule_opened":False,
        "temporary_ssh_rule_closed":False,
        "baseline_firewall_restored":False,
        "launch_attempted":False,
        "dns_changes_performed":False,
        "ai_enabled":False,
    }
    forbidden=[]
    runner=None
    lightsail=None
    tempdir=None
    try:
        if boto3 is None:
            raise RuntimeError("AWS SDK missing")
        if not bundle.is_file() or bundle.stat().st_size<=0:
            raise ValueError("Bundle missing")
        manifest=validate_manifest(manifest_path)
        pins=load_pins(pins_path)
        release_sha=manifest["release_sha"]
        report["release_sha"]=release_sha

        admin_cidr=os.environ.get("LIGHTSAIL_ADMIN_IPV4_CIDR","")
        network=ipaddress.ip_network(admin_cidr,strict=True)
        if network.version!=4 or network.prefixlen!=32:
            raise ValueError("Admin CIDR invalid")
        forbidden.append(admin_cidr)

        lightsail=boto3.client("lightsail",region_name=REGION)
        instance=lightsail.get_instance(instanceName=INSTANCE_NAME)["instance"]
        static=lightsail.get_static_ip(staticIpName=STATIC_IP_NAME)["staticIp"]
        if (
            instance.get("blueprintId")!="ubuntu_24_04"
            or instance.get("bundleId")!="small_3_0"
            or instance.get("location",{}).get("availabilityZone")!="ca-central-1a"
            or instance.get("isStaticIp") is not True
            or static.get("attachedTo")!=INSTANCE_NAME
        ):
            raise ValueError("Live instance contract mismatch")
        ip=static.get("ipAddress")
        if not isinstance(ip,str) or ipaddress.ip_address(ip).version!=4:
            raise ValueError("Static IPv4 invalid")
        forbidden.append(ip)

        before=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
        if normalized_ports(before)!=baseline_ports(admin_cidr):
            raise ValueError("Baseline firewall mismatch")

        runner=runner_ipv4()
        forbidden.append(runner)
        runner_cidr=runner+"/32"
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner_cidr],"ipv6Cidrs":[],"cidrListAliases":[]},
        )
        report["temporary_ssh_rule_opened"]=True
        during=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
        if not any(
            isinstance(item,Mapping)
            and item.get("fromPort")==22 and item.get("toPort")==22
            and item.get("protocol")=="tcp" and runner_cidr in (item.get("cidrs") or [])
            for item in during
        ):
            raise ValueError("Runner SSH rule not visible")

        known_text=scan_host(ip,pins)
        report["host_key_pin_verified"]=True
        report["host_trust_basis"]="two_vantage_network_pin"

        access=lightsail.get_instance_access_details(instanceName=INSTANCE_NAME,protocol="ssh")["accessDetails"]
        private_key=access.get("privateKey")
        cert_key=access.get("certKey")
        username=access.get("username")
        if not all(isinstance(v,str) and v for v in (private_key,cert_key,username)):
            raise ValueError("Temporary SSH access incomplete")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}",username):
            raise ValueError("SSH username invalid")
        forbidden.extend([private_key,cert_key])

        tempdir=Path(tempfile.mkdtemp(prefix="quizforge-stage-"))
        tempdir.chmod(0o700)
        key=tempdir/"tempkey"
        cert=tempdir/"tempkey-cert.pub"
        known=tempdir/"known_hosts"
        key.write_text(private_key,encoding="utf-8"); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n"),encoding="utf-8"); cert.chmod(0o600)
        known.write_text(known_text,encoding="utf-8"); known.chmod(0o600)

        base=ssh_command(key,cert,known,username,ip,"bash","-s")
        remote=remote_json(base,REMOTE_PREFLIGHT)
        report["host_preflight_ok"]=preflight_ok(remote)
        report["host_contract"]={
            "base_host_ready": remote.get("base_host_ready") is True,
            "ubuntu_24_04": remote.get("ubuntu_24_04") is True,
            "sudo_noninteractive": remote.get("sudo_noninteractive") is True,
            "docker_active": remote.get("docker_active") is True,
            "cgroup_v2": remote.get("cgroup_v2") is True,
            "swap_disabled": remote.get("swap_disabled") is True,
            "etc_private": remote.get("etc_private") is True,
            "var_private": remote.get("var_private") is True,
            "ssh_password_disabled": remote.get("ssh_password_disabled") is True,
            "ssh_root_disabled": remote.get("ssh_root_disabled") is True,
            "ssh_forwarding_disabled": remote.get("ssh_forwarding_disabled") is True,
        }
        compose_version=str(remote.get("compose_version",""))
        report["compose_version"]=compose_version if re.fullmatch(r"[A-Za-z0-9._+~-]{1,80}",compose_version) else "invalid"
        report["compose_2_30_or_newer"]=remote.get("compose_ok") is True
        report["disk_capacity_ok"]=type(remote.get("disk_free_gib")) is int and remote["disk_free_gib"]>=20
        report["fresh_application_host"]=remote.get("current_release_absent") is True and remote.get("frontend_absent") is True
        report["bootstrap_diagnostic"]={
            "cloud_boot_finished": remote.get("cloud_boot_finished") is True,
            "cloud_status": remote.get("cloud_status") if isinstance(remote.get("cloud_status"),str) else "unknown",
            "cloud_extended_status": remote.get("cloud_extended_status") if isinstance(remote.get("cloud_extended_status"),str) else "unknown",
            "cloud_error_count": remote.get("cloud_error_count") if type(remote.get("cloud_error_count")) is int else -1,
            "cloud_recoverable_error_count": remote.get("cloud_recoverable_error_count") if type(remote.get("cloud_recoverable_error_count")) is int else -1,
            "docker_io_installed": remote.get("docker_io_installed") is True,
            "docker_compose_v2_installed": remote.get("docker_compose_v2_installed") is True,
            "docker_compose_plugin_installed": remote.get("docker_compose_plugin_installed") is True,
            "docker_compose_legacy_installed": remote.get("docker_compose_legacy_installed") is True,
            "docker_io_candidate": remote.get("docker_io_candidate") if isinstance(remote.get("docker_io_candidate"),str) else "unknown",
            "docker_compose_v2_candidate": remote.get("docker_compose_v2_candidate") if isinstance(remote.get("docker_compose_v2_candidate"),str) else "unknown",
            "docker_compose_plugin_candidate": remote.get("docker_compose_plugin_candidate") if isinstance(remote.get("docker_compose_plugin_candidate"),str) else "unknown",
            "docker_daemon_config_present": remote.get("docker_daemon_config_present") is True,
        }
        if not report["host_preflight_ok"]:
            raise ValueError("Host staging prerequisites incomplete")

        ecr=boto3.client("ecr",region_name=REGION)
        auth=ecr.get_authorization_token()["authorizationData"][0]
        token=base64.b64decode(auth["authorizationToken"]).decode()
        ecr_user,ecr_password=token.split(":",1)
        endpoint=auth["proxyEndpoint"]
        registry=endpoint.removeprefix("https://")
        forbidden.extend([ecr_password,registry])
        login=ssh_command(key,cert,known,username,ip,"sudo","docker","login","--username",ecr_user,"--password-stdin",registry)
        subprocess.run(login,input=ecr_password,text=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30,check=True)
        try:
            for image in manifest["images"]:
                subprocess.run(
                    ssh_command(key,cert,known,username,ip,"sudo","docker","pull",image),
                    stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=600,check=True,
                )
        finally:
            subprocess.run(
                ssh_command(key,cert,known,username,ip,"sudo","docker","logout",registry),
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,timeout=20,check=False,
            )
        report["reviewed_images_loaded"]=5

        remote_archive=f"/tmp/quizforge-stage-{release_sha}.tar.gz"
        subprocess.run(
            scp_command(key,cert,known,username,ip,bundle,remote_archive),
            stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,timeout=300,check=True,
        )
        stage_command=ssh_command(
            key,cert,known,username,ip,
            "bash","-s","--",release_sha,remote_archive,
        )
        completed=subprocess.run(
            stage_command,input=REMOTE_STAGE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            timeout=180,check=True,
        )
        lines=[line for line in completed.stdout.splitlines() if line.strip()]
        if len(lines)!=1:
            raise ValueError("Unexpected staging output")
        staged=json.loads(lines[0])
        if not all(staged.get(k) is True for k in ("release_staged","frontend_present","service_inactive","launch_marker_absent")):
            raise ValueError("Remote staging verification failed")
        subprocess.run(
            ssh_command(key,cert,known,username,ip,"rm","-f",remote_archive),
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,timeout=20,check=False,
        )

        report.update({
            "release_staged":True,
            "frontend_present":True,
            "service_inactive":True,
            "launch_marker_absent":True,
            "result":"release_staged_inactive",
        })
    except ClientError as error:
        report["error_code"]="AWS_STAGE_FAILED"
        report["aws_error_code"]=safe_code(error.response.get("Error",{}).get("Code"))
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_STAGE_COMMAND_FAILED"
        report["remote_return_code"]=error.returncode if isinstance(error.returncode,int) else -1
    except subprocess.TimeoutExpired:
        report["error_code"]="REMOTE_STAGE_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_STAGE_FAILED")
    finally:
        if lightsail is not None and runner:
            try:
                lightsail.close_instance_public_ports(
                    instanceName=INSTANCE_NAME,
                    portInfo={"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[runner+"/32"],"ipv6Cidrs":[],"cidrListAliases":[]},
                )
                report["temporary_ssh_rule_closed"]=True
                admin=os.environ.get("LIGHTSAIL_ADMIN_IPV4_CIDR","")
                after=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
                report["baseline_firewall_restored"]=normalized_ports(after)==baseline_ports(admin)
            except Exception as error:
                report["cleanup_error_code"]=safe_code(type(error).__name__,"PRIVATE_CLEANUP_FAILED")
        if tempdir is not None:
            for child in tempdir.iterdir():
                child.unlink(missing_ok=True)
            try:
                tempdir.rmdir()
            except OSError:
                pass
        if report.get("result")=="release_staged_inactive" and not (
            report.get("temporary_ssh_rule_closed") is True
            and report.get("baseline_firewall_restored") is True
        ):
            report["result"]="release_staged_firewall_cleanup_unverified"
        try:
            write_report(report,forbidden)
        except Exception:
            RESULT.unlink(missing_ok=True)

    return 0 if report.get("result")=="release_staged_inactive" else 1


if __name__=="__main__":
    raise SystemExit(main())
