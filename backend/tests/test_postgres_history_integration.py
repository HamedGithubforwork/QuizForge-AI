"""Real TLS PostgreSQL and FastAPI auth; only Supabase's HTTP response is mocked."""
import asyncio
import hashlib
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
from decks import router as decks_router
from study_notifications import router as study_notifications_router

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
        conn.execute((Path(__file__).resolve().parents[2] / "scripts/rds_rehearsal/identity_schema.sql").read_text())
        with psycopg.ClientCursor(conn) as cursor:
            cursor.execute("ALTER ROLE quizforge_app PASSWORD %s", ("local-application-only",))
            cursor.execute("ALTER ROLE quizforge_identity PASSWORD %s", ("local-identity-only",))
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
        app.include_router(decks_router)
        app.include_router(study_notifications_router)
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


@pytest.fixture
def enrollment(owner, cognito, monkeypatch):
    from identity_app import create_identity_app
    from test_identity_proofs import legacy_token
    owner.execute("TRUNCATE app.quiz_history, app.user_identities, app.users, app.identity_challenges CASCADE")
    owner.execute("INSERT INTO app.users(id) VALUES (%s)", (USERS[0],))
    owner.execute("INSERT INTO app.user_identities VALUES ('https://legacy.test/auth/v1',%s,%s)", (str(UUID(int=1)), USERS[0]))
    seed(owner, 1, USERS[0])
    for name, value in {"IDENTITY_STAGING_ENABLED": "true", "IDENTITY_ALLOWED_ORIGIN": "https://staging.test",
                        "IDENTITY_SUPABASE_URL": "https://legacy.test", "IDENTITY_SUPABASE_PUBLISHABLE_KEY": "publishable",
                        "IDENTITY_DB_HOST": "127.0.0.1", "IDENTITY_DB_NAME": "quizforge_rehearsal",
                        "IDENTITY_DB_USER": "quizforge_identity", "IDENTITY_DB_PASSWORD": "local-identity-only",
                        "IDENTITY_DB_SSLROOTCERT": os.environ["PGSSLROOTCERT"]}.items(): monkeypatch.setenv(name, value)
    def authenticate(request):
        if request.url.host == "cognito-idp.ca-central-1.amazonaws.com": return cognito.handler(request)
        assert str(request.url) == "https://legacy.test/auth/v1/user"
        return httpx.Response(200, json={"id": str(UUID(int=1)), "email_confirmed_at": "2026-01-01", "factors": []})
    @asynccontextmanager
    async def run():
        app = create_identity_app()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.MockTransport(authenticate)) as upstream:
                app.state.http = upstream
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://identity.test",
                        headers={"Origin": "https://staging.test", "Authorization": "Bearer " + cognito.sign()}) as client:
                    yield client, app, {"X-Legacy-Authorization": "Bearer " + legacy_token()}
    return run


def test_identity_link_requires_dual_proof_confirmation_and_cannot_reassign(enrollment, owner, cognito):
    async def scenario():
        async with enrollment() as (client, app, legacy):
            assert (await client.get('/identity/session')).json()['enrolled'] is False
            assert (await client.post('/identity/challenge', json={'mode':'link'})).status_code == 401
            assert (await client.post('/identity/challenge', json={'mode':'link','user_id':str(USERS[1])}, headers=legacy)).status_code == 422
            result = await client.post('/identity/challenge', json={'mode':'link'}, headers=legacy)
            assert result.status_code == 200, result.text
            nonce = result.json()['nonce']
            assert len(nonce) == 43 and nonce not in str(owner.execute('SELECT * FROM app.identity_challenges').fetchall())
            # Neither another Cognito account nor a missing legacy proof can use it.
            other = {'Authorization': 'Bearer ' + cognito.sign(str(UUID(int=909))), **legacy}
            payload = {'mode':'link','nonce':nonce}
            assert (await client.post('/identity/confirm', json=payload, headers=other)).status_code == 409
            assert (await client.post('/identity/confirm', json=payload)).status_code == 401
            assert (await client.post('/identity/confirm', json=payload, headers=legacy)).status_code == 204
            assert (await client.post('/identity/confirm', json=payload, headers=legacy)).status_code == 409
            assert (await client.post('/identity/challenge', json={'mode':'enroll'})).status_code == 409
            assert (await client.get('/identity/session')).json()['enrolled'] is True
            async with app.state.pool.connection() as conn:
                assert await (await conn.execute('SELECT * FROM app.user_identities')).fetchall() == []
                with pytest.raises(psycopg.errors.InsufficientPrivilege): await conn.execute('SELECT * FROM app.quiz_history')
                with pytest.raises(psycopg.errors.InsufficientPrivilege): await conn.execute('DELETE FROM app.user_identities')
                with pytest.raises(psycopg.errors.InsufficientPrivilege): await conn.execute('UPDATE app.user_identities SET user_id=%s',(USERS[1],))
    asyncio.run(scenario())
    assert owner.execute('SELECT user_id FROM app.user_identities WHERE issuer=%s',(cognito.settings.issuer,)).fetchone()[0] == USERS[0]
    assert owner.execute('SELECT count(*) FROM app.quiz_history').fetchone()[0] == 1


def test_identity_new_account_has_no_email_based_history_and_serializes_confirmation(enrollment, owner):
    async def scenario():
        async with enrollment() as (client, _, _):
            nonce = (await client.post('/identity/challenge', json={'mode':'enroll'})).json()['nonce']
            results = await asyncio.gather(*[client.post('/identity/confirm', json={'mode':'enroll','nonce':nonce}) for _ in range(4)])
            assert sorted(r.status_code for r in results) == [204,409,409,409]
    asyncio.run(scenario())
    rows = owner.execute('SELECT user_id FROM app.user_identities ORDER BY issuer').fetchall()
    assert len(rows) == 2 and rows[0][0] != rows[1][0]
    assert owner.execute('SELECT count(*) FROM app.users').fetchone()[0] == 2
    assert owner.execute('SELECT count(*) FROM app.quiz_history').fetchone()[0] == 1


def test_identity_origin_expiry_recent_auth_and_distributed_limit(enrollment, owner, cognito):
    async def scenario():
        async with enrollment() as (client, _, _):
            assert (await client.get('/identity/session', headers={'Origin':'https://evil.test'})).status_code == 403
            assert (await client.post('/identity/challenge', content='x'*2049)).status_code == 413
            stale = cognito.sign(changes={'auth_time': int(__import__('time').time()) - 600})
            assert (await client.post('/identity/challenge', json={'mode':'enroll'}, headers={'Authorization':'Bearer '+stale})).status_code == 401
            for _ in range(5):
                response = await client.post('/identity/challenge', json={'mode':'enroll'})
                assert response.status_code == 200, response.text
            assert (await client.post('/identity/challenge', json={'mode':'enroll'})).status_code == 429
            owner.execute("UPDATE app.identity_challenges SET created_at=now()-interval '6 minutes'")
            assert (await client.post('/identity/confirm', json={'mode':'enroll','nonce':response.json()['nonce']})).status_code == 409
            assert (await client.post('/identity/challenge', json={'mode':'enroll'})).status_code == 200
    asyncio.run(scenario())


def test_identity_role_refuses_owner_or_history_privileges(enrollment, owner):
    from identity_database import check_identity_role
    async def scenario():
        async with await psycopg.AsyncConnection.connect(sslmode='verify-full',autocommit=True,row_factory=psycopg.rows.dict_row) as conn:
            with pytest.raises(RuntimeError): await check_identity_role(conn)
        owner.execute('GRANT SELECT ON app.quiz_history TO quizforge_identity')
        try:
            async with await psycopg.AsyncConnection.connect(user='quizforge_identity',password='local-identity-only',sslmode='verify-full',
                    autocommit=True,row_factory=psycopg.rows.dict_row) as conn:
                with pytest.raises(RuntimeError, match='excessive'): await check_identity_role(conn)
        finally: owner.execute('REVOKE SELECT ON app.quiz_history FROM quizforge_identity')
    asyncio.run(scenario())

def test_deck_crud_uses_same_verified_owner_mapping(api, owner):
    async def scenario():
        async with api() as (client, _):
            created = await client.post(
                "/api/decks",
                headers=headers(),
                json={
                    "name": " Biology Midterm ",
                    "description": "Cell biology",
                    "cards": [{
                        "question_type": "multiple_choice",
                        "question": "What organelle produces ATP?",
                        "answer": {
                            "correct_index": 1,
                            "correct_answer": "Mitochondria",
                            "accepted_answers": ["Mitochondria"],
                        },
                        "choices": ["Nucleus", "Mitochondria", "Ribosome"],
                        "explanation": "Mitochondria perform cellular respiration.",
                        "source_filename": "notes.pdf",
                        "document_sha256": "a" * 64,
                        "source_pages": [14, 12],
                        "tags": [
                            "  Finals ",
                            "CELL   Biology",
                            "finals",
                        ],
                    }],
                },
            )
            assert created.status_code == 201, created.text
            body = created.json()
            assert body["name"] == "Biology Midterm"
            assert body["card_count"] == 1
            assert body["due_count"] == 1
            assert body["next_due_at"] is None
            assert body["cards"][0]["source_pages"] == [12, 14]
            assert body["cards"][0]["tags"] == ["finals", "cell biology"]
            deck_id = body["id"]
            first_card_id = body["cards"][0]["id"]
            assert body["cards"][0]["fsrs_state"] == 1
            assert body["cards"][0]["review_count"] == 0

            listed = await client.get("/api/decks", headers=headers())
            assert listed.status_code == 200
            assert [item["id"] for item in listed.json()] == [deck_id]

            other_list = await client.get("/api/decks", headers=headers("valid-b"))
            assert other_list.status_code == 200
            assert other_list.json() == []
            assert (
                await client.get(
                    f"/api/decks/{deck_id}",
                    headers=headers("valid-b"),
                )
            ).status_code == 404

            added = await client.post(
                f"/api/decks/{deck_id}/cards",
                headers=headers(),
                json={
                    "cards": [{
                        "question_type": "short_answer",
                        "question": "What is ATP?",
                        "answer": {"correct_answer": "Adenosine triphosphate"},
                        "choices": None,
                        "explanation": None,
                        "source_filename": "notes.pdf",
                        "document_sha256": "a" * 64,
                        "source_pages": [15],
                        "tags": ["biochemistry"],
                    }]
                },
            )
            assert added.status_code == 201, added.text
            assert added.json()["card_count"] == 2
            assert added.json()["due_count"] == 2
            second_card_id = [
                card["id"]
                for card in added.json()["cards"]
                if card["id"] != first_card_id
            ][0]

            queue = await client.get(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
            )
            assert queue.status_code == 200, queue.text
            assert queue.json()["due_count"] == 2
            assert {
                card["id"]
                for card in queue.json()["cards"]
            } == {first_card_id, second_card_id}
            queued_tags = {
                card["id"]: card["tags"]
                for card in queue.json()["cards"]
            }
            assert queued_tags[first_card_id] == ["finals", "cell biology"]
            assert queued_tags[second_card_id] == ["biochemistry"]

            filtered_queue = await client.get(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                params={
                    "tag":
                        "  BIOCHEMISTRY ",
                },
            )
            assert filtered_queue.status_code == 200, filtered_queue.text
            assert filtered_queue.json()["tag"] == "biochemistry"
            assert filtered_queue.json()["due_count"] == 1
            assert [
                card["id"]
                for card in filtered_queue.json()["cards"]
            ] == [second_card_id]

            cell_queue = await client.get(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                params={
                    "tag":
                        "cell biology",
                },
            )
            assert cell_queue.status_code == 200, cell_queue.text
            assert cell_queue.json()["due_count"] == 1
            assert [
                card["id"]
                for card in cell_queue.json()["cards"]
            ] == [first_card_id]

            reviewed = await client.post(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                json={
                    "card_id": first_card_id,
                    "rating": 3,
                    "review_duration_ms": 1700,
                },
            )
            assert reviewed.status_code == 200, reviewed.text
            reviewed_body = reviewed.json()
            assert reviewed_body["card"]["review_count"] == 1
            assert reviewed_body["card"]["last_reviewed_at"] is not None
            assert reviewed_body["card"]["stability"] > 0
            assert reviewed_body["card"]["difficulty"] > 0
            assert reviewed_body["remaining_due_count"] == 1

            repeated = await client.post(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                json={
                    "card_id": first_card_id,
                    "rating": 3,
                },
            )
            assert repeated.status_code == 409

            hidden_review = await client.post(
                f"/api/decks/{deck_id}/review",
                headers=headers("valid-b"),
                json={
                    "card_id": second_card_id,
                    "rating": 3,
                },
            )
            assert hidden_review.status_code == 404

            log = owner.execute(
                """SELECT user_id,rating,review_duration_ms
                   FROM app.card_review_logs"""
            ).fetchall()
            assert log == [(USERS[0], 3, 1700)]

            edited = await client.patch(
                f"/api/decks/{deck_id}/cards/{first_card_id}",
                headers=headers(),
                json={
                    "question": "Where is ATP produced?",
                    "explanation": None,
                    "tags": [
                        "High   Yield",
                        "high yield",
                        "mitochondria",
                    ],
                },
            )
            assert edited.status_code == 200, edited.text
            edited_card = next(
                card
                for card in edited.json()["cards"]
                if card["id"] == first_card_id
            )
            assert edited_card["question"] == "Where is ATP produced?"
            assert edited_card["explanation"] is None
            assert edited_card["tags"] == ["high yield", "mitochondria"]
            assert edited_card["review_count"] == 1
            assert edited_card["stability"] == reviewed_body["card"]["stability"]
            assert edited_card["difficulty"] == reviewed_body["card"]["difficulty"]
            assert edited_card["last_reviewed_at"] == reviewed_body["card"]["last_reviewed_at"]

            assert (
                await client.patch(
                    f"/api/decks/{deck_id}/cards/{first_card_id}",
                    headers=headers("valid-b"),
                    json={"question": "Forged edit"},
                )
            ).status_code == 404

            renamed = await client.patch(
                f"/api/decks/{deck_id}",
                headers=headers(),
                json={"name": "Exam Review"},
            )
            assert renamed.status_code == 200
            assert renamed.json()["name"] == "Exam Review"

            duplicated = await client.post(
                f"/api/decks/{deck_id}/duplicate",
                headers=headers(),
                json={},
            )
            assert duplicated.status_code == 201, duplicated.text
            duplicate_body = duplicated.json()
            duplicate_id = duplicate_body["id"]
            assert duplicate_id != deck_id
            assert duplicate_body["name"] == "Copy of Exam Review"
            assert duplicate_body["description"] == "Cell biology"
            assert duplicate_body["card_count"] == 2
            assert duplicate_body["due_count"] == 2
            assert {
                card["question"]
                for card in duplicate_body["cards"]
            } == {
                "Where is ATP produced?",
                "What is ATP?",
            }
            duplicate_tags = {
                card["question"]: card["tags"]
                for card in duplicate_body["cards"]
            }
            assert duplicate_tags == {
                "Where is ATP produced?": ["high yield", "mitochondria"],
                "What is ATP?": ["biochemistry"],
            }
            assert all(
                card["fsrs_state"] == 1
                and card["fsrs_step"] == 0
                and card["stability"] is None
                and card["difficulty"] is None
                and card["last_reviewed_at"] is None
                and card["review_count"] == 0
                and card["lapse_count"] == 0
                for card in duplicate_body["cards"]
            )
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 1

            assert (
                await client.post(
                    f"/api/decks/{deck_id}/duplicate",
                    headers=headers("valid-b"),
                    json={},
                )
            ).status_code == 404

            assert (
                await client.delete(
                    f"/api/decks/{deck_id}/cards/{second_card_id}",
                    headers=headers("valid-b"),
                )
            ).status_code == 404

            deleted_card = await client.delete(
                f"/api/decks/{deck_id}/cards/{first_card_id}",
                headers=headers(),
            )
            assert deleted_card.status_code == 204
            source_after_delete = await client.get(
                f"/api/decks/{deck_id}",
                headers=headers(),
            )
            assert source_after_delete.status_code == 200
            assert source_after_delete.json()["card_count"] == 1
            assert [
                card["id"]
                for card in source_after_delete.json()["cards"]
            ] == [second_card_id]
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 0

            assert (
                await client.delete(
                    f"/api/decks/{deck_id}",
                    headers=headers("valid-b"),
                )
            ).status_code == 404
            assert (
                await client.delete(
                    f"/api/decks/{deck_id}",
                    headers=headers(),
                )
            ).status_code == 204
            remaining = await client.get(
                "/api/decks",
                headers=headers(),
            )
            assert remaining.status_code == 200
            assert [
                item["id"]
                for item in remaining.json()
            ] == [duplicate_id]
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 0
            assert (
                await client.delete(
                    f"/api/decks/{duplicate_id}",
                    headers=headers(),
                )
            ).status_code == 204
            assert (
                await client.get(
                    "/api/decks",
                    headers=headers(),
                )
            ).json() == []

    asyncio.run(scenario())


def test_card_suspend_resume_and_reset_progress_preserve_history(api, owner):
    async def scenario():
        async with api() as (client, _):
            created = await client.post(
                "/api/decks",
                headers=headers(),
                json={
                    "name": "Spaced review state",
                    "cards": [{
                        "question_type": "short_answer",
                        "question": "What is ATP?",
                        "answer": {
                            "correct_answer": "Adenosine triphosphate",
                        },
                        "source_pages": [1],
                    }],
                },
            )
            assert created.status_code == 201, created.text
            body = created.json()
            deck_id = body["id"]
            card_id = body["cards"][0]["id"]
            assert body["due_count"] == 1
            assert body["cards"][0]["suspended"] is False
            assert body["cards"][0]["progress_reset_at"] is None

            suspended = await client.post(
                f"/api/decks/{deck_id}/cards/{card_id}/suspend",
                headers=headers(),
            )
            assert suspended.status_code == 200, suspended.text
            suspended_body = suspended.json()
            assert suspended_body["due_count"] == 0
            assert suspended_body["cards"][0]["suspended"] is True

            queue = await client.get(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
            )
            assert queue.status_code == 200
            assert queue.json()["due_count"] == 0
            assert queue.json()["cards"] == []

            blocked = await client.post(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                json={
                    "card_id": card_id,
                    "rating": 3,
                },
            )
            assert blocked.status_code == 409

            resumed = await client.post(
                f"/api/decks/{deck_id}/cards/{card_id}/resume",
                headers=headers(),
            )
            assert resumed.status_code == 200
            assert resumed.json()["due_count"] == 1
            assert resumed.json()["cards"][0]["suspended"] is False

            reviewed = await client.post(
                f"/api/decks/{deck_id}/review",
                headers=headers(),
                json={
                    "card_id": card_id,
                    "rating": 3,
                    "review_duration_ms": 900,
                },
            )
            assert reviewed.status_code == 200, reviewed.text
            assert reviewed.json()["card"]["review_count"] == 1
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 1

            reset = await client.post(
                f"/api/decks/{deck_id}/cards/{card_id}/reset-progress",
                headers=headers(),
            )
            assert reset.status_code == 200, reset.text
            reset_body = reset.json()
            reset_card = reset_body["cards"][0]
            assert reset_body["due_count"] == 1
            assert reset_card["suspended"] is False
            assert reset_card["fsrs_state"] == 1
            assert reset_card["fsrs_step"] == 0
            assert reset_card["stability"] is None
            assert reset_card["difficulty"] is None
            assert reset_card["last_reviewed_at"] is None
            assert reset_card["review_count"] == 0
            assert reset_card["lapse_count"] == 0
            assert reset_card["progress_reset_at"] is not None
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 1

            await client.post(
                f"/api/decks/{deck_id}/cards/{card_id}/suspend",
                headers=headers(),
            )
            reset_suspended = await client.post(
                f"/api/decks/{deck_id}/cards/{card_id}/reset-progress",
                headers=headers(),
            )
            assert reset_suspended.status_code == 200
            assert reset_suspended.json()["due_count"] == 0
            assert reset_suspended.json()["cards"][0]["suspended"] is True
            assert owner.execute(
                "SELECT count(*) FROM app.card_review_logs"
            ).fetchone()[0] == 1

            assert (
                await client.post(
                    f"/api/decks/{deck_id}/cards/{card_id}/resume",
                    headers=headers("valid-b"),
                )
            ).status_code == 404

    asyncio.run(scenario())


def test_study_notification_preferences_use_verified_owner_mapping(api, owner):
    async def scenario():
        async with api() as (client, _):
            initial = await client.get(
                "/api/study-notifications/preferences",
                headers=headers(),
            )
            assert initial.status_code == 200
            assert initial.json() == {
                "enabled": False,
                "reminder_time": "19:00:00",
                "timezone": "America/Toronto",
                "minimum_due_cards": 1,
            }

            saved = await client.put(
                "/api/study-notifications/preferences",
                headers=headers(),
                json={
                    "enabled": True,
                    "reminder_time": "20:30",
                    "timezone": "America/Toronto",
                    "minimum_due_cards": 3,
                },
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["enabled"] is True
            assert saved.json()["minimum_due_cards"] == 3

            other = await client.get(
                "/api/study-notifications/preferences",
                headers=headers("valid-b"),
            )
            assert other.status_code == 200
            assert other.json()["enabled"] is False
            assert other.json()["minimum_due_cards"] == 1

            row = owner.execute(
                """SELECT user_id,enabled,reminder_time::text,timezone,minimum_due_cards
                   FROM app.study_notification_preferences"""
            ).fetchall()
            assert row == [
                (
                    USERS[0],
                    True,
                    "20:30:00",
                    "America/Toronto",
                    3,
                )
            ]

            other_saved = await client.put(
                "/api/study-notifications/preferences",
                headers=headers("valid-b"),
                json={
                    "enabled": True,
                    "reminder_time": "08:15",
                    "timezone": "America/Vancouver",
                    "minimum_due_cards": 2,
                },
            )
            assert other_saved.status_code == 200

            rows = owner.execute(
                """SELECT user_id,timezone,minimum_due_cards
                   FROM app.study_notification_preferences
                   ORDER BY user_id"""
            ).fetchall()
            assert rows == [
                (USERS[0], "America/Toronto", 3),
                (USERS[1], "America/Vancouver", 2),
            ]

    asyncio.run(scenario())

def test_push_subscription_cannot_be_claimed_by_another_owner(api, owner):
    async def scenario():
        endpoint = (
            "https://fcm.googleapis.com/fcm/send/"
            "subscription-owner-isolation"
        )
        endpoint_hash = hashlib.sha256(
            endpoint.encode()
        ).hexdigest()

        async with api() as (client, _):
            created = await client.post(
                "/api/study-notifications/push/subscriptions",
                headers={
                    **headers(),
                    "User-Agent":
                        "Synthetic Browser A",
                },
                json={
                    "endpoint": endpoint,
                    "p256dh": "p" * 32,
                    "auth": "auth-token",
                },
            )
            assert created.status_code == 201, created.text
            assert created.json()["endpoint_hash"] == endpoint_hash

            row = owner.execute(
                """SELECT user_id,endpoint_hash,user_agent
                   FROM app.study_push_subscriptions"""
            ).fetchall()
            assert row == [
                (
                    USERS[0],
                    endpoint_hash,
                    "Synthetic Browser A",
                )
            ]

            conflict = await client.post(
                "/api/study-notifications/push/subscriptions",
                headers=headers("valid-b"),
                json={
                    "endpoint": endpoint,
                    "p256dh": "q" * 32,
                    "auth": "second-auth",
                },
            )
            assert conflict.status_code == 409

            deleted = await client.delete(
                "/api/study-notifications/push/subscriptions/"
                + endpoint_hash,
                headers=headers(),
            )
            assert deleted.status_code == 204
            assert owner.execute(
                "SELECT count(*) FROM app.study_push_subscriptions"
            ).fetchone()[0] == 0

            reassigned = await client.post(
                "/api/study-notifications/push/subscriptions",
                headers=headers("valid-b"),
                json={
                    "endpoint": endpoint,
                    "p256dh": "q" * 32,
                    "auth": "second-auth",
                },
            )
            assert reassigned.status_code == 201

            row = owner.execute(
                """SELECT user_id,p256dh
                   FROM app.study_push_subscriptions"""
            ).fetchall()
            assert row == [
                (USERS[1], "q" * 32)
            ]

    asyncio.run(scenario())

def test_move_card_preserves_review_state_and_owner_boundary(api, owner):
    async def scenario():
        async with api() as (client, _):
            source = await client.post(
                "/api/decks",
                headers=headers(),
                json={
                    "name": "Source",
                    "cards": [{
                        "question_type": "short_answer",
                        "question": "Move me",
                        "answer": {
                            "correct_answer": "Answer"
                        },
                        "choices": None,
                        "explanation": None,
                        "source_filename": "notes.pdf",
                        "document_sha256": "a" * 64,
                        "source_pages": [1],
                    }],
                },
            )
            assert source.status_code == 201, source.text
            source_body = source.json()
            source_id = source_body["id"]
            card_id = source_body["cards"][0]["id"]

            target = await client.post(
                "/api/decks",
                headers=headers(),
                json={
                    "name": "Target",
                    "cards": [],
                },
            )
            assert target.status_code == 201, target.text
            target_id = target.json()["id"]

            reviewed = await client.post(
                f"/api/decks/{source_id}/review",
                headers=headers(),
                json={
                    "card_id": card_id,
                    "rating": 3,
                    "review_duration_ms": 700,
                },
            )
            assert reviewed.status_code == 200, reviewed.text
            state = reviewed.json()["card"]
            assert state["review_count"] == 1
            assert state["stability"] > 0

            moved = await client.post(
                f"/api/decks/{source_id}/cards/{card_id}/move",
                headers=headers(),
                json={
                    "target_deck_id":
                        target_id,
                },
            )
            assert moved.status_code == 200, moved.text
            assert moved.json()["card_count"] == 0

            target_after = await client.get(
                f"/api/decks/{target_id}",
                headers=headers(),
            )
            assert target_after.status_code == 200
            moved_card = target_after.json()["cards"][0]
            assert moved_card["id"] == card_id
            assert moved_card["review_count"] == 1
            assert moved_card["stability"] == state["stability"]
            assert moved_card["difficulty"] == state["difficulty"]
            assert moved_card["last_reviewed_at"] == state["last_reviewed_at"]

            log_count = owner.execute(
                "SELECT count(*) FROM app.card_review_logs "
                "WHERE card_id=%s",
                (card_id,),
            ).fetchone()[0]
            assert log_count == 1

            foreign_target = await client.post(
                "/api/decks",
                headers=headers("valid-b"),
                json={
                    "name": "Foreign",
                    "cards": [],
                },
            )
            assert foreign_target.status_code == 201

            blocked = await client.post(
                f"/api/decks/{target_id}/cards/{card_id}/move",
                headers=headers(),
                json={
                    "target_deck_id":
                        foreign_target.json()["id"],
                },
            )
            assert blocked.status_code == 404

            stale = await client.post(
                f"/api/decks/{source_id}/cards/{card_id}/move",
                headers=headers(),
                json={
                    "target_deck_id":
                        target_id,
                },
            )
            assert stale.status_code == 404

    asyncio.run(scenario())

