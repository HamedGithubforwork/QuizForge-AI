"""Apply reviewed additive PostgreSQL migrations to the live Lightsail database.

This controller is manual-only. It takes a fresh encrypted backup first,
opens SSH only to the current GitHub runner, verifies pinned host keys,
uploads only the reviewed migration SQL files, and applies each migration
only when its exact precondition says it is still pending.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
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


REGION = "ca-central-1"
RESULT = Path(
    "lightsail-database-migration/summary.json"
)
MIGRATION_DIR = Path(
    "scripts/production/migrations"
)
MIGRATION_FILES = (
    "20260927_001_decks_cards.sql",
    "20260927_002_fsrs_reviews.sql",
    "20260927_003_study_notification_preferences.sql",
    "20260928_004_study_push_subscriptions.sql",
    "20260928_005_study_notifier_role.sql",
)
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


REMOTE = r"""set -euo pipefail
archive="$1"
manifest="$2"

cleanup() {
  rm -f "$archive" "$manifest"
}
trap cleanup EXIT

test -f /etc/quizforge/launch-approved
test -f /etc/quizforge/database-initialized
systemctl is-active --quiet quizforge.service

# A new successful recovery point is mandatory before schema mutation.
systemctl start quizforge-backup.service
test "$(systemctl show quizforge-backup.service -p Result --value)" = "success"

root="$(mktemp -d /tmp/quizforge-migrations.XXXXXX)"
chmod 0700 "$root"
trap 'rm -rf "$root"; cleanup' EXIT

tar -C "$root" -xzf "$archive"

python3 - "$root" "$manifest" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys

root=Path(sys.argv[1])
manifest=Path(sys.argv[2])
value=json.loads(manifest.read_text())
assert value.get("schema")==1
items=value.get("migrations")
assert isinstance(items,list) and len(items)==5
expected=[
 "20260927_001_decks_cards.sql",
 "20260927_002_fsrs_reviews.sql",
 "20260927_003_study_notification_preferences.sql",
 "20260928_004_study_push_subscriptions.sql",
 "20260928_005_study_notifier_role.sql",
]
assert [item.get("name") for item in items]==expected
assert set(path.name for path in root.iterdir())==set(expected)
for item in items:
    digest=item.get("sha256")
    assert isinstance(digest,str) and re.fullmatch(r"[a-f0-9]{64}",digest)
    raw=(root/item["name"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==digest
PY

compose="/opt/quizforge/current/compose.json"
test -s "$compose"

dbq() {
  sudo docker compose -f "$compose" exec -T db sh -ceu '
    export PGPASSWORD="$(cat /run/quizforge/owner-password)"
    psql -X -qAt -v ON_ERROR_STOP=1 -U quizforge_owner -d quizforge -c "$1"
  ' sh "$1"
}

apply_sql() {
  file="$1"
  sudo docker compose -f "$compose" exec -T db sh -ceu '
    export PGPASSWORD="$(cat /run/quizforge/owner-password)"
    psql -X -v ON_ERROR_STOP=1 -U quizforge_owner -d quizforge
  ' < "$file"
}

# 001: decks/cards. Exact all-or-none precondition.
deck_state="$(dbq "SELECT (to_regclass('app.decks') IS NOT NULL)::int || ':' || (to_regclass('app.cards') IS NOT NULL)::int")"
case "$deck_state" in
  "0:0") apply_sql "$root/20260927_001_decks_cards.sql"; applied_001=true ;;
  "1:1") applied_001=false ;;
  *) echo "Partial deck schema detected" >&2; exit 41 ;;
esac

test "$(dbq "SELECT (to_regclass('app.decks') IS NOT NULL AND to_regclass('app.cards') IS NOT NULL)::int")" = "1"

# 002: FSRS state + review logs. Reject partial application.
fsrs_state="$(dbq "SELECT (to_regclass('app.card_review_logs') IS NOT NULL)::int || ':' || (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='cards' AND column_name='fsrs_state'))::int || ':' || (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='cards' AND column_name='due_at'))::int")"
case "$fsrs_state" in
  "0:0:0") apply_sql "$root/20260927_002_fsrs_reviews.sql"; applied_002=true ;;
  "1:1:1") applied_002=false ;;
  *) echo "Partial FSRS schema detected" >&2; exit 42 ;;
esac

test "$(dbq "SELECT (to_regclass('app.card_review_logs') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='cards' AND column_name='fsrs_state') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='cards' AND column_name='due_at'))::int")" = "1"

# 003: notification preferences.
pref_state="$(dbq "SELECT (to_regclass('app.study_notification_preferences') IS NOT NULL)::int")"
case "$pref_state" in
  "0") apply_sql "$root/20260927_003_study_notification_preferences.sql"; applied_003=true ;;
  "1") applied_003=false ;;
  *) exit 43 ;;
esac

test "$(dbq "SELECT (to_regclass('app.study_notification_preferences') IS NOT NULL)::int")" = "1"

# 004: browser push subscriptions + delivery idempotency ledger.
push_state="$(dbq "SELECT (to_regclass('app.study_push_subscriptions') IS NOT NULL)::int || ':' || (to_regclass('app.study_notification_deliveries') IS NOT NULL)::int")"
case "$push_state" in
  "0:0") apply_sql "$root/20260928_004_study_push_subscriptions.sql"; applied_004=true ;;
  "1:1") applied_004=false ;;
  *) echo "Partial Web Push schema detected" >&2; exit 44 ;;
esac

test "$(dbq "SELECT (to_regclass('app.study_push_subscriptions') IS NOT NULL AND to_regclass('app.study_notification_deliveries') IS NOT NULL)::int")" = "1"

# 005: dedicated least-privilege notifier role.
notifier_state="$(dbq "SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='quizforge_notifier'))::int")"
case "$notifier_state" in
  "0") apply_sql "$root/20260928_005_study_notifier_role.sql"; applied_005=true ;;
  "1") applied_005=false ;;
  *) exit 45 ;;
esac

test "$(dbq "SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='quizforge_notifier'))::int")" = "1"

# Create or reconcile the private notifier credential only on the host.
# No credential value is printed.
test -x /opt/quizforge/backup-venv/bin/python
test -s /etc/quizforge/postgres/owner-password
test -s /etc/quizforge/db-ca.pem
/opt/quizforge/backup-venv/bin/python - <<'PY'
import os
from pathlib import Path
import secrets
import stat
import tempfile

import psycopg
from psycopg import sql

destination=Path("/etc/quizforge/notifier.env")
if destination.exists() or destination.is_symlink():
    info=destination.lstat()
    if (
        destination.is_symlink()
        or not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) & 0o077
        or info.st_uid != 0
    ):
        raise SystemExit("unsafe notifier credential file")
else:
    password=secrets.token_urlsafe(48)
    owner=Path("/etc/quizforge/postgres/owner-password").read_text().strip()
    with psycopg.connect(
        host="db.quizforge.internal",
        hostaddr="127.0.0.1",
        port=5432,
        dbname="quizforge",
        user="quizforge_owner",
        password=owner,
        sslmode="verify-full",
        sslrootcert="/etc/quizforge/db-ca.pem",
        connect_timeout=10,
    ) as connection:
        with connection.transaction():
            with psycopg.ClientCursor(connection) as cursor:
                cursor.execute(
                    sql.SQL("ALTER ROLE {} PASSWORD %s").format(
                        sql.Identifier("quizforge_notifier")
                    ),
                    (password,),
                )
    fd,name=tempfile.mkstemp(prefix=".notifier-",dir="/etc/quizforge")
    try:
        os.fchmod(fd,0o600)
        os.write(fd,("NOTIFIER_DB_PASSWORD="+password+"\n").encode())
        os.fsync(fd)
        os.close(fd)
        fd=-1
        os.replace(name,destination)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.exists(name):
            os.unlink(name)
PY

test -s /etc/quizforge/notifier.env
test "$(stat -c %a /etc/quizforge/notifier.env)" = "600"
notifier_credential_ready=true

# Security postconditions. Runtime roles must remain restricted.
test "$(dbq "SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)::int FROM pg_roles WHERE rolname='quizforge_app'")" = "0"
test "$(dbq "SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)::int FROM pg_roles WHERE rolname='quizforge_notifier'")" = "0"
test "$(dbq "SELECT (relrowsecurity)::int FROM pg_class WHERE oid='app.cards'::regclass")" = "1"
test "$(dbq "SELECT (relrowsecurity)::int FROM pg_class WHERE oid='app.card_review_logs'::regclass")" = "1"
test "$(dbq "SELECT (relrowsecurity)::int FROM pg_class WHERE oid='app.study_notification_preferences'::regclass")" = "1"
test "$(dbq "SELECT (relrowsecurity)::int FROM pg_class WHERE oid='app.study_push_subscriptions'::regclass")" = "1"
test "$(dbq "SELECT (relrowsecurity)::int FROM pg_class WHERE oid='app.study_notification_deliveries'::regclass")" = "1"

python3 - "$applied_001" "$applied_002" "$applied_003" "$applied_004" "$applied_005" "$notifier_credential_ready" <<'PY'
import json
import sys
values=[item=="true" for item in sys.argv[1:]]
print("QF_RESULT="+json.dumps({
  "backup_completed_before_migration": True,
  "deck_migration_applied": values[0],
  "fsrs_migration_applied": values[1],
  "notification_preferences_migration_applied": values[2],
  "push_subscriptions_migration_applied": values[3],
  "notifier_role_migration_applied": values[4],
  "notifier_credential_ready": values[5],
  "all_postconditions_verified": True,
},sort_keys=True))
PY
"""


def migrations() -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for name in MIGRATION_FILES:
        path = MIGRATION_DIR / name
        raw = path.read_bytes()
        result.append(
            {
                "name": name,
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )
    return result


def make_bundle() -> tuple[bytes, bytes]:
    items = migrations()
    manifest = json.dumps(
        {"schema": 1, "migrations": items},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    archive_io = io.BytesIO()
    with tarfile.open(
        fileobj=archive_io,
        mode="w:gz",
    ) as archive:
        for item in items:
            path = MIGRATION_DIR / item["name"]
            info = tarfile.TarInfo(
                name=item["name"]
            )
            raw = path.read_bytes()
            info.size = len(raw)
            info.mode = 0o600
            archive.addfile(
                info,
                io.BytesIO(raw),
            )
    return archive_io.getvalue(), manifest


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
                "Private value reached migration summary"
            )
    if re.search(
        r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
        raw,
    ):
        raise ValueError(
            "IP reached migration summary"
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
            "lightsail_apply_reviewed_database_migrations",
        "result": "migration_failed",
        "temporary_ssh_rule_opened": False,
        "temporary_ssh_rule_closed": False,
        "baseline_firewall_restored": False,
        "backup_completed_before_migration": False,
        "all_postconditions_verified": False,
        "dns_changes_performed": False,
        "ai_configuration_changed": False,
    }
    forbidden: list[str] = []
    lightsail = None
    runner = None
    temp: Path | None = None
    try:
        items = migrations()
        if (
            [item["name"] for item in items]
            != list(MIGRATION_FILES)
            or not all(
                SHA256_RE.fullmatch(
                    item["sha256"]
                )
                for item in items
            )
        ):
            raise ValueError(
                "Reviewed migration set invalid"
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
        ip = static.get("ipAddress")
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
        forbidden.extend([admin, ip])
        before = (
            lightsail.get_instance_port_states(
                instanceName=INSTANCE_NAME
            ).get("portStates", [])
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
                "cidrs": [runner + "/32"],
                "ipv6Cidrs": [],
                "cidrListAliases": [],
            },
        )
        report[
            "temporary_ssh_rule_opened"
        ] = True

        known = scan_host(ip, pins)
        access = (
            lightsail.get_instance_access_details(
                instanceName=INSTANCE_NAME,
                protocol="ssh",
            )["accessDetails"]
        )
        private_key = access.get(
            "privateKey"
        )
        cert_key = access.get("certKey")
        username = access.get("username")
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
                prefix="quizforge-migrations-"
            )
        )
        temp.chmod(0o700)
        key = temp / "key"
        cert = temp / "key-cert.pub"
        hosts = temp / "known_hosts"
        archive_path = temp / "migrations.tar.gz"
        manifest_path = temp / "manifest.json"
        key.write_text(private_key)
        key.chmod(0o600)
        cert.write_text(
            cert_key
            + (
                ""
                if cert_key.endswith("\n")
                else "\n"
            )
        )
        cert.chmod(0o600)
        hosts.write_text(known)
        hosts.chmod(0o600)
        archive, manifest = make_bundle()
        archive_path.write_bytes(archive)
        archive_path.chmod(0o600)
        manifest_path.write_bytes(manifest)
        manifest_path.chmod(0o600)

        token = hashlib.sha256(
            manifest
        ).hexdigest()[:20]
        remote_archive = (
            f"/tmp/qf-migrations-{token}.tgz"
        )
        remote_manifest = (
            f"/tmp/qf-migrations-{token}.json"
        )
        subprocess.run(
            scp_command(
                key,
                cert,
                hosts,
                username,
                ip,
                archive_path,
                remote_archive,
            ),
            timeout=60,
            check=True,
        )
        subprocess.run(
            scp_command(
                key,
                cert,
                hosts,
                username,
                ip,
                manifest_path,
                remote_manifest,
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
                remote_archive,
                remote_manifest,
            ),
            input=REMOTE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
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
                "Unexpected migration output"
            )
        state = json.loads(values[0])
        required = (
            "backup_completed_before_migration",
            "all_postconditions_verified",
        )
        if not all(
            state.get(name) is True
            for name in required
        ):
            raise ValueError(
                "Migration acceptance incomplete"
            )
        for name in (
            "backup_completed_before_migration",
            "deck_migration_applied",
            "fsrs_migration_applied",
            "notification_preferences_migration_applied",
            "push_subscriptions_migration_applied",
            "notifier_role_migration_applied",
            "notifier_credential_ready",
            "all_postconditions_verified",
        ):
            report[name] = state.get(
                name
            )
        report["result"] = (
            "production_database_migrations_applied"
        )

    except ClientError as error:
        report["error_code"] = safe_code(
            error.response.get(
                "Error",
                {},
            ).get("Code"),
            "AWS_MIGRATION_FAILED",
        )
    except subprocess.CalledProcessError as error:
        report["error_code"] = (
            "REMOTE_MIGRATION_FAILED"
        )
        report[
            "remote_return_code"
        ] = error.returncode
    except subprocess.TimeoutExpired:
        report["error_code"] = (
            "MIGRATION_TIMEOUT"
        )
    except Exception as error:
        report["error_code"] = safe_code(
            type(error).__name__,
            "PRIVATE_MIGRATION_FAILED",
        )
    finally:
        if (
            lightsail is not None
            and runner
        ):
            try:
                lightsail.close_instance_public_ports(
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
                    "temporary_ssh_rule_closed"
                ] = True
                after = (
                    lightsail.get_instance_port_states(
                        instanceName=INSTANCE_NAME
                    ).get("portStates", [])
                )
                report[
                    "baseline_firewall_restored"
                ] = (
                    normalized_ports(after)
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
                    type(error).__name__,
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
            == "production_database_migrations_applied"
            and not report.get(
                "baseline_firewall_restored"
            )
        ):
            report["result"] = (
                "migrations_applied_firewall_cleanup_unverified"
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
        == "production_database_migrations_applied"
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
