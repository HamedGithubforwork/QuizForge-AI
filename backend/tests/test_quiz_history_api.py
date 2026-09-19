import asyncio
import json

from fastapi.testclient import TestClient
import httpx
import pytest

import app_shared
from main import app, AuthenticatedUser, get_current_user
import quiz_history


USER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
ENTRY = "33333333-3333-4333-8333-333333333333"
HEADERS = {"Authorization": "Bearer test-user-token"}


def entry(**overrides):
    return {"quiz_title": "Water cycle", "source_filename": "notes.pdf",
            "document_sha256": "a" * 64, "difficulty": "easy",
            "question_type": "multiple_choice", "question_count": 5,
            "score": 4, "percentage": 80, "quiz_data": {"questions": []},
            "selected_answers": {"0": 1}, **overrides}


def row(**overrides):
    return {**entry(), "id": ENTRY, "user_id": USER,
            "created_at": "2026-09-16T12:00:00+00:00", **overrides}


@pytest.fixture
def api(monkeypatch):
    captured = []
    responses = []

    def handler(request):
        captured.append(request)
        return responses.pop(0)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def get_client():
        return client

    monkeypatch.setattr(quiz_history, "get_http_client", get_client)
    monkeypatch.setattr(app_shared, "SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setattr(app_shared, "SUPABASE_PUBLISHABLE_KEY", "test-publishable-key")
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(id=USER)
    try:
        yield TestClient(app), captured, responses
    finally:
        app.dependency_overrides.clear()
        asyncio.run(client.aclose())


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/quiz-history"), ("POST", "/api/quiz-history"),
    ("GET", "/api/quiz-history/document?source_filename=notes.pdf"),
    ("DELETE", f"/api/quiz-history/{ENTRY}"),
])
def test_history_requires_verified_authentication(method, path):
    response = TestClient(app).request(method, path, json=entry() if method == "POST" else None)
    assert response.status_code == 401


def test_list_uses_user_jwt_owner_filter_and_stable_cursor(api):
    client, captured, responses = api
    older = row(id=OTHER, created_at="2026-09-15T12:00:00+00:00")
    responses.append(httpx.Response(200, json=[row(), older], headers={"Content-Range": "0-1/7"}))
    result = client.get("/api/quiz-history?limit=1", headers=HEADERS)
    assert result.status_code == 200
    page = result.json()
    assert len(page["items"]) == 1 and page["totalCount"] == 7 and page["hasMore"] is True
    assert page["nextCursor"]["id"] == ENTRY
    request = captured[0]
    assert request.headers["Authorization"] == HEADERS["Authorization"]
    assert request.headers["apikey"] == "test-publishable-key"
    assert request.headers["Prefer"] == "count=exact"
    assert request.url.params["user_id"] == f"eq.{USER}"
    assert request.url.params["limit"] == "2"
    assert request.url.params["order"] == "created_at.desc,id.desc"

    responses.append(httpx.Response(200, json=[older]))
    second = client.get("/api/quiz-history", headers=HEADERS, params={
        "limit": 1, "cursor_created_at": page["nextCursor"]["createdAt"], "cursor_id": ENTRY})
    assert second.status_code == 200
    assert second.json()["totalCount"] is None and second.json()["nextCursor"] is None
    assert captured[1].url.params["or"] == (
        f"(created_at.lt.2026-09-16T12:00:00+00:00,and(created_at.eq.2026-09-16T12:00:00+00:00,id.lt.{ENTRY}))")


@pytest.mark.parametrize("params", [
    {"limit": 51}, {"limit": 0}, {"cursor_id": ENTRY},
    {"cursor_id": "x),user_id.neq.null", "cursor_created_at": "2026-09-16T12:00:00Z"},
    {"cursor_id": ENTRY, "cursor_created_at": "2026-09-16T12:00:00"},
])
def test_rejects_invalid_limits_and_cursor_injection_before_database(api, params):
    client, captured, _ = api
    assert client.get("/api/quiz-history", headers=HEADERS, params=params).status_code == 422
    assert captured == []


def test_create_derives_owner_and_preserves_quiz_payload(api):
    client, captured, responses = api
    responses.append(httpx.Response(201))
    assert client.post("/api/quiz-history", headers=HEADERS, json=entry()).status_code == 201
    payload = json.loads(captured[0].content)
    assert payload == {**entry(), "user_id": USER}
    assert captured[0].headers["Authorization"] == HEADERS["Authorization"]


@pytest.mark.parametrize("overrides", [{"user_id": OTHER}, {"score": 6}, {"percentage": 101},
                                       {"document_sha256": "bad"}, {"id": ENTRY}])
def test_create_rejects_forged_ownership_and_invalid_attempt(api, overrides):
    client, captured, _ = api
    assert client.post("/api/quiz-history", headers=HEADERS, json=entry(**overrides)).status_code == 422
    assert captured == []


def test_delete_is_scoped_to_verified_owner(api):
    client, captured, responses = api
    responses.append(httpx.Response(204))
    assert client.delete(f"/api/quiz-history/{ENTRY}", headers=HEADERS).status_code == 204
    assert dict(captured[0].url.params) == {"id": f"eq.{ENTRY}", "user_id": f"eq.{USER}"}


def test_document_history_combines_hash_and_legacy_without_same_name_collision(api):
    client, captured, responses = api
    responses.extend([
        httpx.Response(200, json=[row()]),
        httpx.Response(200, json=[
            row(id=OTHER, document_sha256=None, quiz_data={"document_sha256": "b" * 64}),
            row(id=USER, document_sha256=None, created_at="2026-09-15T12:00:00Z"),
        ]),
    ])
    response = client.get("/api/quiz-history/document", headers=HEADERS,
                          params={"source_filename": "notes.pdf", "document_sha256": "a" * 64})
    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [ENTRY, USER]
    assert all(request.url.params["user_id"] == f"eq.{USER}" for request in captured)
    assert captured[1].url.params["document_sha256"] == "is.null"


def test_filename_query_is_encoded_as_a_value(api):
    client, captured, responses = api
    responses.append(httpx.Response(200, json=[]))
    filename = 'notes.pdf&user_id=eq.someone-else'
    response = client.get("/api/quiz-history/document", headers=HEADERS,
                          params={"source_filename": filename})
    assert response.status_code == 200
    assert captured[0].url.params["source_filename"] == f"eq.{filename}"
    assert captured[0].url.params["user_id"] == f"eq.{USER}"


def test_never_returns_another_users_rows_even_if_upstream_misbehaves(api):
    client, _, responses = api
    responses.append(httpx.Response(200, json=[row(user_id=OTHER)]))
    response = client.get("/api/quiz-history", headers=HEADERS)
    assert response.status_code == 502
    assert OTHER not in response.text


def test_database_errors_are_sanitized(api):
    client, _, responses = api
    responses.append(httpx.Response(500, json={"detail": "secret-database-connection"}))
    response = client.get("/api/quiz-history", headers=HEADERS)
    assert response.status_code == 503 and "secret-database" not in response.text


def test_expired_upstream_token_preserves_401_for_frontend_refresh(api):
    client, _, responses = api
    responses.append(httpx.Response(401))
    assert client.get("/api/quiz-history", headers=HEADERS).status_code == 401


def test_history_delete_preflight_preserves_origin_allowlist(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://frontend.example")
    client = TestClient(app_shared.create_app())
    headers = {"Origin": "https://frontend.example", "Access-Control-Request-Method": "DELETE",
               "Access-Control-Request-Headers": "authorization"}
    allowed = client.options(f"/api/quiz-history/{ENTRY}", headers=headers)
    assert allowed.status_code == 200
    assert allowed.headers["Access-Control-Allow-Origin"] == "https://frontend.example"
    denied = client.options(f"/api/quiz-history/{ENTRY}", headers={**headers, "Origin": "https://untrusted.example"})
    assert denied.status_code == 400
    assert "Access-Control-Allow-Origin" not in denied.headers
