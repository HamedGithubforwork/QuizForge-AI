"""Measure the actual app, PostgreSQL, Redis, identity and guard in one cgroup.

Synthetic files and accounts only; Docker must have no network and no swap.
All processes, fixture construction and client load count toward the memory
limit. Leave 512 MiB outside this 1536 MiB laboratory for the host OS.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from uuid import UUID

import httpx
import psycopg
import pymupdf

ROOT = Path('/tmp/capacity')
CGROUP = Path('/sys/fs/cgroup')
RESULTS = Path('/results')
PROCESSES = []
FAILURES = []
REPORT = {'application_sha': os.environ.get('APPLICATION_SHA'), 'cases': [], 'failures': FAILURES,
          'synthetic_data': True, 'live_aws_instance': False, 'paid_model_calls': 0}
STOP = threading.Event()
HEALTH = []


def require(condition, description):
    if not condition:
        raise RuntimeError(description)


def command(args, **kwargs):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kwargs)


def spawn(name, args, env=None):
    log = (ROOT / (name + '.log')).open('wb')
    process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    log.close()
    PROCESSES.append((name, process))
    return process


def wait_port(port):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if any(p.poll() is not None for _, p in PROCESSES):
            raise RuntimeError('A laboratory service exited during startup')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return
        except OSError:
            time.sleep(.1)
    raise RuntimeError('Laboratory service startup deadline exceeded')


def db(**kwargs):
    return psycopg.connect(host='127.0.0.1', dbname='quizforge', user='postgres',
                          sslmode='verify-full', sslrootcert=str(ROOT / 'server.crt'),
                          autocommit=True, **kwargs)


def setup():
    require(Path('/capacity-test-image').is_file(), 'Laboratory image required')
    require(sorted(p.name for p in Path('/sys/class/net').iterdir()) == ['lo'], 'Docker --network none required')
    require(not any(k.startswith(('AWS_', 'SUPABASE_')) for k in os.environ), 'Cloud credentials/configuration forbidden')
    memory = int((CGROUP / 'memory.max').read_text())
    require(memory == 1536 * 1024**2, 'Enforce exactly 1536 MiB, reserving 512 MiB of the 2 GiB host')
    require((CGROUP / 'memory.swap.max').read_text().strip() == '0', 'Swap must be disabled')
    quota, period = map(int, (CGROUP / 'cpu.max').read_text().split())
    require(quota / period in (.4, 2), 'Only burst and baseline CPU profiles are allowed')
    REPORT.update(memory_limit_mib=1536, host_reserve_mib=512, cpu_limit=quota / period)
    ROOT.mkdir(mode=0o700)
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
             '-keyout', str(ROOT / 'server.key'), '-out', str(ROOT / 'server.crt'),
             '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
    (ROOT / 'server.key').chmod(0o600)
    pg = '/usr/lib/postgresql/17/bin/'
    command([pg + 'initdb', '-D', str(ROOT / 'pg'), '--auth-local=trust', '--auth-host=scram-sha-256'])
    with (ROOT / 'pg/postgresql.conf').open('a') as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nunix_socket_directories='/tmp'\n"
                f"shared_buffers='128MB'\nmax_connections=30\nwork_mem='4MB'\n"
                f"ssl=on\nssl_cert_file='{ROOT}/server.crt'\nssl_key_file='{ROOT}/server.key'\n")
    (ROOT / 'pg/pg_hba.conf').write_text('local all all trust\nhostssl all postgres 127.0.0.1/32 trust\n'
                                      'hostssl all all 127.0.0.1/32 scram-sha-256\n')
    spawn('postgres', [pg + 'postgres', '-D', str(ROOT / 'pg')])
    wait_port(5432)
    with psycopg.connect(host='/tmp', user='postgres', autocommit=True) as owner:
        owner.execute('CREATE DATABASE quizforge')
    with db() as owner:
        for file in ('schema.sql', 'generation_budget.sql'):
            owner.execute((Path('/app/scripts/production') / file).read_text())
        for role in ('quizforge_app', 'quizforge_identity', 'quizforge_generation'):
            from psycopg import sql
            owner.execute(sql.SQL("ALTER ROLE {} PASSWORD 'synthetic-capacity-only'").format(sql.Identifier(role)))
        for n in (1, 2):
            owner.execute('INSERT INTO app.users VALUES (%s)', (UUID(int=n),))
            owner.execute('INSERT INTO app.user_identities VALUES (%s,%s,%s)',
                          ('https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Capacity', str(UUID(int=n)), UUID(int=n)))
    spawn('redis', ['redis-server', '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no',
                    '--maxmemory', '64mb', '--maxmemory-policy', 'allkeys-lru'])
    wait_port(6379)
    common = os.environ | {'CAPACITY_TEST_ONLY': 'synthetic-no-network', 'AUTH_PROVIDER': 'cognito',
                           'COGNITO_USER_POOL_ID': 'ca-central-1_Capacity', 'COGNITO_CLIENT_ID': 'capacity',
                           'HISTORY_BACKEND': 'postgres', 'REDIS_URL': 'redis://127.0.0.1:6379/0',
                           'OPENAI_API_KEY': 'synthetic-disabled', 'OPENAI_BASE_URL': 'http://127.0.0.1:8002/v1',
                           'IDENTITY_STAGING_ENABLED': 'true', 'IDENTITY_ALLOWED_ORIGIN': 'http://127.0.0.1:5173',
                           'PDF_PROCESS_ISOLATION': 'true',
                           'OMP_THREAD_LIMIT': '1'}
    for prefix, role in (('HISTORY_DB', 'quizforge_app'), ('IDENTITY_DB', 'quizforge_identity')):
        common.update({prefix + '_' + key: value for key, value in {
            'HOST': '127.0.0.1', 'NAME': 'quizforge', 'USER': role, 'PASSWORD': 'synthetic-capacity-only',
            'SSLROOTCERT': str(ROOT / 'server.crt'), 'POOL_SIZE': '2'}.items()})
    spawn('api', [sys.executable, '-m', 'uvicorn', 'api_adapter:app', '--host', '127.0.0.1', '--port', '8000', '--no-access-log'], common)
    wait_port(8000)
    spawn('identity', [sys.executable, '-m', 'uvicorn', 'identity_app:create_identity_app', '--factory',
                       '--host', '127.0.0.1', '--port', '8001', '--no-access-log'], common)
    wait_port(8001)
    spawn('guard', [sys.executable, '/app/scripts/capacity/guard_adapter.py'], common)
    wait_port(8002)
    nginx = ROOT / 'nginx.conf'
    nginx.write_text(f'''worker_processes 1;
pid {ROOT}/nginx.pid;
error_log {ROOT}/nginx.log warn;
events {{ worker_connections 128; }}
http {{
  access_log off;
  client_body_temp_path {ROOT}/body;
  proxy_temp_path {ROOT}/proxy;
  fastcgi_temp_path {ROOT}/fastcgi;
  uwsgi_temp_path {ROOT}/uwsgi;
  scgi_temp_path {ROOT}/scgi;
  server {{
    listen 127.0.0.1:8443 ssl;
    ssl_certificate {ROOT}/server.crt;
    ssl_certificate_key {ROOT}/server.key;
    client_max_body_size 16m;
    location / {{ proxy_pass http://127.0.0.1:8000; proxy_read_timeout 180s; }}
  }}
}}
''')
    spawn('proxy', ['nginx', '-c', str(nginx), '-g', 'daemon off;'])
    wait_port(8443)


def client():
    import ssl
    return httpx.Client(base_url='https://127.0.0.1:8443', verify=ssl.create_default_context(cafile=str(ROOT / 'server.crt')),
                        timeout=180, headers={'Authorization': 'Bearer capacity-1'}, trust_env=False)


def fixture(pages, scanned=False, salt='a'):
    target = pymupdf.open()
    for number in range(pages):
        text = f'QuizForge capacity biology lesson {number+1} {salt}.\n' + (
            'Photosynthesis converts sunlight into chemical energy. Chlorophyll absorbs light. '
            'Plants use water and carbon dioxide to produce glucose and oxygen. '
            'Mitochondria release stored energy through cellular respiration.\n') * 8
        source = pymupdf.open()
        page = source.new_page(width=595, height=842)
        require(page.insert_textbox(pymupdf.Rect(45, 45, 550, 790), text, fontsize=12) >= 0, 'Fixture must fit page')
        if scanned:
            pixmap = page.get_pixmap(dpi=150, alpha=False)
            dest = target.new_page(width=595, height=842)
            dest.insert_image(dest.rect, stream=pixmap.tobytes('jpeg', jpg_quality=80))
        else:
            target.insert_pdf(source)
        source.close()
    result = target.tobytes(garbage=3, deflate=True)
    target.close()
    require(len(result) < 15 * 1024**2, 'Fixture must fit the real upload limit')
    return result


def upload(payload, pages):
    start = time.monotonic()
    with client() as c:
        response = c.post('/api/documents/upload', files={'file': ('synthetic.pdf', payload, 'application/pdf')})
    duration = time.monotonic() - start
    require(response.status_code == 200, f'Upload returned {response.status_code}')
    data = response.json()
    require(data['page_count'] == pages and data['extractable_page_count'] == pages and not data['scanned_likely'],
            'All synthetic pages must be correctly recovered')
    require(all('photosynthesis' in p['preview'].lower() for p in data['pages']), 'Expected OCR content missing')
    return {'seconds': round(duration, 3), 'file_mib': round(len(payload) / 1024**2, 3), 'pages': pages}


def health_loop():
    with client() as c:
        while not STOP.wait(.2):
            start = time.monotonic()
            try:
                response = c.get('/api/health', timeout=5)
                HEALTH.append((time.monotonic() - start, response.status_code == 200))
            except Exception:
                HEALTH.append((time.monotonic() - start, False))


def case(name, call, max_seconds):
    start = time.monotonic()
    try:
        result = call()
        elapsed = time.monotonic() - start
        REPORT['cases'].append({'name': name, 'wall_seconds': round(elapsed, 3), 'result': result,
                                'max_seconds': max_seconds, 'pass': elapsed <= max_seconds})
        if elapsed > max_seconds:
            FAILURES.append(name + ': exceeded response-time target')
        print(json.dumps(REPORT['cases'][-1]), flush=True)
    except Exception as error:
        FAILURES.append(name + ': ' + str(error))
        print('CASE FAILED: ' + name + ': ' + str(error), flush=True)


def history_cycle():
    entry = {'quiz_title': 'Synthetic capacity quiz', 'source_filename': 'capacity.pdf', 'difficulty': 'easy',
             'question_type': 'multiple_choice', 'question_count': 1, 'score': 1, 'percentage': 100,
             'quiz_data': {'synthetic': True}, 'selected_answers': {'0': 1}}
    with client() as c:
        for _ in range(20):
            created = c.post('/api/quiz-history', json=entry)
            require(created.status_code == 201, 'History write failed')
            response = c.get('/api/quiz-history')
            require(response.status_code == 200, 'History read status failed')
            own = response.json()
            require(len(own['items']) == 1, 'History read failed')
            other = c.get('/api/quiz-history', headers={'Authorization': 'Bearer capacity-2'}).json()
            require(not other['items'], 'History ownership boundary failed')
            # The real create endpoint returns an empty 201; obtain its UUID by
            # reading the authenticated history response, as the browser does.
            require(c.delete('/api/quiz-history/' + own['items'][0]['id']).status_code == 204, 'History delete failed')
    return {'cycles': 20, 'ownership_checked': True}


def exercise():
    # Prebuild inputs within the same capped container, outside request timings.
    text = fixture(100)
    scans = {n: fixture(n, True, str(n)) for n in (1, 10, 30)}
    parallel = [fixture(10, True, 'concurrent-' + str(i)) for i in range(2)]
    overload = [fixture(1, True, 'overload-' + str(i)) for i in range(3)]
    too_many_pages = fixture(101)
    watcher = threading.Thread(target=health_loop, daemon=True)
    watcher.start()
    case('text_100_pages_cold', lambda: upload(text, 100), 10)
    case('scan_1_page_cold', lambda: upload(scans[1], 1), 15)
    case('scan_10_pages_cold', lambda: upload(scans[10], 10), 60)
    case('scan_30_pages_cold', lambda: upload(scans[30], 30), 120)
    def simultaneous():
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(upload, blob, 10) for blob in parallel]
            history = pool.submit(history_cycle)
            return {'uploads': [f.result() for f in futures], 'history': history.result()}
    case('two_cold_scans_with_history', simultaneous, 120)
    case('warm_10_page_scan', lambda: upload(scans[10], 10), 3)
    def bounded_overload():
        barrier = threading.Barrier(3)
        def attempt(blob):
            with client() as c:
                barrier.wait(timeout=10)
                response = c.post('/api/documents/upload', files={'file': ('synthetic.pdf', blob, 'application/pdf')})
                return response.status_code
        with ThreadPoolExecutor(max_workers=3) as pool:
            statuses = sorted(pool.map(attempt, overload))
        require(statuses == [200, 200, 429], 'Overload must accept two jobs and explicitly reject the third')
        return {'statuses': statuses}
    case('bounded_overload', bounded_overload, 30)
    with client() as c:
        require(c.post('/api/documents/upload', files={'file': ('too-many.pdf', too_many_pages, 'application/pdf')}).status_code == 413,
                'Oversized page count must fail before OCR')
    with client() as c:
        require(c.get('/api/quiz-history', headers={'Authorization': 'invalid'}).status_code == 401,
                'Test adapter accepted unauthenticated history')
    with httpx.Client(trust_env=False) as c:
        guarded = c.post('http://127.0.0.1:8002/v1/responses',
                         headers={'Authorization': 'Bearer production-budget-guard'},
                         json={'model': 'gpt-5.6-luna', 'input': [{'role': 'user', 'content': 'synthetic'}]})
        require(guarded.status_code == 429, 'Disabled model budget must reject generation')
        require(c.get('http://127.0.0.1:8001/identity/session',
                      headers={'Origin': 'http://127.0.0.1:5173'}).status_code == 401, 'Identity service unhealthy')
    STOP.set()
    watcher.join(timeout=6)
    samples = sorted(seconds for seconds, _ in HEALTH)
    REPORT['health'] = {'requests': len(HEALTH), 'failures': sum(not ok for _, ok in HEALTH),
                        'p95_seconds': round(samples[int((len(samples) - 1) * .95)], 3),
                        'max_seconds': round(max(samples), 3)}
    if REPORT['health']['failures'] or REPORT['health']['p95_seconds'] > 1:
        FAILURES.append('Health responsiveness target exceeded during PDF load')
    with db() as owner:
        REPORT['database'] = {'history_rows_after_cleanup': owner.execute('SELECT count(*) FROM app.quiz_history').fetchone()[0],
                              'model_reservations': owner.execute('SELECT count(*) FROM billing.generation_usage').fetchone()[0]}


def main():
    try:
        setup()
        exercise()
    except Exception as error:
        FAILURES.append(type(error).__name__ + ': ' + str(error))
    finally:
        STOP.set()
        if (CGROUP / 'memory.peak').exists():
            REPORT['memory_peak_mib'] = round(int((CGROUP / 'memory.peak').read_text()) / 1024**2, 2)
        if (CGROUP / 'memory.events').exists():
            REPORT['memory_events'] = dict(line.split() for line in (CGROUP / 'memory.events').read_text().splitlines())
            if int(REPORT['memory_events'].get('oom_kill', 0)):
                FAILURES.append('Container out-of-memory kill detected')
        REPORT['services_alive'] = {name: process.poll() is None for name, process in PROCESSES}
        if not all(REPORT['services_alive'].values()):
            FAILURES.append('A service exited during testing')
        REPORT['passed'] = not FAILURES
        RESULTS.mkdir(exist_ok=True)
        (RESULTS / 'capacity.json').write_text(json.dumps(REPORT, indent=2) + '\n')
        print(json.dumps(REPORT, indent=2), flush=True)
        if FAILURES:
            for path in sorted(ROOT.glob('*.log')):
                # All logs contain only synthetic local data; no production secrets exist.
                print(path.name + ':\n' + path.read_text(errors='replace')[-6000:], flush=True)
        for _, process in reversed(PROCESSES):
            process.terminate()
        for _, process in reversed(PROCESSES):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    return int(bool(FAILURES))


if __name__ == '__main__':
    raise SystemExit(main())
