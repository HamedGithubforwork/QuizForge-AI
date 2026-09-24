"""Read-only diagnosis of the permanent host after a failed first backup activation."""
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
RESULT = Path("lightsail-backup-host-diagnostic/summary.json")

REMOTE_DIAG = r"""set -euo pipefail

python3 - <<'PY'
import json
from pathlib import Path
import subprocess

def run(*args):
    return subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)

def text(*args):
    p=run(*args)
    return p.stdout.strip()

def exists(path):
    return Path(path).is_file() and Path(path).stat().st_size > 0

def signals(raw):
    low=raw.lower()
    checks={
      "backup_python_error":"error: backup operation stopped" in low,
      "backup_value_error":"valueerror" in low,
      "access_denied":"accessdenied" in low or "access denied" in low,
      "invalid_access_key":"invalidaccesskeyid" in low,
      "signature_error":"signaturedoesnotmatch" in low,
      "bucket_missing":"nosuchbucket" in low,
      "s3_error":"s3" in low and ("error" in low or "failed" in low),
      "cloudwatch_error":"cloudwatch" in low and ("error" in low or "failed" in low),
      "db_connection_error":"connection refused" in low or "operationalerror" in low or "password authentication failed" in low,
      "db_tls_error":"certificate verify failed" in low or "ssl error" in low,
      "schema_error":"database tables differ" in low or "schema/security fingerprint differs" in low,
      "private_db_config_error":"expected the explicit private database" in low,
      "module_error":"modulenotfounderror" in low or "importerror" in low,
      "permission_error":"permission denied" in low or "permissionerror" in low,
      "missing_file":"no such file or directory" in low,
      "no_space":"no space left" in low,
      "oom":"out of memory" in low or "oom" in low,
    }
    return sorted(name for name,hit in checks.items() if hit)

service={}
for unit in ("quizforge-backup.service","quizforge-backup.timer","quizforge-backup-health.timer"):
    fields=text("systemctl","show",unit,"--property=LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus","--value").splitlines()
    keys=("LoadState","ActiveState","SubState","UnitFileState","Result","ExecMainCode","ExecMainStatus")
    value={}
    for key,item in zip(keys,fields):
        item=item.strip()
        if key in {"ExecMainCode","ExecMainStatus"}:
            try: value[key]=int(item)
            except ValueError: value[key]=-1
        elif item and len(item)<=40 and all(c.isalnum() or c in "._-" for c in item):
            value[key]=item
        else:
            value[key]="unknown"
    service[unit]=value

status={"present":False,"last_attempt":"none","last_success_present":False}
status_path=Path("/var/lib/quizforge-backup/status.json")
if status_path.is_file():
    try:
        value=json.loads(status_path.read_text(encoding="utf-8"))
        attempt=value.get("last_attempt")
        success=value.get("last_success")
        status={
          "present":True,
          "last_attempt":attempt.get("outcome") if isinstance(attempt,dict) and attempt.get("outcome") in {"running","succeeded","failed"} else "unknown",
          "last_success_present":isinstance(success,dict),
        }
    except Exception:
        status={"present":True,"last_attempt":"invalid","last_success_present":False}

journal=text("journalctl","-u","quizforge-backup.service","-n","120","--no-pager","--output=cat")
result={
  "backup_user_present": run("id","-u","quizforge-backup").returncode==0,
  "operations_files_present": all(exists(p) for p in (
      "/opt/quizforge/operations/lightsail_backup.py",
      "/opt/quizforge/operations/lightsail_backup_job.py",
      "/opt/quizforge/operations/transfer.py",
      "/opt/quizforge/operations/requirements.lock",
      "/opt/quizforge/operations/db-ca.pem",
  )),
  "backup_venv_present": exists("/opt/quizforge/backup-venv/bin/python"),
  "backup_venv_imports_ok": run("/opt/quizforge/backup-venv/bin/python","-c","import boto3,cryptography,psycopg").returncode==0,
  "backup_venv_pip_check_ok": run("/opt/quizforge/backup-venv/bin/python","-m","pip","check").returncode==0,
  "backup_key_present": exists("/etc/quizforge/backup.key"),
  "backup_env_present": exists("/etc/quizforge/backup.env"),
  "health_env_present": exists("/etc/quizforge/backup-health.env"),
  "unit_files_present": all(exists("/etc/systemd/system/"+name) for name in (
      "quizforge-backup.service","quizforge-backup.timer",
      "quizforge-backup-health.service","quizforge-backup-health.timer",
      "quizforge-backup-failure.service",
  )),
  "services":service,
  "status":status,
  "journal_signals":signals(journal),
}
print("QF_RESULT="+json.dumps(result,sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str="UNKNOWN") -> str:
    text=str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}",text) else fallback


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached backup diagnostic")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached backup diagnostic")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
      "schema":1,
      "operation":"lightsail_backup_host_failure_diagnostic",
      "result":"diagnostic_failed",
      "changes_performed":False,
      "temporary_ssh_rule_opened":False,
      "temporary_ssh_rule_closed":False,
      "baseline_firewall_restored":False,
    }
    forbidden=[]; lightsail=None; runner=None; temp=None
    try:
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
        forbidden.extend([admin,ip])
        before=lightsail.get_instance_port_states(instanceName=INSTANCE_NAME).get("portStates",[])
        if normalized_ports(before)!=baseline_ports(admin):
            raise ValueError("baseline firewall mismatch")

        runner=runner_ipv4(); forbidden.append(runner)
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

        temp=Path(tempfile.mkdtemp(prefix="quizforge-backup-diag-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)
        completed=subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s"),
          input=REMOTE_DIAG,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
          timeout=120,check=True,
        )
        values=[line.removeprefix("QF_RESULT=") for line in completed.stdout.splitlines() if line.startswith("QF_RESULT=")]
        if len(values)!=1:
            raise ValueError("unexpected backup diagnostic output")
        value=json.loads(values[0])
        if not isinstance(value,dict):
            raise ValueError("invalid backup diagnostic")
        report["diagnostic"]=value
        report["result"]="diagnostic_complete_no_changes"
    except ClientError as error:
        report["error_code"]=safe_code(error.response.get("Error",{}).get("Code"),"AWS_DIAGNOSTIC_FAILED")
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
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="diagnostic_complete_no_changes" else 1


if __name__=="__main__":
    raise SystemExit(main())
