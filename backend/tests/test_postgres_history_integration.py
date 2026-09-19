"""Real TLS PostgreSQL and FastAPI auth; only Supabase's HTTP response is mocked."""
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
from uuid import UUID

import httpx
import psycopg
from psycopg.types.json import Jsonb
import pytest

import app_shared
import history_database
from history_postgres import PostgresHistoryRepository
from quiz_history import router

pytestmark = pytest.mark.skipif(os.getenv("TEST_HISTORY_POSTGRES") != "1", reason="Requires isolated TLS PostgreSQL")
ISSUER = "https://history-test.invalid/auth/v1"
USERS = [UUID(int=11), UUID(int=22)]
SUBJECTS = [str(UUID(int=101)), str(UUID(int=202)), str(UUID(int=303))]
TOKENS = {"valid-a": SUBJECTS[0], "valid-b": SUBJECTS[1], "unmapped": SUBJECTS[2]}
ACCESS_TOKENS = {}


def entry(**changes):
    return {"quiz_title": "Water's cycle", "source_filename": "notes.pdf", "document_sha256": "a" * 64,
            "difficulty": "easy", "question_type": "multiple_choice", "question_count": 5, "score": 4,
            "percentage": 80, "quiz_data": {"questions": []}, "selected_answers": {"0": 1}, **changes}


def headers(token="valid-a"):
    return {"Authorization": "Bearer " + ACCESS_TOKENS.get(token, token)}


@pytest.fixture(scope="module")
def owner():
    assert os.environ["PGHOST"] == "127.0.0.1" and os.environ["PGDATABASE"] == "quizforge_rehearsal"
    with psycopg.connect(sslmode="verify-full", autocommit=True) as conn:
        conn.execute((Path(__file__).resolve().parents[2] / "scripts/rds_rehearsal/schema.sql").read_text())
        with psycopg.ClientCursor(conn) as cursor:
            cursor.execute("ALTER ROLE quizforge_app PASSWORD %s", ("local-application-only",))
        yield conn


@pytest.fixture(params=["supabase", "cognito"])
def api(owner, monkeypatch, request, cognito):
    monkeypatch.setenv("AUTH_PROVIDER", request.param)
    owner.execute("TRUNCATE app.quiz_history, app.user_identities, app.users CASCADE")
    for user, subject in zip(USERS, SUBJECTS):
        owner.execute("INSERT INTO app.users(id) VALUES (%s)", (user,))
        owner.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)", (ISSUER, subject, user))
        owner.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                      (cognito.settings.issuer, subject, user))
    if request.param == "cognito":
        for name, subject in TOKENS.items():
            monkeypatch.setitem(ACCESS_TOKENS, name, cognito.sign(subject))
    owner.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                  ("https://other-issuer.invalid", SUBJECTS[2], USERS[0]))
    for name, value in {"HISTORY_BACKEND": "postgres", "HISTORY_DB_HOST": "127.0.0.1",
                        "HISTORY_DB_NAME": "quizforge_rehearsal", "HISTORY_DB_USER": "quizforge_app",
                        "HISTORY_DB_PASSWORD": "local-application-only", "HISTORY_DB_POOL_SIZE": "1",
                        "HISTORY_DB_SSLROOTCERT": os.environ["PGSSLROOTCERT"]}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(app_shared, "SUPABASE_URL", ISSUER.removesuffix("/auth/v1"))
    monkeypatch.setattr(app_shared, "SUPABASE_PUBLISHABLE_KEY", "local-publishable-key")

    @asynccontextmanager
    async def run():
        app = app_shared.create_app()
        app.include_router(router)
        def authenticate(request):
            if request.url.host == "cognito-idp.ca-central-1.amazonaws.com":
                return cognito.handler(request)
            assert str(request.url) == "https://history-test.invalid/auth/v1/user"
            assert request.headers["apikey"] == "local-publishable-key"
            subject = TOKENS.get(request.headers.get("Authorization", "").removeprefix("Bearer "))
            return httpx.Response(200, json={"id": subject, "email": "same-email@example.invalid"}) if subject else httpx.Response(401)
        async with httpx.AsyncClient(transport=httpx.MockTransport(authenticate)) as auth:
            async def auth_client(): return auth
            monkeypatch.setattr(app_shared, "get_http_client", auth_client)
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://api.test") as client:
                    yield client, app.state.history_pool
            assert app.state.history_pool is None
    return run


def test_authenticated_crud_maps_identity_and_enforces_owner(api):
    async def scenario():
        async with api() as (client, pool):
            for method, path in [("GET", "/api/quiz-history"), ("POST", "/api/quiz-history"),
                                 ("GET", "/api/quiz-history/document?source_filename=notes.pdf"),
                                 ("DELETE", f"/api/quiz-history/{UUID(int=1)}")]:
                for authorization in ({}, headers("invalid")):
                    response = await client.request(method, path, headers=authorization,
                                                    json=entry() if method == "POST" else None)
                    assert response.status_code == 401
            assert (await client.get("/api/quiz-history", headers=headers("unmapped"))).status_code == 403
            assert (await client.post("/api/quiz-history", headers=headers(), json=entry(user_id=str(USERS[1])))).status_code == 422
            assert (await client.post("/api/quiz-history", headers=headers(), json=entry())).status_code == 201
            page = (await client.get("/api/quiz-history", headers=headers())).json()
            assert page["totalCount"] == 1 and page["items"][0]["user_id"] == str(USERS[0])
            saved = page["items"][0]["id"]
            assert (await client.get("/api/quiz-history", headers=headers("valid-b"))).json()["items"] == []
            assert (await client.delete("/api/quiz-history/" + saved, headers=headers("valid-b"))).status_code == 204
            assert (await client.get("/api/quiz-history", headers=headers())).json()["totalCount"] == 1
            assert (await client.delete("/api/quiz-history/" + saved, headers=headers())).status_code == 204
            assert (await client.get("/api/quiz-history", headers=headers())).json()["items"] == []
            async with pool.connection() as conn:
                assert (await (await conn.execute("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).fetchone())["ssl"]
    asyncio.run(scenario())


def seed(owner, index, user, **changes):
    row = entry(**changes)
    owner.execute("""INSERT INTO app.quiz_history(id,user_id,quiz_title,source_filename,document_sha256,
        difficulty,question_type,question_count,score,percentage,quiz_data,selected_answers,created_at)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'2026-01-01T00:00:00Z')""",
        (UUID(int=index), user, row["quiz_title"], row["source_filename"], row["document_sha256"], row["difficulty"],
         row["question_type"], row["question_count"], row["score"], row["percentage"], Jsonb(row["quiz_data"]), Jsonb(row["selected_answers"])))


def test_stable_cursor_document_identity_and_parameter_binding(api, owner):
    for i in range(1, 5): seed(owner, i, USERS[0])
    seed(owner, 5, USERS[1])
    seed(owner, 6, USERS[0], document_sha256=None, quiz_data={"document_sha256": "b" * 64})
    seed(owner, 7, USERS[0], document_sha256=None)
    injection = "notes.pdf' OR true --"
    seed(owner, 8, USERS[0], source_filename=injection, document_sha256="c" * 64)
    async def scenario():
        async with api() as (client, _):
            params, seen = {"limit": 2}, []
            while True:
                response = await client.get("/api/quiz-history", headers=headers(), params=params)
                assert response.status_code == 200
                page = response.json()
                assert page["totalCount"] == (7 if not seen else None)
                seen.extend(row["id"] for row in page["items"])
                if not page["hasMore"]: break
                cursor = page["nextCursor"]
                params.update(cursor_created_at=cursor["createdAt"], cursor_id=cursor["id"])
            assert seen == [str(UUID(int=i)) for i in (8, 7, 6, 4, 3, 2, 1)]
            matched = await client.get("/api/quiz-history/document", headers=headers(),
                                       params={"source_filename": "notes.pdf", "document_sha256": "a" * 64})
            assert [r["id"] for r in matched.json()] == [str(UUID(int=i)) for i in (7, 4, 3, 2, 1)]
            literal = await client.get("/api/quiz-history/document", headers=headers(), params={"source_filename": injection})
            assert [r["id"] for r in literal.json()] == [str(UUID(int=8))]
            assert (await client.get("/api/quiz-history", headers=headers(), params={"cursor_id": "bad"})).status_code == 422
    asyncio.run(scenario())


def test_pool_identity_is_cleared_after_database_failure_and_cancellation(api, owner):
    owner.execute("ALTER TABLE app.quiz_history ADD CONSTRAINT private_test_detail CHECK (quiz_title != 'reject-test')")
    async def scenario():
        async with api() as (client, pool):
            async with pool.connection() as conn:
                pid = (await (await conn.execute("SELECT pg_backend_pid() AS pid")).fetchone())["pid"]
            rejected = await client.post("/api/quiz-history", headers=headers(), json=entry(quiz_title="reject-test"))
            assert rejected.status_code == 503 and "private_test_detail" not in rejected.text
            repository = PostgresHistoryRepository(pool, issuer=ISSUER, subject=SUBJECTS[0])
            with pytest.raises(asyncio.CancelledError):
                async with repository.transaction() as (conn, _):
                    await conn.execute("SELECT set_config('quizforge.user_id', %s, true)", (str(USERS[0]),))
                    raise asyncio.CancelledError
            assert (await client.post("/api/quiz-history", headers=headers("valid-b"), json=entry())).status_code == 201
            pages = await asyncio.gather(*[
                client.get("/api/quiz-history", headers=headers("valid-a" if i % 2 == 0 else "valid-b")) for i in range(8)])
            assert all(p.status_code == 200 for p in pages)
            assert all(len(p.json()["items"]) == (i % 2) for i, p in enumerate(pages))
            async with pool.connection() as conn:
                assert (await (await conn.execute("SELECT pg_backend_pid() AS pid")).fetchone())["pid"] == pid
                assert await (await conn.execute("SELECT * FROM app.quiz_history")).fetchall() == []
                assert await (await conn.execute("SELECT * FROM app.user_identities")).fetchall() == []
                settings = await (await conn.execute("""SELECT current_setting('quizforge.user_id',true) AS user_id,
                    current_setting('quizforge.auth_issuer',true) AS issuer,
                    current_setting('quizforge.auth_subject',true) AS subject""")).fetchone()
                assert not any(settings.values())
    try:
        asyncio.run(scenario())
    finally:
        owner.execute("ALTER TABLE app.quiz_history DROP CONSTRAINT private_test_detail")


def test_owner_role_is_rejected_and_plaintext_is_rejected(owner):
    async def scenario():
        async with await psycopg.AsyncConnection.connect(sslmode="verify-full", autocommit=True,
                                                        row_factory=psycopg.rows.dict_row) as conn:
            with pytest.raises(RuntimeError, match="restricted application"):
                await history_database.check_application_role(conn)
    asyncio.run(scenario())
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(sslmode="disable", connect_timeout=3)


@pytest.mark.parametrize("table", ["app.users", "app.user_identities"])
def test_application_role_cannot_be_granted_identity_provisioning(owner, table):
    # Identifiers are fixed test constants, never API inputs.
    owner.execute(f"GRANT INSERT ON {table} TO quizforge_app")
    async def scenario():
        async with await psycopg.AsyncConnection.connect(
                user="quizforge_app", password="local-application-only", sslmode="verify-full",
                autocommit=True, row_factory=psycopg.rows.dict_row) as conn:
            with pytest.raises(RuntimeError, match="excessive privileges"):
                await history_database.check_application_role(conn)
    try:
        asyncio.run(scenario())
    finally:
        owner.execute(f"REVOKE INSERT ON {table} FROM quizforge_app")
