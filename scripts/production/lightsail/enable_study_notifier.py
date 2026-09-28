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
probe="$(sudo docker compose -f "$compose" --profile scheduled run --rm --no-deps notifier)"
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

next_run="$(systemctl show quizforge-study-notifier.timer -p NextElapseUSecRealtime --value)"
test -n "$next_run"
test "$next_run" != "n/a"

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

        known = scan_host(
            ip,
            pins,
        )
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

        for local, remote in (
            (SERVICE, remote_service),
            (TIMER, remote_timer),
        ):
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

        completed = subprocess.run(
            ssh_command(
                key,
                cert,
                hosts,
                username,
                ip,
                "sudo",
                "bash",
                "-s",
                "--",
                remote_service,
                remote_timer,
                service_sha,
                timer_sha,
            ),
            input=REMOTE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            check=True,
        )

        values = [
            line.removeprefix(
                "QF_RESULT="
            )
            for line
            in completed.stdout.splitlines()
            if line.startswith(
                "QF_RESULT="
            )
        ]
        if len(values) != 1:
            raise ValueError(
                "Unexpected notifier activation output"
            )

        state = json.loads(
            values[0]
        )
        required = (
            "notifier_probe_succeeded",
            "notifier_timer_enabled",
            "notifier_timer_active",
            "notifier_timer_has_next_run",
        )
        if not all(
            state.get(name)
            is True
            for name in required
        ):
            raise ValueError(
                "Notifier activation acceptance incomplete"
            )

        report.update(state)
        report["result"] = (
            "study_notifier_timer_enabled"
        )

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
            == "study_notifier_timer_enabled"
            and not report.get(
                "baseline_firewall_restored"
            )
        ):
            report["result"] = (
                "notifier_enabled_firewall_cleanup_unverified"
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
        == "study_notifier_timer_enabled"
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
