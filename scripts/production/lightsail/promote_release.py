"""Promote one reviewed immutable release onto the existing permanent Lightsail host.

This is manual-only. It creates a fresh encrypted backup, loads only the
manifest-pinned images, stages the new release beside the old one, atomically
switches release/frontend symlinks, verifies local HTTPS health, and rolls back
to the previous release if startup or health verification fails.
"""

from __future__ import annotations

import base64
import ipaddress
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
    load_pins,
    normalized_ports,
    runner_ipv4,
    scan_host,
    scp_command,
    ssh_command,
)
from scripts.production.lightsail.stage_release import (
    validate_manifest,
)


REGION = "ca-central-1"
RESULT = Path(
    "lightsail-release-promotion/summary.json"
)


REMOTE_PROMOTE = r"""set -euo pipefail
release_sha="$1"
archive="$2"

case "$release_sha" in
  *[!0-9a-f]*|'') exit 31 ;;
esac
[ "$(printf %s "$release_sha" | wc -c)" -eq 40 ] || exit 32

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service
test -L /opt/quizforge/current
test -e /opt/quizforge/frontend

current="$(readlink -f /opt/quizforge/current)"
old_sha="$(basename "$current")"
case "$old_sha" in
  *[!0-9a-f]*|'') exit 33 ;;
esac
[ "$(printf %s "$old_sha" | wc -c)" -eq 40 ] || exit 34
[ "$old_sha" != "$release_sha" ] || exit 35

final="/opt/quizforge/releases/$release_sha"
frontends="/opt/quizforge/frontends"
new_frontend="$frontends/$release_sha"
old_frontend="$frontends/$old_sha"
stage="/opt/quizforge/releases/.promoting-$release_sha"
frontend_stage="$frontends/.promoting-$release_sha"

[ ! -e "$final" ] || exit 36
[ ! -e "$new_frontend" ] || exit 37

# New application code is not allowed to start against an old database.
compose_current="/opt/quizforge/current/compose.json"
dbq() {
  # Keep Compose from consuming the script streamed to bash -s over SSH.
  sudo docker compose -f "$compose_current" exec -T db sh -ceu '
    export PGPASSWORD="$(cat /run/quizforge/owner-password)"
    psql -X -qAt -v ON_ERROR_STOP=1 -U quizforge_owner -d quizforge -c "$1"
  ' sh "$1" </dev/null
}
test "$(dbq "SELECT (to_regclass('app.decks') IS NOT NULL AND to_regclass('app.cards') IS NOT NULL AND to_regclass('app.card_review_logs') IS NOT NULL AND to_regclass('app.study_notification_preferences') IS NOT NULL AND to_regclass('app.study_push_subscriptions') IS NOT NULL AND to_regclass('app.study_notification_deliveries') IS NOT NULL)::int")" = "1"
test "$(dbq "SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='quizforge_notifier'))::int")" = "1"

for path in   /etc/quizforge/notifier.env   /etc/quizforge/web-push-private.env   /etc/quizforge/web-push-public.env
do
  test -s "$path"
  test "$(stat -c %a "$path")" = "600"
done

# A successful fresh recovery point is mandatory immediately before switching.
sudo systemctl start quizforge-backup.service
test "$(systemctl show quizforge-backup.service -p Result --value)" = "success"
backup_completed=true

sudo rm -rf "$stage" "$frontend_stage"
sudo install -d -m 0755 /opt/quizforge/releases "$frontends"
sudo install -d -m 0700 "$stage"
sudo install -d -m 0755 "$frontend_stage"

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  rm -f "$archive"
}
trap cleanup EXIT

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

sudo docker compose -f "$stage/compose.json" --profile scheduled config --quiet

# Convert the original one-off frontend directory to a versioned symlink once.
if [ -L /opt/quizforge/frontend ]; then
  test "$(readlink -f /opt/quizforge/frontend)" = "$old_frontend"
else
  test -d /opt/quizforge/frontend
  [ ! -e "$old_frontend" ] || exit 38
  sudo mv /opt/quizforge/frontend "$old_frontend"
  sudo ln -s "$old_frontend" /opt/quizforge/frontend
fi

sudo mv "$stage" "$final"
sudo mv "$frontend_stage" "$new_frontend"

notifier_was_enabled=false
if systemctl is-enabled --quiet quizforge-study-notifier.timer 2>/dev/null; then
  notifier_was_enabled=true
  sudo systemctl disable --now quizforge-study-notifier.timer >/dev/null
fi

rollback() {
  set +e
  sudo systemctl stop quizforge.service >/dev/null 2>&1
  sudo ln -sfn "$current" /opt/quizforge/current.rollback
  sudo mv -Tf /opt/quizforge/current.rollback /opt/quizforge/current
  sudo ln -sfn "$old_frontend" /opt/quizforge/frontend.rollback
  sudo mv -Tf /opt/quizforge/frontend.rollback /opt/quizforge/frontend
  sudo systemctl daemon-reload
  sudo systemctl start quizforge.service >/dev/null 2>&1
  if [ "$notifier_was_enabled" = true ]; then
    sudo systemctl enable --now quizforge-study-notifier.timer >/dev/null 2>&1
  fi
  sudo rm -rf "$final" "$new_frontend"
}
trap rollback ERR

sudo systemctl stop quizforge.service

sudo ln -sfn "$final" /opt/quizforge/current.next
sudo mv -Tf /opt/quizforge/current.next /opt/quizforge/current
sudo ln -sfn "$new_frontend" /opt/quizforge/frontend.next
sudo mv -Tf /opt/quizforge/frontend.next /opt/quizforge/frontend

sudo install -m 0644 "$work/systemd/quizforge.slice" /etc/systemd/system/quizforge.slice
sudo install -m 0644 "$work/systemd/quizforge.service" /etc/systemd/system/quizforge.service
sudo install -m 0644 "$work/systemd/quizforge-study-notifier.service" /etc/systemd/system/quizforge-study-notifier.service
sudo install -m 0644 "$work/systemd/quizforge-study-notifier.timer" /etc/systemd/system/quizforge-study-notifier.timer
sudo systemctl daemon-reload
sudo systemctl start quizforge.service
systemctl is-active --quiet quizforge.service
systemctl is-enabled --quiet quizforge.service

compose_new="/opt/quizforge/current/compose.json"
for name in api identity db redis web guard
do
  cid="$(sudo docker compose -f "$compose_new" ps -q "$name")"
  test -n "$cid"
  status="$(sudo docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  test "$status" = "healthy" -o "$status" = "running"
done

curl --fail --silent --show-error --max-time 15   --resolve quizfromnotes.com:443:127.0.0.1   https://quizfromnotes.com/ >/dev/null
curl --fail --silent --show-error --max-time 15   --resolve api.quizfromnotes.com:443:127.0.0.1   https://api.quizfromnotes.com/api/health >/dev/null

if [ "$notifier_was_enabled" = true ]; then
  sudo systemctl enable --now quizforge-study-notifier.timer >/dev/null
  systemctl is-active --quiet quizforge-study-notifier.timer
  systemctl is-enabled --quiet quizforge-study-notifier.timer
fi

test "$(readlink -f /opt/quizforge/current)" = "$final"
test "$(readlink -f /opt/quizforge/frontend)" = "$new_frontend"

trap - ERR

python3 - "$old_sha" "$release_sha" "$backup_completed" "$notifier_was_enabled" <<'PY'
import json,sys
print("QF_RESULT="+json.dumps({
  "previous_release_sha":sys.argv[1],
  "release_sha":sys.argv[2],
  "backup_completed_before_switch":sys.argv[3]=="true",
  "release_switched":True,
  "frontend_switched":True,
  "local_https_verified":True,
  "rollback_retained":True,
  "notifier_timer_was_enabled":sys.argv[4]=="true",
},sort_keys=True))
PY
"""


def extract_qf_results(raw: str) -> list[str]:
    marker = "QF_RESULT="
    values: list[str] = []
    for line in raw.splitlines():
        index = line.find(marker)
        if index >= 0:
            values.append(
                line[index + len(marker):].strip()
            )
    return values


def combined_qf_results(
    stdout: str,
    stderr: str,
) -> list[str]:
    stdout_values = extract_qf_results(stdout)
    stderr_values = extract_qf_results(stderr)
    if (
        len(stdout_values) == 1
        and len(stderr_values) == 1
        and stdout_values[0] == stderr_values[0]
    ):
        return stdout_values
    return stdout_values + stderr_values


def safe_code(
    value: Any,
    fallback: str = "UNKNOWN",
) -> str:
    text = str(value or "")
    return (
        text
        if re.fullmatch(
            r"[A-Za-z0-9._:+~-]{1,120}",
            text,
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
                "Private value reached promotion summary"
            )
    if re.search(
        r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
        raw,
    ):
        raise ValueError(
            "IP reached promotion summary"
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
    if len(os.sys.argv) != 4:
        print(
            "usage: promote_release.py BUNDLE MANIFEST PINS",
            file=os.sys.stderr,
        )
        return 2

    bundle = Path(
        os.sys.argv[1]
    )
    manifest_path = Path(
        os.sys.argv[2]
    )
    pins_path = Path(
        os.sys.argv[3]
    )
    report: dict[str, Any] = {
        "schema": 1,
        "operation":
            "lightsail_promote_existing_release",
        "result": "promotion_failed",
        "temporary_ssh_rule_opened":
            False,
        "temporary_ssh_rule_closed":
            False,
        "baseline_firewall_restored":
            False,
        "reviewed_images_loaded": 0,
        "backup_completed_before_switch":
            False,
        "release_switched": False,
        "frontend_switched": False,
        "local_https_verified": False,
        "rollback_retained": False,
        "dns_changes_performed": False,
        "ai_configuration_changed": False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    tempdir: Path | None = None

    try:
        if (
            not bundle.is_file()
            or bundle.stat().st_size <= 0
        ):
            raise ValueError(
                "Bundle missing"
            )
        manifest = validate_manifest(
            manifest_path
        )
        release_sha = manifest[
            "release_sha"
        ]
        report[
            "release_sha"
        ] = release_sha
        pins = load_pins(
            pins_path
        )

        admin = os.environ[
            "LIGHTSAIL_ADMIN_IPV4_CIDR"
        ]
        network = (
            ipaddress.ip_network(
                admin,
                strict=True,
            )
        )
        if (
            network.version != 4
            or network.prefixlen
            != 32
        ):
            raise ValueError(
                "Admin CIDR invalid"
            )
        forbidden.append(admin)

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
            instance.get(
                "blueprintId"
            )
            != "ubuntu_24_04"
            or instance.get(
                "bundleId"
            )
            != "small_3_0"
            or instance.get(
                "isStaticIp"
            )
            is not True
            or static.get(
                "attachedTo"
            )
            != INSTANCE_NAME
            or not isinstance(
                ip,
                str,
            )
        ):
            raise ValueError(
                "Live instance contract mismatch"
            )
        forbidden.append(ip)

        before = (
            lightsail
            .get_instance_port_states(
                instanceName=
                    INSTANCE_NAME
            )
            .get(
                "portStates",
                [],
            )
        )
        if (
            normalized_ports(
                before
            )
            != baseline_ports(admin)
        ):
            raise ValueError(
                "Baseline firewall mismatch"
            )

        runner = runner_ipv4()
        forbidden.append(runner)
        runner_cidr = (
            runner + "/32"
        )
        lightsail.open_instance_public_ports(
            instanceName=
                INSTANCE_NAME,
            portInfo={
                "fromPort": 22,
                "toPort": 22,
                "protocol": "tcp",
                "cidrs": [
                    runner_cidr
                ],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        )
        report[
            "temporary_ssh_rule_opened"
        ] = True

        known_text = scan_host(
            ip,
            pins,
        )
        access = (
            lightsail
            .get_instance_access_details(
                instanceName=
                    INSTANCE_NAME,
                protocol="ssh",
            )[
                "accessDetails"
            ]
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
            [
                private_key,
                cert_key,
            ]
        )

        tempdir = Path(
            tempfile.mkdtemp(
                prefix=
                    "quizforge-promote-"
            )
        )
        tempdir.chmod(0o700)
        key = tempdir / "key"
        cert = (
            tempdir
            / "key-cert.pub"
        )
        known = (
            tempdir
            / "known_hosts"
        )
        key.write_text(
            private_key,
            encoding="utf-8",
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
            ),
            encoding="utf-8",
        )
        cert.chmod(0o600)
        known.write_text(
            known_text,
            encoding="utf-8",
        )
        known.chmod(0o600)

        ecr = boto3.client(
            "ecr",
            region_name=REGION,
        )
        auth = (
            ecr
            .get_authorization_token()[
                "authorizationData"
            ][0]
        )
        token = base64.b64decode(
            auth[
                "authorizationToken"
            ]
        ).decode()
        (
            ecr_user,
            ecr_password,
        ) = token.split(
            ":",
            1,
        )
        registry = auth[
            "proxyEndpoint"
        ].removeprefix(
            "https://"
        )
        forbidden.extend(
            [
                ecr_password,
                registry,
            ]
        )

        subprocess.run(
            ssh_command(
                key,
                cert,
                known,
                username,
                ip,
                "sudo",
                "docker",
                "login",
                "--username",
                ecr_user,
                "--password-stdin",
                registry,
            ),
            input=ecr_password,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
            check=True,
        )
        try:
            for image in manifest[
                "images"
            ]:
                subprocess.run(
                    ssh_command(
                        key,
                        cert,
                        known,
                        username,
                        ip,
                        "sudo",
                        "docker",
                        "pull",
                        image,
                    ),
                    stdout=
                        subprocess.DEVNULL,
                    stderr=
                        subprocess.PIPE,
                    text=True,
                    timeout=600,
                    check=True,
                )
        finally:
            subprocess.run(
                ssh_command(
                    key,
                    cert,
                    known,
                    username,
                    ip,
                    "sudo",
                    "docker",
                    "logout",
                    registry,
                ),
                stdout=
                    subprocess.DEVNULL,
                stderr=
                    subprocess.DEVNULL,
                text=True,
                timeout=20,
                check=False,
            )
        report[
            "reviewed_images_loaded"
        ] = 5

        remote_archive = (
            "/tmp/quizforge-promote-"
            + release_sha
            + ".tar.gz"
        )
        subprocess.run(
            scp_command(
                key,
                cert,
                known,
                username,
                ip,
                bundle,
                remote_archive,
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=300,
            check=True,
        )

        completed = subprocess.run(
            ssh_command(
                key,
                cert,
                known,
                username,
                ip,
                "bash",
                "-s",
                "--",
                release_sha,
                remote_archive,
            ),
            input=REMOTE_PROMOTE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
            check=True,
        )
        values = combined_qf_results(
            completed.stdout,
            completed.stderr,
        )
        if len(values) != 1:
            report["result_marker_count"] = len(values)
            report["stdout_marker_count"] = len(
                extract_qf_results(completed.stdout)
            )
            report["stderr_marker_count"] = len(
                extract_qf_results(completed.stderr)
            )
            raise ValueError(
                "Unexpected promotion output"
            )
        state = json.loads(
            values[0]
        )
        required = (
            "backup_completed_before_switch",
            "release_switched",
            "frontend_switched",
            "local_https_verified",
            "rollback_retained",
        )
        if not all(
            state.get(name)
            is True
            for name in required
        ):
            raise ValueError(
                "Promotion acceptance incomplete"
            )
        report.update(state)
        report[
            "result"
        ] = (
            "production_release_promoted"
        )

    except ClientError as error:
        report[
            "error_code"
        ] = safe_code(
            error.response.get(
                "Error",
                {},
            ).get("Code"),
            "AWS_PROMOTION_FAILED",
        )
    except subprocess.CalledProcessError as error:
        report[
            "error_code"
        ] = (
            "REMOTE_PROMOTION_FAILED"
        )
        report[
            "remote_return_code"
        ] = error.returncode
    except subprocess.TimeoutExpired:
        report[
            "error_code"
        ] = (
            "PROMOTION_TIMEOUT"
        )
    except Exception as error:
        report[
            "error_code"
        ] = safe_code(
            type(error).__name__,
            "PRIVATE_PROMOTION_FAILED",
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
                        "protocol":
                            "tcp",
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
                    lightsail
                    .get_instance_port_states(
                        instanceName=
                            INSTANCE_NAME
                    )
                    .get(
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

        if tempdir:
            for child in (
                tempdir.iterdir()
            ):
                child.unlink(
                    missing_ok=True
                )
            try:
                tempdir.rmdir()
            except OSError:
                pass

        if (
            report.get("result")
            == "production_release_promoted"
            and not report.get(
                "baseline_firewall_restored"
            )
        ):
            report[
                "result"
            ] = (
                "release_promoted_firewall_cleanup_unverified"
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
        == "production_release_promoted"
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
