from datetime import datetime, timezone
from uuid import UUID

from fastapi.testclient import TestClient
import pytest

import decks
from main import app


DECK_ID = UUID("11111111-1111-4111-8111-111111111111")
CARD_ID = UUID("22222222-2222-4222-8222-222222222222")


def card(**overrides):
    return {
        "question_type": "multiple_choice",
        "question": "What organelle produces ATP?",
        "answer": {
            "correct_index": 1,
            "correct_answer": "Mitochondria",
            "accepted_answers": ["Mitochondria"],
        },
        "choices": [
            "Nucleus",
            "Mitochondria",
            "Ribosome",
        ],
        "explanation": "Mitochondria perform cellular respiration.",
        "source_filename": "biology.pdf",
        "document_sha256": "a" * 64,
        "source_pages": [14, 12],
        **overrides,
    }


def deck_detail(*, cards=None, name="Biology Midterm", description="Cell biology"):
    now = datetime(2026, 9, 27, 14, 0, tzinfo=timezone.utc)
    values = cards or []
    return {
        "id": DECK_ID,
        "name": name,
        "description": description,
        "card_count": len(values),
        "created_at": now,
        "updated_at": now,
        "cards": values,
    }


def card_row(**overrides):
    now = datetime(2026, 9, 27, 14, 0, tzinfo=timezone.utc)
    return {
        **card(),
        "id": CARD_ID,
        "deck_id": DECK_ID,
        "source_pages": [12, 14],
        "created_at": now,
        "updated_at": now,
        **overrides,
    }


class FakeRepository:
    def __init__(self):
        self.calls = []

    async def list(self):
        self.calls.append(("list",))
        detail = deck_detail()
        return [{key: value for key, value in detail.items() if key != "cards"}]

    async def create(self, payload):
        self.calls.append(("create", payload))
        cards = [
            card_row(
                id=UUID(int=index + 1),
                question_type=item.question_type,
                question=item.question,
                answer=item.answer,
                choices=item.choices,
                explanation=item.explanation,
                source_filename=item.source_filename,
                document_sha256=item.document_sha256,
                source_pages=item.source_pages,
            )
            for index, item in enumerate(payload.cards)
        ]
        return deck_detail(
            cards=cards,
            name=payload.name,
            description=payload.description,
        )

    async def get(self, deck_id):
        self.calls.append(("get", deck_id))
        return deck_detail(cards=[card_row()])

    async def update(self, deck_id, payload):
        self.calls.append(("update", deck_id, payload))
        return deck_detail(
            cards=[card_row()],
            name=payload.name or "Biology Midterm",
            description=payload.description,
        )

    async def delete(self, deck_id):
        self.calls.append(("delete", deck_id))

    async def add_cards(self, deck_id, cards):
        self.calls.append(("add_cards", deck_id, cards))
        values = [
            card_row(
                id=UUID(int=index + 10),
                question_type=item.question_type,
                question=item.question,
                answer=item.answer,
                choices=item.choices,
                explanation=item.explanation,
                source_filename=item.source_filename,
                document_sha256=item.document_sha256,
                source_pages=item.source_pages,
            )
            for index, item in enumerate(cards)
        ]
        return deck_detail(cards=values)


@pytest.fixture
def api():
    repository = FakeRepository()
    app.dependency_overrides[decks.get_deck_repository] = lambda: repository
    try:
        yield TestClient(app), repository
    finally:
        app.dependency_overrides.clear()


def test_decks_require_authentication():
    response = TestClient(app).get("/api/decks")
    assert response.status_code == 401


def test_create_deck_sorts_and_preserves_all_source_pages(api):
    client, repository = api
    response = client.post(
        "/api/decks",
        json={
            "name": "  Biology Midterm  ",
            "description": "Cell biology",
            "cards": [card()],
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Biology Midterm"
    assert body["card_count"] == 1
    assert body["cards"][0]["source_pages"] == [12, 14]

    _, payload = repository.calls[0]
    assert payload.name == "Biology Midterm"
    assert payload.cards[0].source_pages == [12, 14]


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "Deck", "user_id": str(UUID(int=8))},
        {"name": "Deck", "id": str(DECK_ID)},
        {"name": "   "},
        {
            "name": "Deck",
            "cards": [
                card(user_id=str(UUID(int=8))),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(source_pages=[12, 12]),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(source_pages=[0]),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(document_sha256="bad"),
            ],
        },
    ],
)
def test_create_rejects_forged_ownership_and_invalid_cards_before_repository(api, payload):
    client, repository = api
    response = client.post("/api/decks", json=payload)
    assert response.status_code == 422
    assert repository.calls == []


def test_list_and_get_return_decks(api):
    client, repository = api

    listed = client.get("/api/decks")
    assert listed.status_code == 200
    assert listed.json()[0]["name"] == "Biology Midterm"

    fetched = client.get(f"/api/decks/{DECK_ID}")
    assert fetched.status_code == 200
    assert fetched.json()["cards"][0]["id"] == str(CARD_ID)
    assert [call[0] for call in repository.calls] == ["list", "get"]


def test_update_requires_a_real_change_and_never_accepts_owner_fields(api):
    client, repository = api

    assert client.patch(f"/api/decks/{DECK_ID}", json={}).status_code == 422
    assert client.patch(
        f"/api/decks/{DECK_ID}",
        json={"user_id": str(UUID(int=9))},
    ).status_code == 422
    assert repository.calls == []

    response = client.patch(
        f"/api/decks/{DECK_ID}",
        json={"name": "  Exam Review  ", "description": None},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Exam Review"
    _, deck_id, payload = repository.calls[0]
    assert deck_id == DECK_ID
    assert payload.name == "Exam Review"
    assert "description" in payload.model_fields_set


def test_batch_add_cards_is_bounded_and_preserves_provenance(api):
    client, repository = api
    response = client.post(
        f"/api/decks/{DECK_ID}/cards",
        json={"cards": [card(source_pages=[9, 3])]},
    )
    assert response.status_code == 201
    assert response.json()["cards"][0]["source_pages"] == [3, 9]
    _, deck_id, cards = repository.calls[0]
    assert deck_id == DECK_ID
    assert cards[0].source_pages == [3, 9]

    too_many = client.post(
        f"/api/decks/{DECK_ID}/cards",
        json={"cards": [card() for _ in range(51)]},
    )
    assert too_many.status_code == 422
    assert len(repository.calls) == 1


def test_delete_uses_path_id_only(api):
    client, repository = api
    response = client.delete(f"/api/decks/{DECK_ID}")
    assert response.status_code == 204
    assert repository.calls == [("delete", DECK_ID)]


def test_patch_preflight_allows_configured_frontend(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://frontend.example")
    from app_shared import create_app

    local = create_app()
    local.include_router(decks.router)
    client = TestClient(local)
    headers = {
        "Origin": "https://frontend.example",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
    }
    allowed = client.options(f"/api/decks/{DECK_ID}", headers=headers)
    assert allowed.status_code == 200
    assert allowed.headers["Access-Control-Allow-Origin"] == "https://frontend.example"
