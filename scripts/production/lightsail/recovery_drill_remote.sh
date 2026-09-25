#!/usr/bin/env bash
# Restore the real encrypted recovery point only on a disposable isolated host.
set -euo pipefail

archive="$1"
key="$2"
bundle="$3"
postgres_image="$4"
expected_content_sha256="$5"

case "$expected_content_sha256" in
  (*[!0-9a-f]*|'') exit 31 ;;
esac
test "${#expected_content_sha256}" -eq 64
test -s "$archive"
test -s "$key"
test -s "$bundle"

work="$(mktemp -d /tmp/quizforge-recovery.XXXXXX)"
container="quizforge-recovery-db"

cleanup() {
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  rm -rf "$work" "$archive" "$key" "$bundle"
}
trap cleanup EXIT

tar -xzf "$bundle" -C "$work"
for path in lightsail_backup.py schema.sql generation_budget.sql requirements.lock; do
  test -s "$work/$path"
done

python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip install --disable-pip-version-check --require-hashes   -r "$work/requirements.lock" >/dev/null

password="$("$work/venv/bin/python" - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

docker pull "$postgres_image" >/dev/null 2>&1
docker run -d --name "$container"   --memory 512m --memory-swap 512m --cpus 1.0 --pids-limit 160   --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m   --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m   -e POSTGRES_DB=quizforge   -e POSTGRES_USER=quizforge_owner   -e POSTGRES_PASSWORD="$password"   -p 127.0.0.1:55432:5432   "$postgres_image" >/dev/null

ready=0
for _ in $(seq 1 90); do
  if docker exec "$container" pg_isready -q -U quizforge_owner -d quizforge; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" -eq 1

RECOVERY_WORK="$work" RECOVERY_ARCHIVE="$archive" RECOVERY_KEY="$key" RECOVERY_DB_PASSWORD="$password" EXPECTED_CONTENT_SHA256="$expected_content_sha256" "$work/venv/bin/python" - <<'PY'
import json
import os
from pathlib import Path
import sys

import psycopg

root = Path(os.environ["RECOVERY_WORK"])
sys.path.insert(0, str(root))
import lightsail_backup as backup

expected = os.environ["EXPECTED_CONTENT_SHA256"]
key = backup.private_read(Path(os.environ["RECOVERY_KEY"]), 32)
archive = backup.private_read(Path(os.environ["RECOVERY_ARCHIVE"]), backup.MAX_ARCHIVE_BYTES)
snapshot = backup.unseal(archive, key)
if snapshot["sha256"] != expected:
    raise ValueError("Authenticated snapshot digest differs from receipt")

conn = psycopg.connect(
    host="127.0.0.1",
    port=55432,
    dbname="quizforge",
    user="quizforge_owner",
    password=os.environ["RECOVERY_DB_PASSWORD"],
    autocommit=True,
    connect_timeout=10,
    options="-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000",
)
try:
    if conn.execute("SELECT 1 FROM pg_namespace WHERE nspname IN ('app','billing')").fetchone():
        raise ValueError("Disposable restore target is not fresh")
    with conn.transaction():
        conn.execute((root / "schema.sql").read_text(encoding="utf-8"))
        conn.execute((root / "generation_budget.sql").read_text(encoding="utf-8"))

    if backup.schema_state(conn) != snapshot["schema"]:
        raise ValueError("Fresh target schema/security fingerprint differs")

    dry = backup.restore_snapshot(conn, snapshot, commit=False)
    if not (
        dry["dry_run"] is True
        and dry["reconciled"] is True
        and dry["model_spending_enabled"] is False
        and dry["identity_challenges_invalidated"] is True
    ):
        raise ValueError("Dry-run recovery acceptance incomplete")

    committed = backup.restore_snapshot(conn, snapshot, commit=True)
    if not (
        committed["dry_run"] is False
        and committed["reconciled"] is True
        and committed["model_spending_enabled"] is False
        and committed["identity_challenges_invalidated"] is True
    ):
        raise ValueError("Committed recovery acceptance incomplete")

    challenge_empty = conn.execute("SELECT count(*)=0 FROM app.identity_challenges").fetchone()[0]
    policy_disabled = conn.execute(
        "SELECT enabled=false FROM billing.generation_policy WHERE singleton=true"
    ).fetchone()
    if challenge_empty is not True or not policy_disabled or policy_disabled[0] is not True:
        raise ValueError("Recovery interlock verification failed")

    print("QF_RESULT=" + json.dumps({
        "archive_decrypted": True,
        "target_schema_matched": True,
        "dry_run_reconciled": True,
        "committed_restore_reconciled": True,
        "model_spending_disabled": True,
        "identity_challenges_invalidated": True,
        "production_services_touched": False,
    }, sort_keys=True))
finally:
    conn.close()
PY
