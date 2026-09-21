"""CI-only synthetic Compose startup: TLS DB, restricted roles and disabled AI.

Requires Docker on a disposable GitHub runner. No cloud credentials, real model
key, public certificate issuance, source data or AWS connection are used.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import urlopen, Request

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_lightsail_configuration import fixture
from lightsail.render import render
from lightsail_initialize import initialize


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not os.environ.get('RUNNER_TEMP'):
        raise ValueError('This writes synthetic host fixture paths only on a disposable CI runner')
    root = Path(os.environ['RUNNER_TEMP']) / 'lightsail-runtime'
    render(fixture(), root)
    for name in ('postgresql.conf', 'pg_hba.conf', 'Caddyfile'):
        (root / name).chmod(0o644)
    secrets = Path('/etc/quizforge')
    postgres = secrets / 'postgres'
    postgres.mkdir(parents=True, mode=0o700)
    secrets.chmod(0o700)
    data = Path('/var/lib/quizforge')
    for name, uid in (('postgres', 999), ('pdf-jobs', 10001), ('caddy-data', 10001), ('caddy-config', 10001)):
        path = data / name
        path.mkdir(parents=True, mode=0o700)
        os.chown(path, uid, uid)
    def private(path, content):
        path.write_text(content)
        path.chmod(0o600)
    private(postgres / 'owner-password', 'synthetic-ci-owner-password\n')
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=CI-only-CA',
        '-keyout', str(root/'ca.key'), '-out', str(secrets/'db-ca.pem'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=db.quizforge.internal',
        '-keyout', str(postgres/'server.key'), '-out', str(root/'db.csr'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (root/'extensions').write_text('subjectAltName=DNS:db.quizforge.internal\n')
    run('openssl', 'x509', '-req', '-in', str(root/'db.csr'), '-CA', str(secrets/'db-ca.pem'), '-CAkey', str(root/'ca.key'),
        '-CAcreateserial', '-days', '1', '-extfile', str(root/'extensions'), '-out', str(postgres/'server.crt'),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path in (postgres, *postgres.iterdir()):
        os.chown(path, 999, 999)
    (postgres/'server.key').chmod(0o600)
    with Path('/etc/hosts').open('a') as hosts:
        hosts.write('\n127.0.0.1 db.quizforge.internal\n')
    # Rehearsal images only. Production rendering always requires pinned digests.
    stack = json.loads((root/'compose.json').read_text())
    tags = {'db': 'postgres:17', 'redis': 'redis:7', 'web': 'caddy:2', 'api': 'quizforge-ci-api',
            'identity': 'quizforge-ci-api', 'guard': 'quizforge-ci-operations'}
    for name, service in stack['services'].items():
        service['image'] = tags[name]
        service.pop('cgroup_parent')
    for name in ('api.env', 'identity.env', 'generation.env'):
        private(secrets/name, '')
    (root/'compose.json').write_text(json.dumps(stack))
    command = ['docker', 'compose', '-f', str(root/'compose.json')]
    def compose(*args): run(*command, *args, stdout=subprocess.DEVNULL)
    try:
        compose('config', '--quiet')
        compose('up', '-d', '--wait', 'db', 'redis')
        env = dict(PRODUCTION_DATABASE_TARGET='lightsail', PGHOST='db.quizforge.internal', PGDATABASE='quizforge',
                   PGUSER='quizforge_owner', PGPASSWORD='synthetic-ci-owner-password', PGSSLROOTCERT=str(secrets/'db-ca.pem'))
        # Remove only the empty fixture credential files before the fresh-only initializer.
        (secrets/'api.env').unlink()
        (secrets/'identity.env').unlink()
        initialize(env, secrets)
        private(secrets/'generation.env', (secrets/'generation-db.env').read_text() + 'OPENAI_API_KEY=synthetic-not-a-model-key\n')
        from database import options
        with psycopg.connect(**options(env)) as conn:
            assert conn.execute('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()').fetchone()['ssl']
            assert not conn.execute('SELECT enabled FROM billing.generation_policy').fetchone()['enabled']
        # Both plaintext and a trusted certificate with the wrong hostname must fail.
        for overrides in ({'sslmode': 'disable'}, {'host': '127.0.0.1'}):
            try:
                with psycopg.connect(**(options(env) | overrides)): pass
            except psycopg.OperationalError:
                pass
            else:
                raise AssertionError('Unverified database transport was accepted')
        compose('up', '-d', '--wait', 'api', 'identity', 'guard')
        with urlopen('http://127.0.0.1:8000/api/health', timeout=5) as response:
            assert response.status == 200
        try:
            urlopen('http://127.0.0.1:8001/identity/session', timeout=5)
        except HTTPError as error:
            assert error.code == 403
        else:
            raise AssertionError('Identity accepted an untrusted origin')
        # Exercise the actual loopback gateway inside the API network namespace.
        probe = '''import urllib.request,urllib.error,json,time
body=json.dumps({'model':'gpt-5.6-luna','input':[{'role':'user','content':'synthetic'}]}).encode()
for i in range(30):
 try:
  urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8002/v1/responses',body,{'Authorization':'Bearer production-budget-guard','Content-Type':'application/json'}),timeout=5)
 except urllib.error.HTTPError as e:
  assert e.code == 429,e.code
  break
 except urllib.error.URLError:
  time.sleep(1)
 else: raise AssertionError('Disabled budget allowed generation')
else: raise AssertionError('Gateway did not start')
'''
        compose('exec', '-T', 'api', 'python', '-c', probe)
        compose('run', '--rm', '--no-deps', 'web', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile')
        compose('restart', 'api', 'guard')
        compose('up', '-d', '--wait', 'api', 'guard')
        compose('exec', '-T', 'api', 'python', '-c', probe)
        print('PASS: Compose startup/restart; verified TLS; separate runtime roles; disabled gateway; Caddy validation')
    finally:
        compose('down', '--timeout', '10')


if __name__ == '__main__': main()
