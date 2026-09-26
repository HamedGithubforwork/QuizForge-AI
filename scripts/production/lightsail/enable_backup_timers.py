"""Enable the reviewed permanent Lightsail backup timers after first recovery-point acceptance."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any, Mapping

import boto3
from botocore.exceptions import ClientError

from scripts.production.lightsail.host_control import (
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
RESULT=Path("lightsail-backup-timer-activation/summary.json")

REMOTE=r"""set -euo pipefail

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service

for path in   /etc/quizforge/backup.key   /etc/quizforge/backup.env   /etc/quizforge/backup-health.env   /opt/quizforge/operations/lightsail_backup.py   /opt/quizforge/operations/lightsail_backup_job.py   /opt/quizforge/backup-venv/bin/python   /etc/systemd/system/quizforge-backup.service   /etc/systemd/system/quizforge-backup.timer   /etc/systemd/system/quizforge-backup-health.service   /etc/systemd/system/quizforge-backup-health.timer
do
  test -s "$path"
done

python3 - <<'PY'
import json
from pathlib import Path
value=json.loads(Path("/var/lib/quizforge-backup/status.json").read_text())
assert value["format"]=="quizforge-backup-job-v1"
assert value["last_attempt"]["outcome"]=="succeeded"
success=value["last_success"]
assert isinstance(success,dict)
receipt=success["receipt"]
assert set(receipt)=={"object_key","version_id","payload"}
payload=receipt["payload"]
assert payload["format"]=="quizforge-backup-receipt-v1"
assert receipt["object_key"].startswith("receipts/")
assert isinstance(receipt["version_id"],str) and receipt["version_id"] and receipt["version_id"]!="null"
assert payload["object_key"].startswith("lightsail/")
assert isinstance(payload["version_id"],str) and payload["version_id"] and payload["version_id"]!="null"
PY

test "$(systemctl show quizforge-backup.service -p Result --value)" = "success"

rollback() {
  systemctl disable --now quizforge-backup.timer quizforge-backup-health.timer >/dev/null 2>&1 || true
}
trap rollback ERR

systemctl daemon-reload
systemctl enable --now quizforge-backup.timer quizforge-backup-health.timer >/dev/null

systemctl is-enabled --quiet quizforge-backup.timer
systemctl is-enabled --quiet quizforge-backup-health.timer
systemctl is-active --quiet quizforge-backup.timer
systemctl is-active --quiet quizforge-backup-health.timer

next_backup="$(systemctl show quizforge-backup.timer -p NextElapseUSecRealtime --value)"
next_health="$(systemctl show quizforge-backup-health.timer -p NextElapseUSecRealtime --value)"
test -n "$next_backup"
test -n "$next_health"
test "$next_backup" != "n/a"
test "$next_health" != "n/a"

systemctl start quizforge-backup-health.service
test "$(systemctl show quizforge-backup-health.service -p Result --value)" = "success"

trap - ERR

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "backup_timer_enabled":True,
  "backup_timer_active":True,
  "backup_timer_has_next_run":True,
  "health_timer_enabled":True,
  "health_timer_active":True,
  "health_timer_has_next_run":True,
  "standalone_health_publish_succeeded":True,
},sort_keys=True))
PY
"""


def safe_code(value: Any, fallback: str="UNKNOWN") -> str:
    text=str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9._:+~-]{1,120}",text) else fallback


def recent_metric(cloudwatch) -> bool:
    end=datetime.now(timezone.utc)
    start=end-timedelta(minutes=15)
    result=cloudwatch.get_metric_statistics(
        Namespace="QuizForge/Backup",
        MetricName="BackupFresh",
        Dimensions=[{"Name":"Deployment","Value":"production-lightsail"}],
        StartTime=start,
        EndTime=end,
        Period=60,
        Statistics=["Maximum"],
    )
    return any(float(item.get("Maximum",0)) >= 1 for item in result.get("Datapoints",[]))


def write_report(report: Mapping[str,Any], forbidden: list[str]) -> None:
    raw=json.dumps(report,indent=2,sort_keys=True)+"\n"
    for value in forbidden:
        if value and value in raw:
            raise ValueError("private value reached backup timer summary")
    if re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b",raw):
        raise ValueError("IP reached backup timer summary")
    RESULT.parent.mkdir(parents=True,exist_ok=True)
    RESULT.write_text(raw,encoding="utf-8")


def main() -> int:
    report={
      "schema":1,
      "operation":"lightsail_enable_production_backup_timers",
      "result":"activation_failed",
      "backup_timer_enabled":False,
      "health_timer_enabled":False,
      "health_metric_observed":False,
      "temporary_ssh_rule_opened":False,
      "temporary_ssh_rule_closed":False,
      "baseline_firewall_restored":False,
      "dns_changes_performed":False,
      "ai_configuration_changed":False,
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

        temp=Path(tempfile.mkdtemp(prefix="quizforge-backup-timers-")); temp.chmod(0o700)
        key=temp/"key"; cert=temp/"key-cert.pub"; hosts=temp/"known_hosts"
        key.write_text(private_key); key.chmod(0o600)
        cert.write_text(cert_key+("" if cert_key.endswith("\n") else "\n")); cert.chmod(0o600)
        hosts.write_text(known); hosts.chmod(0o600)

        completed=subprocess.run(
          ssh_command(key,cert,hosts,username,ip,"sudo","bash","-s"),
          input=REMOTE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,check=True,
        )
        values=[line.removeprefix("QF_RESULT=") for line in completed.stdout.splitlines() if line.startswith("QF_RESULT=")]
        if len(values)!=1:
            raise ValueError("unexpected timer activation output")
        state=json.loads(values[0])
        required=(
          "backup_timer_enabled","backup_timer_active","backup_timer_has_next_run",
          "health_timer_enabled","health_timer_active","health_timer_has_next_run",
          "standalone_health_publish_succeeded",
        )
        if not all(state.get(name) is True for name in required):
            raise ValueError("timer activation acceptance incomplete")
        report.update(state)

        cloudwatch=boto3.client("cloudwatch",region_name=REGION)
        deadline=time.time()+90
        while time.time()<deadline and not recent_metric(cloudwatch):
            time.sleep(5)
        report["health_metric_observed"]=recent_metric(cloudwatch)
        if not report["health_metric_observed"]:
            raise ValueError("fresh backup metric not observed")
        alarm=cloudwatch.describe_alarms(
          AlarmNames=["quizforge-production-backup-unhealthy"],
          AlarmTypes=["MetricAlarm"],
        ).get("MetricAlarms",[])
        report["alarm_state"] = alarm[0].get("StateValue") if len(alarm)==1 else "UNKNOWN"
        report["result"]="production_backup_timers_enabled"
    except ClientError as error:
        report["error_code"]=safe_code(error.response.get("Error",{}).get("Code"),"AWS_TIMER_ACTIVATION_FAILED")
    except subprocess.CalledProcessError as error:
        report["error_code"]="REMOTE_TIMER_ACTIVATION_FAILED"
        report["remote_return_code"]=error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"]="TIMER_ACTIVATION_TIMEOUT"
    except Exception as error:
        report["error_code"]=safe_code(type(error).__name__,"PRIVATE_TIMER_ACTIVATION_FAILED")
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
                report["cleanup_error_code"]=safe_code(type(error).__name__,"PRIVATE_FIREWALL_CLEANUP_FAILED")
        if temp:
            for child in temp.iterdir():
                child.unlink(missing_ok=True)
            try: temp.rmdir()
            except OSError: pass
        if report.get("result")=="production_backup_timers_enabled" and not report.get("baseline_firewall_restored"):
            report["result"]="backup_timers_enabled_firewall_cleanup_unverified"
        try: write_report(report,forbidden)
        except Exception: RESULT.unlink(missing_ok=True)
    return 0 if report.get("result")=="production_backup_timers_enabled" else 1


if __name__=="__main__":
    raise SystemExit(main())
