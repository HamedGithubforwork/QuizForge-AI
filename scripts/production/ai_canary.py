"""One synthetic quiz through the pinned application and real TLS budget guard.

CI-only disposable database; never accepts an existing database or user notes.
The SDK, application adapter, provider adapter and SQL policy each limit retries.
Only synthetic material, quiz output and accounting metadata enter the report.
"""
import argparse
import asyncio
from datetime import date, datetime, timezone
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

APPLICATION_COMMIT = "807a4084237f6db544620cdb8322108ebf52251c"
PAGES = [
    {"page_number": 1, "text": "TCP provides reliable, ordered delivery of a byte stream. "
     "It establishes a connection before transferring application data. TCP acknowledges "
     "received data and retransmits missing data. UDP sends independent datagrams without "
     "establishing a connection. UDP does not guarantee delivery or ordering. Applications "
     "that use UDP can implement their own reliability when required."},
    {"page_number": 2, "text": "DNS translates domain names into IP addresses. A DNS cache "
     "stores earlier lookup results temporarily to reduce repeated lookups. A router forwards "
     "packets between networks. An IP address identifies a network interface for packet delivery. "
     "A port number identifies an application endpoint on a host. HTTPS protects HTTP traffic "
     "using TLS encryption and authenticates the server using a certificate."},
]


def synthetic_response():
    facts = [
        ("Which protocol provides reliable, ordered delivery?", ["TCP", "UDP", "DNS", "IP"], 1,
         "TCP provides reliable, ordered delivery of a byte stream."),
        ("Which protocol sends independent datagrams?", ["UDP", "TCP", "HTTPS", "TLS"], 1,
         "UDP sends independent datagrams without establishing a connection."),
        ("What translates domain names into IP addresses?", ["DNS", "TCP", "TLS", "A port number"], 2,
         "DNS translates domain names into IP addresses."),
        ("What forwards packets between networks?", ["A router", "A DNS cache", "A certificate", "A port number"], 2,
         "A router forwards packets between networks."),
        ("What protects HTTP traffic using encryption?", ["TLS", "DNS", "UDP", "IP addressing"], 2,
         "HTTPS protects HTTP traffic using TLS encryption."),
    ]
    quiz = {"title": "Networking basics", "questions": [
        {"question_type": "multiple_choice", "question": q, "choices": choices,
         "correct_index": 0, "explanation": explanation, "source_pages": [page]}
        for q, choices, page, explanation in facts]}
    return json.dumps({"id": "resp_synthetic", "object": "response", "created_at": 0,
        "model": "gpt-5.6-luna", "service_tier": "default", "status": "completed",
        "output": [{"id": "msg_synthetic", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": json.dumps(quiz), "annotations": []}]}],
        "usage": {"input_tokens": 2000, "output_tokens": 800, "total_tokens": 2800}}).encode()


async def generate_once(port, record):
    from openai import AsyncOpenAI, DefaultAsyncHttpxClient
    import quiz_service
    client = AsyncOpenAI(api_key="production-budget-guard", base_url=f"http://127.0.0.1:{port}/v1",
                         max_retries=0, timeout=120,
                         http_client=DefaultAsyncHttpxClient(trust_env=False))

    async def parse_once(**kwargs):
        if record["sdk_requests"]:
            raise RuntimeError("Application validation retry suppressed for this single-attempt test")
        record["sdk_requests"] += 1
        return await client.responses.parse(**kwargs, max_output_tokens=8192, store=False)

    async def get_client(_):
        return SimpleNamespace(responses=SimpleNamespace(parse=parse_once))

    original = quiz_service.get_openai_client
    quiz_service.get_openai_client = get_client
    try:
        quiz = await quiz_service.generate_quiz_from_pages(
            pages=PAGES, question_count=5, difficulty="easy", question_type="multiple_choice")
        record["quiz"] = quiz.model_dump()
        record["application_validation_passed"] = True
    finally:
        quiz_service.get_openai_client = original
        await client.close()


def exercise(owner, database, simulate, output):
    import generation_guard as guard
    from generation_costs import PRICING_KEY, PRICING_VALID_UNTIL, maximum_cost, accounted_cost
    if date.today() >= date.fromisoformat(PRICING_VALID_UNTIL):
        raise ValueError("Review the expired price card before running a live test")
    owner.execute(Path(__file__).with_name("generation_budget.sql").read_text())
    import psycopg
    with psycopg.ClientCursor(owner) as cursor:
        cursor.execute("ALTER ROLE quizforge_generation PASSWORD %s", (database["password"],))
    owner.execute("UPDATE billing.generation_policy SET enabled=true,daily_requests=1,monthly_requests=1,"
                  "monthly_nano_usd=5000000000,pricing_key=%s,pricing_valid_until=%s",
                  (PRICING_KEY, PRICING_VALID_UNTIL))
    record = {"mode": "simulated" if simulate else "live", "application_commit": APPLICATION_COMMIT,
        "configuration_commit": os.environ["GITHUB_SHA"], "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": guard.MODEL, "sdk_requests": 0, "provider_requests": 0, "real_model_requests": 0,
        "application_validation_passed": False, "automatic_retries": 0, "monthly_allowance_usd": 5,
        "maximum_attempt_usd": maximum_cost(8192) / 1e9, "synthetic_pages": PAGES,
        "database_tls": owner.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()[0],
        "scope": "One app generation on a GitHub runner; excludes OCR, browser, live AWS capacity and provider invoice reconciliation"}
    raw_responses = []
    original_connection = guard.HTTPSConnection

    class OnceConnection(original_connection):
        def request(self, method, url, body=None, headers=None, **kwargs):
            if record["provider_requests"]:
                raise RuntimeError("Second upstream attempt blocked")
            assert self.host == "api.openai.com" and method == "POST" and url == "/v1/responses"
            payload = json.loads(body)
            assert payload["service_tier"] == "default" and payload["store"] is False
            assert payload["max_output_tokens"] == 8192
            record["request_bytes"] = len(body)
            record["request_sha256"] = hashlib.sha256(body).hexdigest()
            record["provider_requests"] += 1
            if not simulate:
                # Count attempted sends conservatively even if the connection fails.
                record["real_model_requests"] += 1
                return super().request(method, url, body=body, headers=headers, **kwargs)

        def getresponse(self):
            if simulate:
                return SimpleNamespace(status=200, read=lambda limit: synthetic_response()[:limit])
            return super().getresponse()

    class RecordingHandler(guard.Handler):
        def reply(self, status, body):
            raw_responses.append((status, body))
            super().reply(status, body)

    guard.HTTPSConnection = OnceConnection
    server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
    server.database = database
    server.slots = threading.BoundedSemaphore(1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = time.perf_counter()
    try:
        asyncio.run(generate_once(server.server_port, record))
    except Exception as error:
        # Do not serialize exception messages: SDK errors can contain request details.
        record["error_type"] = type(error).__name__
    finally:
        record["generation_seconds"] = round(time.perf_counter() - started, 6)
        owner.execute("UPDATE billing.generation_policy SET enabled=false")
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        guard.HTTPSConnection = original_connection
        record["policy_disabled_at_finish"] = not owner.execute("SELECT enabled FROM billing.generation_policy").fetchone()[0]
        rows = owner.execute("SELECT maximum_nano_usd,settled_nano_usd FROM billing.generation_reservations").fetchall()
        record["reservations"] = [{"maximum_usd": a/1e9, "settled_usd": None if b is None else b/1e9} for a,b in rows]
        record["accounted_usd"] = sum((b if b is not None else a) for a,b in rows)/1e9
        record["remaining_isolated_allowance_usd"] = 5 - record["accounted_usd"]
        record["sql_request_count"] = owner.execute("SELECT coalesce(sum(requests),0) FROM billing.generation_usage WHERE period='month'").fetchone()[0]
        if raw_responses:
            status, raw = raw_responses[0]
            record["http_status"] = status
            record["response_bytes"] = len(raw)
            try:
                response = json.loads(raw)
                record["provider_status"] = response.get("status")
                record["returned_model"] = response.get("model")
                record["service_tier"] = response.get("service_tier")
                if status == 200:
                    record["usage"] = response.get("usage")
                    expected = accounted_cost(raw, 8192)
                    record["settlement_verified"] = len(rows) == 1 and expected is not None and rows[0][1] == expected
                else:
                    error = response.get("error", {})
                    record["provider_error_code"] = error.get("code") if isinstance(error, dict) else None
            except (TypeError, ValueError):
                record["invalid_provider_json"] = True
        record["passed"] = all((record["application_validation_passed"], record.get("settlement_verified"),
            record["database_tls"], record["policy_disabled_at_finish"], record["sdk_requests"] == 1,
            record["provider_requests"] == 1, len(rows) == 1, record["sql_request_count"] == 1))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(json.dumps(record, indent=2) + "\n")
        print("AI_CANARY_JSON " + json.dumps(record, separators=(",", ":")), flush=True)
    return record["passed"]


def main(args):
    if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("RUNNER_TEMP"):
        raise ValueError("Requires a disposable GitHub Actions runner")
    if os.environ.get("GITHUB_RUN_ATTEMPT") != "1" and not args.simulate:
        raise ValueError("Live workflow reruns are blocked")
    candidate = Path(args.application).resolve()
    actual = subprocess.check_output(["git", "-C", str(candidate), "rev-parse", "HEAD"], text=True).strip()
    if actual != APPLICATION_COMMIT:
        raise ValueError("Unexpected application revision")
    sys.path.insert(0, str(candidate / "backend"))
    if args.simulate:
        os.environ["OPENAI_API_KEY"] = "synthetic-not-sent"
    elif not os.environ.get("OPENAI_API_KEY", "").strip():
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps({"mode": "live", "passed": False,
            "blocked_reason": "missing_OPENAI_API_KEY_GitHub_Actions_secret", "real_model_requests": 0}) + "\n")
        print("::error::Live canary blocked: configure the OPENAI_API_KEY GitHub Actions repository secret.")
        return False
    import psycopg
    root = Path(os.environ["RUNNER_TEMP"]) / ("qf-ai-canary-simulated" if args.simulate else "qf-ai-canary-live")
    root.mkdir(mode=0o755)
    certs = root / "postgres"
    certs.mkdir(mode=0o700)
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    def run(*cmd, **kwargs):
        return subprocess.run(cmd, check=True, **kwargs)
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Canary-CA",
        "-keyout", str(root / "ca.key"), "-out", str(root / "ca.pem"), **quiet)
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
        "-keyout", str(certs / "server.key"), "-out", str(root / "db.csr"), **quiet)
    (root / "extensions").write_text("subjectAltName=IP:127.0.0.1\n")
    run("openssl", "x509", "-req", "-in", str(root / "db.csr"), "-CA", str(root / "ca.pem"),
        "-CAkey", str(root / "ca.key"), "-CAcreateserial", "-days", "1", "-extfile", str(root / "extensions"),
        "-out", str(certs / "server.crt"), **quiet)
    password = secrets.token_urlsafe(32)
    (certs / "owner-password").write_text(password)
    os.chown(certs, 999, 999)
    for path in certs.iterdir():
        os.chown(path, 999, 999)
        path.chmod(0o600)
    name = root.name
    config = Path(__file__).resolve().parent / "lightsail"
    owner = None
    try:
        run("docker", "run", "-d", "--name", name, "--memory", "192m", "--memory-swap", "192m",
            "--pids-limit", "96", "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=quizforge_owner",
            "-e", "POSTGRES_DB=quizforge", "-e", "POSTGRES_PASSWORD_FILE=/run/quizforge/owner-password",
            "-v", f"{certs}:/run/quizforge:ro", "-v", f"{config}/postgresql.conf:/etc/postgresql/postgresql.conf:ro",
            "-v", f"{config}/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro", "postgres:17",
            "-c", "config_file=/etc/postgresql/postgresql.conf", stdout=subprocess.DEVNULL)
        port = int(run("docker", "port", name, "5432/tcp", capture_output=True, text=True).stdout.strip().rsplit(":", 1)[1])
        options = dict(host="127.0.0.1", port=port, dbname="quizforge", user="quizforge_owner", password=password,
                       sslmode="verify-full", sslrootcert=str(root / "ca.pem"), autocommit=True, connect_timeout=5)
        for _ in range(40):
            try:
                owner = psycopg.connect(**options)
                break
            except psycopg.OperationalError:
                time.sleep(.5)
        if owner is None:
            raise RuntimeError("Disposable TLS database did not become ready")
        database = options | {"user": "quizforge_generation", "password": secrets.token_urlsafe(32),
                              "autocommit": False, "options": "-c statement_timeout=5000 -c lock_timeout=3000"}
        return exercise(owner, database, args.simulate, args.output)
    finally:
        if owner:
            owner.close()
        subprocess.run(["docker", "rm", "-fv", name], **quiet)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--application", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--simulate", action="store_true")
    args = parser.parse_args()
    raise SystemExit(0 if main(args) else 1)
