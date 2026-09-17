#!/usr/bin/env bash
# Configure the disposable GitHub Actions PostgreSQL service; never production.
set -euo pipefail
: "${POSTGRES_CONTAINER:?Missing CI service container}"
: "${RUNNER_TEMP:?Missing temporary directory}"
test "${GITHUB_ACTIONS:-}" = "true"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$RUNNER_TEMP/history-server.key" -out "$RUNNER_TEMP/history-server.crt" >/dev/null 2>&1
docker cp "$RUNNER_TEMP/history-server.key" "$POSTGRES_CONTAINER:/var/lib/postgresql/server.key"
docker cp "$RUNNER_TEMP/history-server.crt" "$POSTGRES_CONTAINER:/var/lib/postgresql/server.crt"
docker exec -u root "$POSTGRES_CONTAINER" chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt
docker exec -u root "$POSTGRES_CONTAINER" chmod 600 /var/lib/postgresql/server.key
docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl='on'"
docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'"
docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'"
docker exec -u postgres "$POSTGRES_CONTAINER" sh -c 'sed -i "1ihostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject" "$PGDATA/pg_hba.conf"'
docker restart "$POSTGRES_CONTAINER" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres -d quizforge_rehearsal >/dev/null; then
    echo "PGSSLROOTCERT=$RUNNER_TEMP/history-server.crt" >> "$GITHUB_ENV"
    exit 0
  fi
  sleep 1
done
echo "TLS PostgreSQL service did not become ready" >&2
exit 1
