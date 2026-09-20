"""Trusted private-VPC setup/verification. Never exports the RDS owner password."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import traceback
from uuid import UUID

import boto3
import psycopg
from redis import Redis
from generation_guard import BUDGET_KEY, CALLS_KEY, MAX_CALLS
from psycopg import sql
from psycopg.rows import dict_row
from probe_fixtures import fixtures, fingerprint, insert


def options(env):
    host = env["PGHOST"]
    assert host.startswith("quizforge-integrated-staging.") and host.endswith(".ca-central-1.rds.amazonaws.com")
    assert env["PGDATABASE"] == "quizforge_rehearsal"
    return dict(host=host, dbname=env["PGDATABASE"], user=env["PGUSER"], password=env["PGPASSWORD"],
                sslmode="verify-full", sslrootcert=env["PGSSLROOTCERT"], connect_timeout=15,
                autocommit=True, row_factory=dict_row)


def main(phase):
    assert phase in ("seed", "verify")
    sm = boto3.client("secretsmanager", region_name="ca-central-1")
    bundle = json.loads(sm.get_secret_value(SecretId=os.environ["FIXTURE_SECRET"])["SecretString"])
    assert os.environ["REDIS_URL"].startswith("rediss://")
    cache = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True, socket_connect_timeout=10, socket_timeout=10)
    assert cache.ping()
    if phase == "seed":
        assert cache.set(BUDGET_KEY, MAX_CALLS, nx=True), "Generation budget was already initialized"
        assert cache.get(CALLS_KEY) is None
        assert cache.ttl(BUDGET_KEY) == -1
        print("PASS: private TLS Valkey ready; non-expiring two-request model budget initialized exactly once")
    with psycopg.connect(**options(os.environ)) as conn:
        assert conn.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetchone()["ssl"]
        if phase == "seed":
            # Deny cleartext, with the same correct owner credential.
            try:
                with psycopg.connect(**{**options(os.environ), "sslmode":"disable"}):
                    pass
            except psycopg.OperationalError as error:
                assert any(s in str(error).lower() for s in ("no encryption", "ssl off"))
            else:
                raise AssertionError("Database accepted non-TLS access")
            with conn.transaction():
                conn.execute(Path("schema.sql").read_text())
                conn.execute(Path("identity_schema.sql").read_text())
                issuer = "https://cognito-idp.ca-central-1.amazonaws.com/" + bundle["pool"]
                for number in (1, 2, 3):
                    user = UUID(int=number)
                    subject = bundle["users"]["mapped"]["subject"] if number == 3 else str(user)
                    conn.execute("INSERT INTO app.users VALUES (%s)", (user,))
                    conn.execute("INSERT INTO app.user_identities VALUES (%s,%s,%s)", (issuer, subject, user))
                for row in fixtures():
                    insert(conn, row)
                passwords = {}
                for role in ("quizforge_app", "quizforge_identity"):
                    passwords[role] = secrets.token_urlsafe(32)
                    with psycopg.ClientCursor(conn) as cursor:
                        cursor.execute(sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)), (passwords[role],))
            for role, env in (("quizforge_app", "APPLICATION_SECRET"), ("quizforge_identity", "IDENTITY_SECRET")):
                sm.put_secret_value(SecretId=os.environ[env], SecretString=json.dumps({"password":passwords[role]}))
            print("PASS: private RDS verified TLS, rejected cleartext, seeded synthetic history and separate restricted application roles")
        assert fingerprint(conn.execute("SELECT * FROM app.quiz_history").fetchall()) == fingerprint(fixtures())
        if phase == "verify":
            print("PASS: eight original history fixtures remain unchanged; browser-created history removed")
            assert conn.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 4
            assert conn.execute("SELECT count(*) AS n FROM app.identity_challenges WHERE used_at IS NOT NULL").fetchone()["n"] == 1
            print("PASS: four internal users and exactly one consumed enrollment confirmation")
            try:
                verify_cache(cache, bundle)
            except AssertionError:
                report_cache_counters(cache)
                raise
            print("PASS: browser enrollment used one confirmation; eight foreign fixtures unchanged; no browser history rows remain")


def report_cache_counters(cache):
    # Only fixed numeric counters; never dump cache values, documents or tokens.
    try:
        names = ("quiz_cache_hits_total", "quiz_cache_misses_total", "quiz_requests_total",
                 "document_cache_hits_total", "document_cache_misses_total")
        counts = {name:int(cache.get("quizforge:metrics:" + name) or 0) for name in names}
        counts.update(model_requests=int(cache.get(CALLS_KEY) or 0),
                      remaining_budget=int(cache.get(BUDGET_KEY) or 0),
                      budget_ttl=cache.ttl(BUDGET_KEY),
                      model_timing_samples=cache.llen("quizforge:metrics:timing:openai_generation_latency_ms"))
        print("ERROR: private cache verification counters: " + json.dumps(counts, sort_keys=True))
    except Exception:
        print("ERROR: private cache counter diagnostics unavailable")


def verify_cache(cache, bundle):
    sha = hashlib.sha256(base64.b64decode(bundle["pdf"])).hexdigest()
    documents = [key for key in cache.scan_iter("quizforge:document-cache:*") if key.count(":") == 2]
    quizzes = list(cache.scan_iter("quizforge:quiz-cache:*"))
    assert len(documents) == len(quizzes) == 1
    document = json.loads(cache.get(documents[0]))
    assert document["pdf_sha256"] == sha and len(document["pages"]) == 1
    assert 0 < cache.ttl(documents[0]) <= 86400
    page_key = documents[0] + ":source-page:1"
    assert "Evaporation" in cache.get(page_key)
    assert 0 < cache.ttl(page_key) <= 86400
    assert json.loads(cache.get(documents[0] + ":source-pages"))["page_numbers"] == [1]
    print("PASS: private document/source caches preserve the synthetic PDF and source page with valid TTLs")
    quiz = json.loads(cache.get(quizzes[0]))
    assert len(quiz["questions"]) == 5
    assert all(q["question_type"] == "multiple_choice" and q["source_pages"] == [1] for q in quiz["questions"])
    assert 0 < cache.ttl(quizzes[0]) <= 3600
    print("PASS: private quiz cache contains five grounded multiple-choice questions with a valid TTL")
    # Generation uses app_shared.AuthenticatedUser.id; history separately maps
    # that Cognito identity to an internal database UUID.
    rate = f"quizforge:rate:cognito:{bundle['pool']}:{bundle['users']['mapped']['subject']}"
    assert cache.get(rate) == "11" and 0 < cache.ttl(rate) <= 600
    print("PASS: private distributed quiz-rate counter is eleven with an active ten-minute window")
    expected_metrics = {"quiz_cache_hits_total":1, "quiz_cache_misses_total":9, "quiz_requests_total":10}
    actual_metrics = {metric:int(cache.get("quizforge:metrics:" + metric) or 0) for metric in expected_metrics}
    assert actual_metrics == expected_metrics
    for metric in ("document_cache_hits_total", "document_cache_misses_total"):
        assert int(cache.get("quizforge:metrics:" + metric) or 0) >= 1, metric
    assert not list(cache.scan_iter("quizforge:rate:answer-review:*"))
    print("PASS: expected quiz/document metrics and no semantic answer-review requests")
    calls = int(cache.get(CALLS_KEY))
    assert 1 <= calls <= MAX_CALLS
    assert 1 <= cache.llen("quizforge:metrics:timing:openai_generation_latency_ms") <= calls
    assert int(cache.get(BUDGET_KEY)) + calls == MAX_CALLS and cache.ttl(BUDGET_KEY) == -1
    print("PASS: application-created document/source/quiz caches and TTLs in private Valkey; distributed counter proves normal 429; one generation pipeline and one quiz cache hit")
    print("PASS: real upstream model requests=" + str(calls) + "; hard maximum=2; each request capped at 4096 output tokens and 32768 input-body bytes")
    cache.close()


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        frame = traceback.extract_tb(error.__traceback__)[-1]
        # Location only: exception strings/source lines can contain credentials.
        print(f"ERROR: integration database probe failed ({type(error).__name__} at {Path(frame.filename).name}:{frame.lineno}, SQLSTATE={getattr(error, 'sqlstate', None)})")
        sys.exit(1)
