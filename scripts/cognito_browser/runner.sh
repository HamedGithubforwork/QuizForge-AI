#!/usr/bin/env bash
# Trusted controller only. Reviewed application images never receive AWS credentials.
set -euo pipefail
: "${RUNNER_TEMP:?}"
: "${POSTGRES_CONTAINER:?}"
test "${GITHUB_ACTIONS:-}" = true
network=quizforge-cognito-browser
case "${1:?}" in
  prepare)
    docker network create "$network" >/dev/null
    docker network connect --alias postgres "$network" "$POSTGRES_CONTAINER"
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
      -subj /CN=postgres -addext 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1' \
      -keyout "$RUNNER_TEMP/browser-server.key" -out "$RUNNER_TEMP/browser-server.crt" >/dev/null 2>&1
    docker cp "$RUNNER_TEMP/browser-server.key" "$POSTGRES_CONTAINER:/var/lib/postgresql/server.key"
    docker cp "$RUNNER_TEMP/browser-server.crt" "$POSTGRES_CONTAINER:/var/lib/postgresql/server.crt"
    docker exec -u root "$POSTGRES_CONTAINER" chown postgres:postgres /var/lib/postgresql/server.key /var/lib/postgresql/server.crt
    docker exec -u root "$POSTGRES_CONTAINER" chmod 600 /var/lib/postgresql/server.key
    docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl='on'"
    docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/server.crt'"
    docker exec -u postgres "$POSTGRES_CONTAINER" psql -U postgres -d quizforge_rehearsal -c "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/server.key'"
    docker exec -u postgres "$POSTGRES_CONTAINER" sh -c 'sed -i "1ihostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject" "$PGDATA/pg_hba.conf"'
    docker restart "$POSTGRES_CONTAINER" >/dev/null
    ready=false
    for attempt in $(seq 1 30); do
      if docker exec "$POSTGRES_CONTAINER" pg_isready -U postgres -d quizforge_rehearsal >/dev/null; then ready=true; break; fi
      sleep 1
    done
    test "$ready" = true
    echo "PGSSLROOTCERT=$RUNNER_TEMP/browser-server.crt" >> "$GITHUB_ENV"
    docker run -d --name qf-browser-redis --network "$network" --network-alias redis \
      --read-only --user 999:999 --cap-drop ALL --security-opt no-new-privileges --tmpfs /data \
      redis:7-alpine redis-server --save '' --appendonly no >/dev/null
    ;;
  run)
    if test "${QUIZFORGE_PREFLIGHT:-}" != 1; then docker load --input /tmp/quizforge-browser-images/images.tar >/dev/null; fi
    for service in api identity; do
      if test "$service" = api; then role=quizforge_app; port=8000; app=main:app; factory=();
      else role=quizforge_identity; port=8001; app=identity_app:create_identity_app; factory=(--factory); fi
      docker run -d --name "qf-browser-$service" --network "$network" --network-alias "$service" \
        --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
        --tmpfs /tmp:rw,nosuid,nodev,size=256m --env-file "$RUNNER_TEMP/$role.env" \
        --mount "type=bind,source=$RUNNER_TEMP/browser-server.crt,target=/run/test-ca.pem,readonly" \
        quizforge-browser-api:tested uvicorn "$app" "${factory[@]}" --host 0.0.0.0 --port "$port" --no-access-log >/dev/null
    done
    docker run --name qf-browser-driver --network "$network" \
      --read-only --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:rw,nosuid,nodev,size=512m --shm-size 256m \
      --mount "type=bind,source=$RUNNER_TEMP/cognito-browser-bundle.json,target=/run/fixture.json,readonly" \
      --env "QUIZFORGE_PREFLIGHT=${QUIZFORGE_PREFLIGHT:-0}" \
      quizforge-browser-driver:tested
    ;;
  diagnose)
    # Only the credentialless, provider-free boot test may print startup logs.
    test "${QUIZFORGE_PREFLIGHT:-}" = 1
    python - <<'PY'
import os, pathlib, subprocess
root = pathlib.Path(os.environ['RUNNER_TEMP'])
secrets = [os.environ.get('PGPASSWORD','')]
for name in ('quizforge_app.env','quizforge_identity.env'):
    path = root/name
    if path.exists(): secrets += [line.split('=',1)[1] for line in path.read_text().splitlines() if '_PASSWORD=' in line]
for service in ('api','identity'):
    result = subprocess.run(['docker','logs','qf-browser-'+service],capture_output=True,text=True)
    log = (result.stdout+result.stderr)[-12000:]
    for secret in secrets:
        if secret: log=log.replace(secret,'[redacted]')
    print(service+' offline startup:',log)
PY
    ;;
  cleanup)
    docker rm -f qf-browser-driver qf-browser-api qf-browser-identity qf-browser-redis >/dev/null 2>&1 || true
    docker network disconnect "$network" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    rm -f "$RUNNER_TEMP/cognito-browser-bundle.json" "$RUNNER_TEMP/quizforge_app.env" "$RUNNER_TEMP/quizforge_identity.env" "$RUNNER_TEMP/browser-server.key" "$RUNNER_TEMP/browser-server.crt"
    ;;
  *) exit 2 ;;
esac
