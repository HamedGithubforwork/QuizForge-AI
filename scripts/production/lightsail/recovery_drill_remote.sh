#!/usr/bin/env bash
# Restore the real encrypted recovery point and run an isolated application canary.
set -euo pipefail

archive="$1"
key="$2"
bundle="$3"
postgres_image="$4"
expected_content_sha256="$5"
runtime_images="$6"
redis_image="$7"

case "$expected_content_sha256" in
  (*[!0-9a-f]*|'') exit 31 ;;
esac
test "${#expected_content_sha256}" -eq 64
printf '%s' "$postgres_image" | grep -Eq '^docker\.io/library/postgres@sha256:[a-f0-9]{64}$'
printf '%s' "$redis_image" | grep -Eq '^docker\.io/library/redis@sha256:[a-f0-9]{64}$'
test -s "$archive"
test -s "$key"
test -s "$bundle"
test -s "$runtime_images"

work="$(mktemp -d /tmp/quizforge-recovery.XXXXXX)"
db_container="quizforge-recovery-db"
redis_container="quizforge-recovery-redis"
api_container="quizforge-recovery-api"
identity_container="quizforge-recovery-identity"
guard_container="quizforge-recovery-guard"
api_image="quizforge-recovery-api:locked"
operations_image="quizforge-recovery-operations:locked"
stage="VALIDATE_INPUTS"

cleanup() {
  docker rm -f "$guard_container" "$identity_container" "$api_container" "$redis_container" >/dev/null 2>&1 || true
  docker rm -f -v "$db_container" >/dev/null 2>&1 || true
  rm -rf "$work" "$archive" "$key" "$bundle" "$runtime_images"
}
trap 'printf "QF_FAILURE_STAGE=%s\n" "$stage" >&2' ERR
trap cleanup EXIT

stage="UNPACK_BUNDLE"
tar -xzf "$bundle" -C "$work"
for path in lightsail_backup.py schema.sql generation_budget.sql requirements.lock public-source.json; do
  test -s "$work/$path"
done

stage="INSTALL_PYTHON_VENV"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-venv openssl >/dev/null
python3 -m venv "$work/venv"

stage="INSTALL_PYTHON_DEPS"
"$work/venv/bin/python" -m pip install --disable-pip-version-check --require-hashes \
  -r "$work/requirements.lock" >/dev/null

stage="GENERATE_DB_PASSWORD"
password="$("$work/venv/bin/python" - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
)"

stage="PREPARE_DB_TLS"
install -d -m 0700 "$work/db-tls"
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 2 \
  -subj '/CN=QuizForge Recovery Drill CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$work/db-tls/ca.key" -out "$work/db-tls/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -sha256 -nodes \
  -subj '/CN=db.quizforge.internal' \
  -addext 'subjectAltName=DNS:db.quizforge.internal' \
  -keyout "$work/db-tls/server.key" -out "$work/db-tls/server.csr" >/dev/null 2>&1
cat > "$work/db-tls/server.ext" <<'EOF'
subjectAltName=DNS:db.quizforge.internal
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -sha256 -days 2 \
  -in "$work/db-tls/server.csr" -CA "$work/db-tls/ca.crt" -CAkey "$work/db-tls/ca.key" \
  -CAcreateserial -extfile "$work/db-tls/server.ext" -out "$work/db-tls/server.crt" >/dev/null 2>&1
openssl verify -CAfile "$work/db-tls/ca.crt" "$work/db-tls/server.crt" >/dev/null
rm -f "$work/db-tls/ca.key" "$work/db-tls/server.csr" "$work/db-tls/server.ext" "$work/db-tls/ca.srl"
chown 999:999 "$work/db-tls/server.key" "$work/db-tls/server.crt"
chmod 0600 "$work/db-tls/server.key"
chmod 0644 "$work/db-tls/server.crt" "$work/db-tls/ca.crt"

stage="PULL_POSTGRES"
docker pull "$postgres_image" >/dev/null 2>&1

stage="START_POSTGRES"
docker run -d --name "$db_container" \
  --memory 512m --memory-swap 512m --cpus 1.0 --pids-limit 160 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
  -v "$work/db-tls:/run/quizforge:ro" \
  -e POSTGRES_DB=quizforge \
  -e POSTGRES_USER=quizforge_owner \
  -e POSTGRES_PASSWORD="$password" \
  -p 127.0.0.1:5432:5432 \
  "$postgres_image" \
  postgres -c ssl=on -c ssl_cert_file=/run/quizforge/server.crt -c ssl_key_file=/run/quizforge/server.key >/dev/null

stage="WAIT_POSTGRES"
ready=0
for _ in $(seq 1 90); do
  if docker exec "$db_container" pg_isready -q -U quizforge_owner -d quizforge; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" -eq 1

stage="RESTORE_DATABASE"
RECOVERY_WORK="$work" RECOVERY_ARCHIVE="$archive" RECOVERY_KEY="$key" RECOVERY_DB_PASSWORD="$password" EXPECTED_CONTENT_SHA256="$expected_content_sha256" "$work/venv/bin/python" - <<'PY'
import json
import os
from pathlib import Path
import secrets
import sys

import psycopg
from psycopg import sql

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
    port=5432,
    dbname="quizforge",
    user="quizforge_owner",
    password=os.environ["RECOVERY_DB_PASSWORD"],
    autocommit=True,
    connect_timeout=10,
    sslmode="require",
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

    passwords = {
        "quizforge_app": secrets.token_urlsafe(48),
        "quizforge_identity": secrets.token_urlsafe(48),
        "quizforge_generation": secrets.token_urlsafe(48),
    }
    with conn.transaction():
        for role, role_password in passwords.items():
            with psycopg.ClientCursor(conn) as cursor:
                cursor.execute(
                    sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)),
                    (role_password,),
                )
    for filename, role in (
        ("app.password", "quizforge_app"),
        ("identity.password", "quizforge_identity"),
        ("generation.password", "quizforge_generation"),
    ):
        path = root / filename
        path.write_text(passwords[role] + "\n", encoding="utf-8")
        path.chmod(0o600)
finally:
    conn.close()
PY

stage="LOAD_APPLICATION_IMAGES"
docker load -i "$runtime_images" >/dev/null
docker image inspect "$api_image" >/dev/null
docker image inspect "$operations_image" >/dev/null
docker pull "$redis_image" >/dev/null 2>&1

app_password="$(cat "$work/app.password")"
identity_password="$(cat "$work/identity.password")"
generation_password="$(cat "$work/generation.password")"
legacy_url="$("$work/venv/bin/python" - "$work/public-source.json" <<'PY'
import json,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
assert set(value)=={"legacy_url","legacy_publishable_key"}
assert value["legacy_url"]=="https://vfxmsvphgcaizqnbyjip.supabase.co"
print(value["legacy_url"])
PY
)"
legacy_key="$("$work/venv/bin/python" - "$work/public-source.json" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1],encoding="utf-8"))
key=value["legacy_publishable_key"]
assert re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{20,}",key)
print(key)
PY
)"

stage="START_RECOVERY_RUNTIME"
docker run -d --name "$redis_container" \
  --network host --read-only --user 999:999 --memory 64m --memory-swap 64m --pids-limit 96 \
  --tmpfs /data:rw,nosuid,nodev,size=32m \
  "$redis_image" redis-server --port 6379 --save "" --appendonly no --maxmemory 32mb --maxmemory-policy allkeys-lru >/dev/null

docker run -d --name "$guard_container" \
  --network host --read-only --user 10001:10001 --memory 96m --memory-swap 96m --pids-limit 96 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --add-host db.quizforge.internal:127.0.0.1 \
  -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e PGHOST=db.quizforge.internal -e PGPORT=5432 -e PGDATABASE=quizforge \
  -e PGUSER=quizforge_generation -e PGPASSWORD="$generation_password" \
  -e PGSSLROOTCERT=/run/quizforge/db-ca.pem \
  -e OPENAI_API_KEY=disabled-recovery-canary-no-provider-key \
  -v "$work/db-tls/ca.crt:/run/quizforge/db-ca.pem:ro" \
  "$operations_image" python generation_guard.py >/dev/null

docker run -d --name "$api_container" \
  --network host --read-only --user 10001:10001 --memory 704m --memory-swap 704m --pids-limit 96 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --add-host db.quizforge.internal:127.0.0.1 \
  -e AUTH_PROVIDER=cognito \
  -e COGNITO_USER_POOL_ID=ca-central-1_RecoveryCanary \
  -e COGNITO_CLIENT_ID=recoverycanaryclient \
  -e HISTORY_BACKEND=postgres \
  -e HISTORY_DB_HOST=db.quizforge.internal -e HISTORY_DB_PORT=5432 -e HISTORY_DB_NAME=quizforge \
  -e HISTORY_DB_USER=quizforge_app -e HISTORY_DB_PASSWORD="$app_password" -e HISTORY_DB_POOL_SIZE=1 \
  -e HISTORY_DB_SSLROOTCERT=/run/quizforge/db-ca.pem \
  -e ALLOWED_ORIGINS=https://quizfromnotes.com \
  -e REDIS_URL=redis://127.0.0.1:6379/0 \
  -e OPENAI_API_KEY=production-budget-guard -e OPENAI_BASE_URL=http://127.0.0.1:8002/v1 \
  -e PDF_PROCESS_ISOLATION=true -e PDF_BACKGROUND_JOBS=false -e OMP_THREAD_LIMIT=1 \
  -v "$work/db-tls/ca.crt:/run/quizforge/db-ca.pem:ro" \
  "$api_image" uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --no-proxy-headers >/dev/null

docker run -d --name "$identity_container" \
  --network host --read-only --user 10001:10001 --memory 128m --memory-swap 128m --pids-limit 96 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --add-host db.quizforge.internal:127.0.0.1 \
  -e AUTH_PROVIDER=cognito \
  -e COGNITO_USER_POOL_ID=ca-central-1_RecoveryCanary \
  -e COGNITO_CLIENT_ID=recoverycanaryclient \
  -e IDENTITY_ENVIRONMENT=production -e PRODUCTION_DATABASE_TARGET=lightsail \
  -e IDENTITY_ALLOWED_ORIGIN=https://quizfromnotes.com \
  -e IDENTITY_SUPABASE_URL="$legacy_url" -e IDENTITY_SUPABASE_PUBLISHABLE_KEY="$legacy_key" \
  -e IDENTITY_DB_HOST=db.quizforge.internal -e IDENTITY_DB_PORT=5432 -e IDENTITY_DB_NAME=quizforge \
  -e IDENTITY_DB_USER=quizforge_identity -e IDENTITY_DB_PASSWORD="$identity_password" -e IDENTITY_DB_POOL_SIZE=1 \
  -e IDENTITY_DB_SSLROOTCERT=/run/quizforge/db-ca.pem \
  -v "$work/db-tls/ca.crt:/run/quizforge/db-ca.pem:ro" \
  "$api_image" uvicorn identity_app:create_identity_app --factory --host 127.0.0.1 --port 8001 --workers 1 --no-access-log --no-proxy-headers >/dev/null

stage="VERIFY_RECOVERY_RUNTIME"
"$work/venv/bin/python" - <<'PY'
import json
import time
import urllib.error
import urllib.request

def wait_status(url, expected, *, data=None, headers=None):
    last = None
    for _ in range(60):
        try:
            request = urllib.request.Request(url, data=data, headers=headers or {})
            with urllib.request.urlopen(request, timeout=3) as response:
                last = response.status
                response.read(4096)
        except urllib.error.HTTPError as error:
            last = error.code
            error.read(4096)
        except OSError:
            last = None
        if last == expected:
            return
        time.sleep(1)
    raise RuntimeError(f"recovery runtime endpoint did not reach expected status {expected}")

wait_status("http://127.0.0.1:8000/api/health", 200)
wait_status("http://127.0.0.1:8000/api/quiz-history", 401)
wait_status("http://127.0.0.1:8001/identity/session", 403)

body = json.dumps({
    "model": "gpt-5.6-luna",
    "input": [{"role": "user", "content": "recovery canary must remain disabled"}],
    "max_output_tokens": 8,
}).encode()
wait_status(
    "http://127.0.0.1:8002/v1/responses",
    429,
    data=body,
    headers={"Authorization": "Bearer production-budget-guard", "Content-Type": "application/json"},
)
PY

stage="STOP_RECOVERY_RUNTIME"
docker rm -f "$guard_container" "$identity_container" "$api_container" "$redis_container" >/dev/null
for name in "$guard_container" "$identity_container" "$api_container" "$redis_container"; do
  ! docker ps --format '{{.Names}}' | grep -Fxq "$name"
done

python3 - <<'PY'
import json
print("QF_RESULT=" + json.dumps({
    "archive_decrypted": True,
    "target_schema_matched": True,
    "dry_run_reconciled": True,
    "committed_restore_reconciled": True,
    "model_spending_disabled": True,
    "identity_challenges_invalidated": True,
    "application_images_loaded": True,
    "application_database_tls_verified": True,
    "api_health_passed": True,
    "identity_boundary_passed": True,
    "generation_disabled_canary_passed": True,
    "recovery_runtime_stopped": True,
    "production_services_touched": False,
}, sort_keys=True))
PY
