"""Enable the reviewed QuizForge study reminder timer on permanent Lightsail."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Mapping

import boto3
from botocore.exceptions import ClientError

from scripts.production.lightsail.host_control import (
    INSTANCE_NAME,
    STATIC_IP_NAME,
    baseline_ports,
    normalized_ports,
    load_pins,
    runner_ipv4,
    scan_host,
    scp_command,
    ssh_command,
)


REGION = "ca-central-1"
RESULT = Path(
    "lightsail-study-notifier-activation/summary.json"
)
SERVICE = Path(
    "scripts/production/lightsail/quizforge-study-notifier.service"
)
TIMER = Path(
    "scripts/production/lightsail/quizforge-study-notifier.timer"
)

ACTIVATION_FIELDS = (
    "notifier_probe_succeeded", "notifier_timer_enabled",
    "notifier_timer_active", "notifier_timer_has_next_run",
)
INSPECTION_FIELDS = (
    "application_active", "notifier_timer_enabled", "notifier_timer_active",
    "notifier_timer_has_next_run", "notifier_service_matches",
    "notifier_timer_matches", "notifier_last_run_succeeded",
)

# Inspect existing state without copying units, running the sender, or changing
# systemd. Return only fixed boolean fields; never return host output or env files.
REMOTE_INSPECT = r"""set -euo pipefail
python3 - "$1" "$2" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
def status(*args):
    return subprocess.run(["systemctl",*args],stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0
def prop(unit,name):
    result=subprocess.run(["systemctl","show",unit,"-p",name,"--value"],
        stdin=subprocess.DEVNULL,capture_output=True,text=True,check=False)
    return result.stdout.strip() if result.returncode == 0 else ""
def matches(name,digest):
    path=Path("/etc/systemd/system")/name
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest()==digest
timer="quizforge-study-notifier.timer"
service="quizforge-study-notifier.service"
next_run=prop(timer,"NextElapseUSecMonotonic")
print("QF_RESULT="+json.dumps({
    "application_active":status("is-active","--quiet","quizforge.service"),
    "notifier_timer_enabled":status("is-enabled","--quiet",timer),
    "notifier_timer_active":status("is-active","--quiet",timer),
    "notifier_timer_has_next_run":next_run not in ("", "n/a", "0", "infinity"),
    "notifier_service_matches":matches(service,sys.argv[1]),
    "notifier_timer_matches":matches(timer,sys.argv[2]),
    "notifier_last_run_succeeded":bool(prop(service,"ExecMainStartTimestamp")) and prop(service,"Result")=="success",
},sort_keys=True))
PY
"""


REMOTE = r"""set -euo pipefail
service_source="$1"
timer_source="$2"
service_sha="$3"
timer_sha="$4"

cleanup() {
  rm -f "$service_source" "$timer_source"
}
trap cleanup EXIT

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service

for path in   /opt/quizforge/current/compose.json   /etc/quizforge/notifier.env   /etc/quizforge/web-push-private.env   /etc/quizforge/web-push-public.env   /etc/quizforge/db-ca.pem
do
  test -s "$path"
done

test "$(stat -c %a /etc/quizforge/notifier.env)" = "600"
test "$(stat -c %a /etc/quizforge/web-push-private.env)" = "600"
test "$(stat -c %a /etc/quizforge/web-push-public.env)" = "600"

test "$(sha256sum "$service_source" | cut -d' ' -f1)" = "$service_sha"
test "$(sha256sum "$timer_source" | cut -d' ' -f1)" = "$timer_sha"

compose="/opt/quizforge/current/compose.json"
sudo docker compose -f "$compose" --profile scheduled config --services | grep -qx notifier

# The API must only receive the public half; the notifier receives only its
# dedicated DB password plus the private half.
python3 - "$compose" <<'PY'
import json
import sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
services=value["services"]
api=services["api"]
notifier=services["notifier"]

api_env_files=[
    item["path"] if isinstance(item,dict) else item
    for item in api.get("env_file",[])
]
notifier_env_files=[
    item["path"] if isinstance(item,dict) else item
    for item in notifier.get("env_file",[])
]
assert "/etc/quizforge/web-push-public.env" in api_env_files
assert "/etc/quizforge/web-push-private.env" not in api_env_files
assert "/etc/quizforge/web-push-private.env" in notifier_env_files
assert "/etc/quizforge/notifier.env" in notifier_env_files
assert notifier["environment"]["PGUSER"]=="quizforge_notifier"
assert "OPENAI_API_KEY" not in notifier["environment"]
assert notifier.get("profiles")==["scheduled"]
assert notifier.get("restart")=="no"
PY

# Require a successful one-shot run before enabling recurrence. This may send
# a reminder only if an existing user has explicitly enabled reminders and is
# currently inside the configured reminder window.
# Compose defaults to interactive stdin even without a TTY. Do not let the
# child consume the remaining controller script streamed through bash -s.
probe="$(sudo docker compose -f "$compose" --profile scheduled run --rm --no-deps notifier </dev/null)"
python3 - "$probe" <<'PY'
import json
import sys
lines=[line for line in sys.argv[1].splitlines() if line.strip().startswith("{")]
assert lines
value=json.loads(lines[-1])
assert value.get("format")=="quizforge-study-notifier-v1"
assert "error" not in value
for key in (
    "candidates","sent","skipped_time","skipped_duplicate",
    "expired_removed","failed",
):
    assert isinstance(value.get(key),int) and value[key] >= 0
PY

sudo install -m 0644 "$service_source" /etc/systemd/system/quizforge-study-notifier.service
sudo install -m 0644 "$timer_source" /etc/systemd/system/quizforge-study-notifier.timer
sudo systemctl daemon-reload

rollback() {
  sudo systemctl disable --now quizforge-study-notifier.timer >/dev/null 2>&1 || true
}
trap rollback ERR

sudo systemctl enable --now quizforge-study-notifier.timer >/dev/null
systemctl is-enabled --quiet quizforge-study-notifier.timer
systemctl is-active --quiet quizforge-study-notifier.timer

# OnBootSec/OnUnitInactiveSec use the monotonic clock, not OnCalendar's
# realtime clock. A just-fired timer may briefly be running its service before
# systemd schedules the next interval, so allow a bounded settling period.
scheduled=false
for attempt in {1..15}; do
  next_run="$(systemctl show quizforge-study-notifier.timer -p NextElapseUSecMonotonic --value)"
  case "$next_run" in
    ""|n/a|0|infinity) ;;
    *) scheduled=true; break ;;
  esac
  if [ "$attempt" -lt 15 ]; then sleep 2; fi
done
test "$scheduled" = true
systemctl is-enabled --quiet quizforge-study-notifier.timer
systemctl is-active --quiet quizforge-study-notifier.timer

trap - ERR

python3 - <<'PY'
import json
print("QF_RESULT="+json.dumps({
  "notifier_probe_succeeded":True,
  "notifier_timer_enabled":True,
  "notifier_timer_active":True,
  "notifier_timer_has_next_run":True,
},sort_keys=True))
PY
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(
        path.read_bytes()
    ).hexdigest()


def safe_code(
    value: Any,
    fallback: str = "UNKNOWN",
) -> str:
    raw = str(value or "")
    return (
        raw
        if re.fullmatch(
            r"[A-Za-z0-9._:+~-]{1,120}",
            raw,
        )
        else fallback
    )


def parse_result(output: str, inspection: bool) -> dict[str, bool]:
    values = [line.removeprefix("QF_RESULT=") for line in output.splitlines()
              if line.startswith("QF_RESULT=")]
    if len(values) != 1:
        raise ValueError("Unexpected notifier output")
    state = json.loads(values[0])
    fields = INSPECTION_FIELDS if inspection else ACTIVATION_FIELDS
    if not isinstance(state, dict) or set(state) != set(fields):
        raise ValueError("Unexpected notifier result fields")
    if not all(type(state[name]) is bool for name in fields):
        raise ValueError("Unexpected notifier result types")
    if not inspection and not all(state.values()):
        raise ValueError("Notifier activation acceptance incomplete")
    return state


def write_report(
    report: Mapping[str, Any],
    forbidden: list[str],
) -> None:
    raw = (
        json.dumps(
            report,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    for value in forbidden:
        if value and value in raw:
            raise ValueError(
                "Private value reached notifier activation summary"
            )
    if re.search(
        r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
        raw,
    ):
        raise ValueError(
            "IP reached notifier activation summary"
        )
    RESULT.parent.mkdir(
        parents=True,
        exist_ok=True,
    )
    RESULT.write_text(
        raw,
        encoding="utf-8",
    )


def main() -> int:
    report: dict[str, Any] = {
        "schema": 1,
        "operation":
            "lightsail_enable_study_notifier_timer",
        "result": "activation_failed",
        "notifier_probe_succeeded":
            False,
        "notifier_timer_enabled":
            False,
        "notifier_timer_active":
            False,
        "notifier_timer_has_next_run":
            False,
        "temporary_ssh_rule_opened":
            False,
        "temporary_ssh_rule_closed":
            False,
        "baseline_firewall_restored":
            False,
        "dns_changes_performed":
            False,
        "ai_configuration_changed":
            False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    temp: Path | None = None

    try:
        report["stage"] = "validate_inputs"
        inspect_value = os.environ.get("QF_NOTIFIER_INSPECT_ONLY", "true")
        if inspect_value not in ("true", "false"):
            raise ValueError("Invalid inspection mode")
        inspection = inspect_value == "true"
        report["inspection_only"] = inspection
        service_sha = sha256(
            SERVICE
        )
        timer_sha = sha256(
            TIMER
        )
        if not all(
            re.fullmatch(
                r"[a-f0-9]{64}",
                value,
            )
            for value in (
                service_sha,
                timer_sha,
            )
        ):
            raise ValueError(
                "Notifier unit digest invalid"
            )

        admin = os.environ[
            "LIGHTSAIL_ADMIN_IPV4_CIDR"
        ]
        pins = load_pins(
            Path(
                "scripts/production/lightsail/ssh-host-pins.json"
            )
        )
        lightsail = boto3.client(
            "lightsail",
            region_name=REGION,
        )
        report["stage"] = "inspect_instance"
        instance = lightsail.get_instance(
            instanceName=INSTANCE_NAME
        )["instance"]
        static = lightsail.get_static_ip(
            staticIpName=STATIC_IP_NAME
        )["staticIp"]
        ip = static.get(
            "ipAddress"
        )
        if (
            instance.get("blueprintId")
            != "ubuntu_24_04"
            or instance.get("bundleId")
            != "small_3_0"
            or instance.get("isStaticIp")
            is not True
            or static.get("attachedTo")
            != INSTANCE_NAME
            or not isinstance(ip, str)
        ):
            raise ValueError(
                "Live instance contract mismatch"
            )
        forbidden.extend(
            [admin, ip]
        )
        before = (
            lightsail.get_instance_port_states(
                instanceName=
                    INSTANCE_NAME
            ).get(
                "portStates",
                [],
            )
        )
        if (
            normalized_ports(before)
            != baseline_ports(admin)
        ):
            raise ValueError(
                "Baseline firewall mismatch"
            )

        report["stage"] = "open_temporary_ssh"
        runner = runner_ipv4()
        forbidden.append(runner)
        lightsail.open_instance_public_ports(
            instanceName=INSTANCE_NAME,
            portInfo={
                "fromPort": 22,
                "toPort": 22,
                "protocol": "tcp",
                "cidrs": [
                    runner + "/32"
                ],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        )
        report[
            "temporary_ssh_rule_opened"
        ] = True

        report["stage"] = "verify_host_key"
        known = scan_host(
            ip,
            pins,
        )
        report["stage"] = "obtain_temporary_access"
        access = (
            lightsail.get_instance_access_details(
                instanceName=
                    INSTANCE_NAME,
                protocol="ssh",
            )["accessDetails"]
        )
        private_key = access.get(
            "privateKey"
        )
        cert_key = access.get(
            "certKey"
        )
        username = access.get(
            "username"
        )
        if not all(
            isinstance(value, str)
            and value
            for value in (
                private_key,
                cert_key,
                username,
            )
        ):
            raise ValueError(
                "Temporary SSH access incomplete"
            )
        forbidden.extend(
            [private_key, cert_key]
        )

        temp = Path(
            tempfile.mkdtemp(
                prefix=
                    "quizforge-notifier-activate-"
            )
        )
        temp.chmod(0o700)
        key = temp / "key"
        cert = temp / "key-cert.pub"
        hosts = temp / "known_hosts"
        key.write_text(
            private_key
        )
        key.chmod(0o600)
        cert.write_text(
            cert_key
            + (
                ""
                if cert_key.endswith(
                    "\n"
                )
                else "\n"
            )
        )
        cert.chmod(0o600)
        hosts.write_text(known)
        hosts.chmod(0o600)

        remote_service = (
            "/tmp/"
            + SERVICE.name
        )
        remote_timer = (
            "/tmp/"
            + TIMER.name
        )

        report["stage"] = "copy_reviewed_units"
        for local, remote in (() if inspection else (
            (SERVICE, remote_service),
            (TIMER, remote_timer),
        )):
            subprocess.run(
                scp_command(
                    key,
                    cert,
                    hosts,
                    username,
                    ip,
                    local,
                    remote,
                ),
                timeout=60,
                check=True,
            )

        report["stage"] = "inspect_remote" if inspection else "activate_remote"
        remote_args = ([service_sha, timer_sha] if inspection else
                       [remote_service, remote_timer, service_sha, timer_sha])
        completed = subprocess.run(
            ssh_command(
                key,
                cert,
                hosts,
                username,
                ip,
                "sudo",
                "-n",
                "bash",
                "-s",
                "--",
                *remote_args,
            ),
            input=REMOTE_INSPECT if inspection else REMOTE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            check=True,
        )

        report["stage"] = "validate_remote_result"
        report.update(parse_result(completed.stdout, inspection))
        report["result"] = ("study_notifier_inspected" if inspection else
                            "study_notifier_timer_enabled")
        report["stage"] = "complete"

    except ClientError as error:
        report["error_code"] = (
            safe_code(
                error.response.get(
                    "Error",
                    {},
                ).get("Code"),
                "AWS_NOTIFIER_ACTIVATION_FAILED",
            )
        )
    except subprocess.CalledProcessError as error:
        report["error_code"] = (
            "REMOTE_NOTIFIER_ACTIVATION_FAILED"
        )
        report[
            "remote_return_code"
        ] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = (
            "NOTIFIER_ACTIVATION_TIMEOUT"
        )
    except Exception as error:
        report["error_code"] = (
            safe_code(
                type(error).__name__,
                "PRIVATE_NOTIFIER_ACTIVATION_FAILED",
            )
        )
    finally:
        if (
            lightsail is not None
            and runner
        ):
            try:
                lightsail.close_instance_public_ports(
                    instanceName=
                        INSTANCE_NAME,
                    portInfo={
                        "fromPort": 22,
                        "toPort": 22,
                        "protocol": "tcp",
                        "cidrs": [
                            runner
                            + "/32"
                        ],
                        "ipv6Cidrs": [],
                        "cidrListAliases": [],
                    },
                )
                report[
                    "temporary_ssh_rule_closed"
                ] = True
                after = (
                    lightsail.get_instance_port_states(
                        instanceName=
                            INSTANCE_NAME
                    ).get(
                        "portStates",
                        [],
                    )
                )
                report[
                    "baseline_firewall_restored"
                ] = (
                    normalized_ports(
                        after
                    )
                    == baseline_ports(
                        os.environ[
                            "LIGHTSAIL_ADMIN_IPV4_CIDR"
                        ]
                    )
                )
            except Exception as error:
                report[
                    "cleanup_error_code"
                ] = safe_code(
                    type(
                        error
                    ).__name__,
                    "PRIVATE_FIREWALL_CLEANUP_FAILED",
                )

        if temp:
            for child in temp.iterdir():
                child.unlink(
                    missing_ok=True
                )
            try:
                temp.rmdir()
            except OSError:
                pass

        if (
            report.get("result")
            in ("study_notifier_timer_enabled", "study_notifier_inspected")
            and not report.get(
                "baseline_firewall_restored"
            )
        ):
            report["result"] = (
                "notifier_operation_firewall_cleanup_unverified"
            )

        try:
            write_report(
                report,
                forbidden,
            )
        except Exception:
            RESULT.unlink(
                missing_ok=True
            )

    return (
        0
        if report.get("result")
        in ("study_notifier_timer_enabled", "study_notifier_inspected")
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
