"""CI-only A/B benchmark of the exact old/current handlers and PostgreSQL SQL.

Only HTTPSConnection and response delivery/logging are replaced. Real TLS/SCRAM
database connections, reservations and settlement stay on the measured path.
The worker and PostgreSQL share an internal-only Docker network and two CPUs.
No AWS resources or real model keys are used. Never run against a user database.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import threading
import time
from types import SimpleNamespace

BASELINE_SHA = "27b5c6d7457cf1d72b52c9add91ceabfff03290e"
OWNER_PASSWORD = "synthetic-benchmark-owner-only"
GENERATION_PASSWORD = "synthetic-benchmark-generation-only"


def summary(values):
    values = sorted(values)
    return {"samples": len(values), "mean_ms": statistics.mean(values),
            "p50_ms": statistics.median(values),
            "p95_ms": values[math.ceil(len(values) * .95) - 1], "max_ms": max(values)}


def worker(output):
    if os.environ.get("QUIZFORGE_ISOLATED_BENCHMARK") != "synthetic-internal-docker-only":
        raise ValueError("Run only through the disposable CI orchestrator")
    import psycopg
    import generation_guard as current
    from generation_costs import PRICING_KEY

    baseline_path = Path("/baseline/generation_guard.py")
    spec = importlib.util.spec_from_file_location("baseline_generation_guard", baseline_path)
    before = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(before)
    versions = {"before": before, "after": current}
    # Constants are synthetic and restricted to this internal network.
    owner_options = dict(host="db.quizforge.internal", port=5432, dbname="quizforge",
                         user="quizforge_owner", password=OWNER_PASSWORD, sslmode="verify-full",
                         sslrootcert="/certs/ca.pem", autocommit=True, connect_timeout=5)
    database = owner_options | {"user": "quizforge_generation", "password": GENERATION_PASSWORD,
                                "options": "-c statement_timeout=5000 -c lock_timeout=3000"}
    for _ in range(40):
        try:
            owner = psycopg.connect(**owner_options)
            break
        except psycopg.OperationalError:
            time.sleep(.5)
    else:
        raise RuntimeError("Disposable benchmark database did not become ready")
    if owner.info.dbname != "quizforge" or owner.info.host != "db.quizforge.internal":
        raise ValueError("Unexpected fixture database")
    tls = owner.execute("SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()
    assert tls[0]

    notes = "TCP provides reliable ordered delivery. UDP provides connectionless datagrams. " * 220
    request = json.dumps({"model": "gpt-5.6-luna", "input": [
        {"role": "developer", "content": "Create ten study questions using only the supplied notes."},
        {"role": "user", "content": notes}], "max_output_tokens": 8192,
        "text": {"format": {"type": "json_object"}}}).encode()
    quiz = {"questions": [{"question": f"Which protocol provides reliable delivery? ({i})",
        "options": ["TCP", "UDP", "Neither", "Both"], "answer": "TCP",
        "explanation": "TCP provides reliable ordered delivery; UDP is connectionless."} for i in range(10)]}
    response = json.dumps({"model": "gpt-5.6-luna", "service_tier": "default", "status": "completed",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(quiz)}]}],
        "usage": {"input_tokens": 5000, "output_tokens": 2000, "total_tokens": 7000}}).encode()
    delay_seconds = 0

    class SimulatedProvider:
        status = 200
        def __init__(self, host, timeout):
            assert host == "api.openai.com"
        def request(self, method, path, *, body, headers):
            assert method == "POST" and path == "/v1/responses"
            assert headers["Authorization"] == "Bearer synthetic-never-sent"
            assert json.loads(body)["input"][1]["content"] == notes
        def getresponse(self):
            if delay_seconds:
                time.sleep(delay_seconds)
            return self
        def read(self, limit):
            return response[:limit]
        def close(self):
            pass

    for module in versions.values():
        module.HTTPSConnection = SimulatedProvider
        module.print = lambda *a, **k: None  # Symmetric exclusion of console logging.
    os.environ["OPENAI_API_KEY"] = "synthetic-never-sent"

    def prepare(version, history):
        # This database/container is created solely by orchestrate(), with no host
        # ports, user data, external credentials or network route to the provider.
        owner.execute("DROP SCHEMA IF EXISTS billing CASCADE")
        if owner.execute("SELECT 1 FROM pg_roles WHERE rolname='quizforge_generation'").fetchone():
            owner.execute("DROP OWNED BY quizforge_generation")
            owner.execute("DROP ROLE quizforge_generation")
        sql_path = (Path("/baseline") if version == "before" else Path("/app")) / "generation_budget.sql"
        owner.execute(sql_path.read_text())
        with psycopg.ClientCursor(owner) as cursor:
            cursor.execute("ALTER ROLE quizforge_generation PASSWORD %s", (GENERATION_PASSWORD,))
        owner.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=1000,monthly_requests=10000")
        owner.execute("INSERT INTO billing.generation_usage(period,starts_on,requests) VALUES "
                      "('day',(now() AT TIME ZONE 'UTC')::date,0),"
                      "('month',date_trunc('month',now() AT TIME ZONE 'UTC')::date,%s)", (history,))
        if version == "after":
            owner.execute("UPDATE billing.generation_policy SET monthly_nano_usd=5000000000, "
                          "pricing_key=%s,pricing_valid_until=(now() AT TIME ZONE 'UTC')::date+1", (PRICING_KEY,))
            owner.execute("INSERT INTO billing.generation_reservations SELECT md5(n::text)::uuid,"
                          "date_trunc('month',now() AT TIME ZONE 'UTC')::date,"
                          "date_trunc('month',now() AT TIME ZONE 'UTC')::date,1000,1000 "
                          "FROM generate_series(1,%s) n", (history,))
            owner.execute("UPDATE billing.generation_usage SET accounted_nano_usd=%s WHERE period='month'", (history * 1000,))
        owner.execute("ANALYZE")

    def measure(version, concurrency, samples):
        module = versions[version]
        server = SimpleNamespace(database=database, slots=threading.BoundedSemaphore(8))
        def call(_):
            handler = module.Handler.__new__(module.Handler)
            from email.message import Message
            handler.headers = Message()
            handler.headers["Authorization"] = "Bearer production-budget-guard"
            handler.headers["Content-Length"] = str(len(request))
            handler.path = "/v1/responses"
            handler.rfile = io.BytesIO(request)
            handler.connection = SimpleNamespace(settimeout=lambda _: None)
            handler.server = server
            replies = []
            handler.reply = lambda status, body: replies.append((status, body))
            started = time.perf_counter_ns()
            handler.do_POST()
            elapsed = (time.perf_counter_ns() - started) / 1_000_000
            if len(replies) != 1 or replies[0] != (200, response):
                raise AssertionError(f"Benchmark call failed: {version}, {[r[0] for r in replies]}")
            return elapsed
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            list(pool.map(call, range(8)))  # Equal untimed warmup, including TLS/auth/function plans.
            started, cpu_started = time.perf_counter(), time.process_time()
            values = list(pool.map(call, range(samples)))
            wall, cpu = time.perf_counter() - started, time.process_time() - cpu_started
        if version == "after":
            unsettled = owner.execute("SELECT count(*) FROM billing.generation_reservations WHERE settled_nano_usd IS NULL").fetchone()[0]
            assert unsettled == 0, "Settlement must actually execute in the after arm"
            assert owner.execute("SELECT accounted_nano_usd FROM billing.generation_usage WHERE period='month'").fetchone()[0] <= 5000000000
        counters = dict(owner.execute("SELECT period,requests FROM billing.generation_usage").fetchall())
        assert counters["day"] == samples + 8
        return {"latencies_ms": values, "wall_seconds": wall, "client_cpu_seconds": cpu,
                "requests_per_second": samples / wall}

    cases = []
    for history, delay_ms in ((0, 0), (9000, 0), (0, 250)):
        delay_seconds = delay_ms / 1000
        for concurrency in (1, 8):
            rounds, samples = (4, 64) if delay_ms == 0 else (2, 16)
            arms = {"before": [], "after": []}
            for pair in range(rounds):
                order = ("before", "after") if pair % 2 == 0 else ("after", "before")
                for version in order:
                    prepare(version, history)
                    result = measure(version, concurrency, samples)
                    arms[version].append(result)
            aggregates = {}
            for version, blocks in arms.items():
                values = [v for block in blocks for v in block["latencies_ms"]]
                aggregates[version] = summary(values) | {
                    "requests_per_second": len(values) / sum(b["wall_seconds"] for b in blocks),
                    "client_cpu_ms_per_request": 1000 * sum(b["client_cpu_seconds"] for b in blocks) / len(values)}
            delta = {key: aggregates["after"][key] - aggregates["before"][key]
                     for key in ("mean_ms", "p50_ms", "p95_ms")}
            case = {"history_rows": history, "simulated_provider_delay_ms": delay_ms,
                    "concurrency": concurrency, "paired_rounds": rounds, "summary": aggregates,
                    "added_ms": delta, "raw_blocks": arms}
            cases.append(case)
            print("BENCHMARK_CASE " + json.dumps({k:v for k,v in case.items() if k != "raw_blocks"}), flush=True)
    owner.execute("UPDATE billing.generation_policy SET enabled=false")
    assert not owner.execute("SELECT enabled FROM billing.generation_policy").fetchone()[0]
    record = {"baseline_commit": BASELINE_SHA, "candidate_commit": os.environ["BENCHMARK_CANDIDATE_SHA"],
              "python": platform.python_version(), "postgres": owner.info.server_version,
              "database_tls": {"version": tls[1], "cipher": tls[2]},
              "worker_peak_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              "worker_memory_limit_mib": 96, "database_memory_limit_mib": 192,
              "shared_cpu_affinity": sorted(os.sched_getaffinity(0)),
              "request_bytes": len(request), "response_bytes": len(response),
              "real_model_calls": 0, "policy_disabled_at_finish": True,
              "method": "Exact before/after do_POST; real fresh TLS/SCRAM DB connections; simulated provider; HTTP accept/reply and console logging excluded; alternating paired order; equal warmups; no OCR or live AI latency",
              "file_sha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in
                  (baseline_path, Path('/baseline/generation_budget.sql'), Path('/app/generation_guard.py'),
                   Path('/app/generation_budget.sql'), Path('/app/generation_costs.py'))}, "cases": cases}
    Path(output).write_text(json.dumps(record, indent=2) + "\n")
    owner.close()


def orchestrate(baseline, output):
    if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
        raise ValueError("Disposable GitHub runner required; no production database is accepted")
    root = Path(os.environ["RUNNER_TEMP"]) / "quizforge-budget-benchmark"
    root.mkdir(mode=0o755)
    root.chmod(0o755)
    for name, uid in (("postgres", 999), ("data", 999), ("result", 10001)):
        path = root / name
        path.mkdir(mode=0o700)
        os.chown(path, uid, uid)
    def run(*args, **kwargs):
        return subprocess.run(args, check=True, **kwargs)
    quiet = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Benchmark-CA",
        "-keyout", str(root/'ca.key'), "-out", str(root/'ca.pem'), **quiet)
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=db.quizforge.internal",
        "-keyout", str(root/'postgres/server.key'), "-out", str(root/'db.csr'), **quiet)
    (root/'extensions').write_text('subjectAltName=DNS:db.quizforge.internal\n')
    run("openssl", "x509", "-req", "-in", str(root/'db.csr'), "-CA", str(root/'ca.pem'), "-CAkey", str(root/'ca.key'),
        "-CAcreateserial", "-days", "1", "-extfile", str(root/'extensions'), "-out", str(root/'postgres/server.crt'), **quiet)
    for path in (root/'postgres').iterdir():
        os.chown(path, 999, 999)
        path.chmod(0o600)
    (root/'postgres/owner-password').write_text(OWNER_PASSWORD)
    os.chown(root/'postgres/owner-password', 999, 999)
    (root/'postgres/owner-password').chmod(0o600)
    (root/'ca.pem').chmod(0o644)
    cpus = ','.join(str(n) for n in sorted(os.sched_getaffinity(0))[:2])
    network, database_name, worker_name = 'qf-budget-internal', 'qf-budget-db', 'qf-budget-worker'
    config = Path(__file__).resolve().parent / 'lightsail'
    # Pull before creating the internal network; neither workload gets internet access.
    run('docker', 'pull', 'postgres:17', stdout=subprocess.DEVNULL)
    run('docker', 'network', 'create', '--internal', network, stdout=subprocess.DEVNULL)
    try:
        run('docker', 'run', '-d', '--name', database_name, '--network', network,
            '--network-alias', 'db.quizforge.internal', '--cpuset-cpus', cpus,
            '--memory', '192m', '--memory-swap', '192m', '--pids-limit', '96',
            '-e', 'POSTGRES_USER=quizforge_owner', '-e', 'POSTGRES_DB=quizforge',
            '-e', 'POSTGRES_PASSWORD_FILE=/run/quizforge/owner-password',
            '-v', f'{root}/postgres:/run/quizforge:ro', '-v', f'{root}/data:/var/lib/postgresql/data',
            '-v', f'{config}/postgresql.conf:/etc/postgresql/postgresql.conf:ro',
            '-v', f'{config}/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro',
            'postgres:17', '-c', 'config_file=/etc/postgresql/postgresql.conf', stdout=subprocess.DEVNULL)
        run('docker', 'run', '--name', worker_name, '--network', network, '--cpuset-cpus', cpus,
            '--memory', '96m', '--memory-swap', '96m', '--pids-limit', '96', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,size=32m',
            '-e', 'QUIZFORGE_ISOLATED_BENCHMARK=synthetic-internal-docker-only',
            '-e', 'BENCHMARK_CANDIDATE_SHA=' + os.environ['GITHUB_SHA'],
            '-v', f'{baseline}:/baseline:ro', '-v', f'{root}/ca.pem:/certs/ca.pem:ro',
            '-v', f'{root}/result:/result', 'quizforge-budget-benchmark',
            'python', 'budget_benchmark.py', '--worker', '--output', '/result/results.json')
        data = json.loads((root/'result/results.json').read_text())
        data['containers'] = {}
        for name in (database_name, worker_name):
            state = json.loads(run('docker','inspect',name,capture_output=True,text=True).stdout)[0]
            data['containers'][name] = {"image_id": state['Image'], "oom_killed": state['State']['OOMKilled']}
            assert not state['State']['OOMKilled']
        data['runner_cpu_model'] = next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unknown')
        data['runner_kernel'] = platform.release()
        data['measured_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(json.dumps(data, indent=2) + '\n')
        print('BENCHMARK_JSON ' + json.dumps(data, separators=(',', ':')))
        print('BENCHMARK_SAVED ' + str(output))
    finally:
        for name in (worker_name, database_name):
            subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--baseline')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.worker:
        worker(args.output)
    else:
        orchestrate(Path(args.baseline).resolve(), args.output)
