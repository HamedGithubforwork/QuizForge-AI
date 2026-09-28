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


def deck_detail(
    *,
    cards=None,
    name="Biology Midterm",
    description="Cell biology",
    due_count=None,
    next_due_at=None,
):
    now = datetime(2026, 9, 27, 14, 0, tzinfo=timezone.utc)
    values = cards or []
    return {
        "id": DECK_ID,
        "name": name,
        "description": description,
        "card_count": len(values),
        "due_count": (
            len(values)
            if due_count is None
            else due_count
        ),
        "next_due_at": next_due_at,
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
        "fsrs_state": 1,
        "fsrs_step": 0,
        "stability": None,
        "difficulty": None,
        "due_at": now,
        "last_reviewed_at": None,
        "review_count": 0,
        "lapse_count": 0,
        "suspended": False,
        "progress_reset_at": None,
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
                tags=item.tags,
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

    async def duplicate(
        self,
        deck_id,
        *,
        name,
    ):
        self.calls.append(
            (
                "duplicate",
                deck_id,
                name,
            )
        )
        return deck_detail(
            cards=[card_row()],
            name=(
                name
                or "Copy of Biology Midterm"
            ),
        )

    async def update(self, deck_id, payload):
        self.calls.append(("update", deck_id, payload))
        return deck_detail(
            cards=[card_row()],
            name=payload.name or "Biology Midterm",
            description=payload.description,
        )

    async def delete(self, deck_id):
        self.calls.append(("delete", deck_id))

    async def update_card(
        self,
        deck_id,
        card_id,
        payload,
    ):
        self.calls.append(
            (
                "update_card",
                deck_id,
                card_id,
                payload,
            )
        )
        return deck_detail(
            cards=[
                card_row(
                    id=card_id,
                    question=(
                        payload.question
                        or "What organelle produces ATP?"
                    ),
                    explanation=(
                        payload.explanation
                        if "explanation"
                        in payload.model_fields_set
                        else "Mitochondria perform cellular respiration."
                    ),
                    tags=(
                        payload.tags
                        if "tags"
                        in payload.model_fields_set
                        else []
                    ),
                )
            ]
        )

    async def move_card(
        self,
        deck_id,
        card_id,
        target_deck_id,
    ):
        self.calls.append(
            (
                "move_card",
                deck_id,
                card_id,
                target_deck_id,
            )
        )
        return deck_detail(
            cards=[],
        )

    async def set_card_suspended(
        self,
        deck_id,
        card_id,
        suspended,
    ):
        self.calls.append(
            (
                "set_card_suspended",
                deck_id,
                card_id,
                suspended,
            )
        )
        return deck_detail(
            cards=[
                card_row(
                    suspended=suspended,
                )
            ]
        )

    async def reset_card_progress(
        self,
        deck_id,
        card_id,
    ):
        self.calls.append(
            (
                "reset_card_progress",
                deck_id,
                card_id,
            )
        )
        return deck_detail(
            cards=[
                card_row(
                    fsrs_state=1,
                    fsrs_step=0,
                    stability=None,
                    difficulty=None,
                    last_reviewed_at=None,
                    review_count=0,
                    lapse_count=0,
                    progress_reset_at=datetime(
                        2026,
                        9,
                        28,
                        12,
                        0,
                        tzinfo=timezone.utc,
                    ),
                )
            ]
        )

    async def delete_card(
        self,
        deck_id,
        card_id,
    ):
        self.calls.append(
            (
                "delete_card",
                deck_id,
                card_id,
            )
        )

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
                tags=item.tags,
            )
            for index, item in enumerate(cards)
        ]
        return deck_detail(cards=values)

    async def review_queue(
        self,
        deck_id,
        *,
        limit,
        tag=None,
    ):
        self.calls.append(
            (
                "review_queue",
                deck_id,
                limit,
                tag,
            )
        )
        return {
            "deck_id": deck_id,
            "deck_name": "Biology Midterm",
            "tag": tag,
            "due_count": 1,
            "next_due_at": None,
            "cards": [card_row()],
        }

    async def review_card(
        self,
        deck_id,
        *,
        card_id,
        rating,
        review_duration_ms,
    ):
        self.calls.append(
            (
                "review_card",
                deck_id,
                card_id,
                rating,
                review_duration_ms,
            )
        )
        return {
            "card": card_row(
                id=card_id,
                fsrs_state=2,
                fsrs_step=None,
                stability=3.5,
                difficulty=5.0,
                review_count=1,
                last_reviewed_at=datetime(
                    2026,
                    9,
                    27,
                    14,
                    5,
                    tzinfo=timezone.utc,
                ),
                due_at=datetime(
                    2026,
                    9,
                    30,
                    14,
                    5,
                    tzinfo=timezone.utc,
                ),
            ),
            "remaining_due_count": 0,
            "next_due_at": datetime(
                2026,
                9,
                30,
                14,
                5,
                tzinfo=timezone.utc,
            ),
        }


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


def test_create_card_normalizes_and_deduplicates_tags(api):
    client, repository = api

    response = client.post(
        "/api/decks",
        json={
            "name": "Tagged Deck",
            "cards": [
                card(
                    tags=[
                        "  Exam  One ",
                        "exam one",
                        "Neuro   Biology",
                    ]
                )
            ],
        },
    )

    assert response.status_code == 201
    assert response.json()["cards"][0]["tags"] == [
        "exam one",
        "neuro biology",
    ]

    _, payload = repository.calls[0]
    assert payload.cards[0].tags == [
        "exam one",
        "neuro biology",
    ]


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
        {
            "name": "Deck",
            "cards": [
                card(tags=["   "]),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(tags=["x" * 51]),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(tags=[f"tag-{index}" for index in range(21)]),
            ],
        },
        {
            "name": "Deck",
            "cards": [
                card(tags=["valid", None]),
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
    assert listed.json()[0]["due_count"] == 0

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

def test_review_queue_returns_due_cards(api):
    client, repository = api

    response = client.get(
        f"/api/decks/{DECK_ID}/review?limit=10"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["tag"] is None
    assert body["due_count"] == 1
    assert body["cards"][0]["id"] == str(CARD_ID)
    assert body["cards"][0]["fsrs_state"] == 1
    assert repository.calls == [
        (
            "review_queue",
            DECK_ID,
            10,
            None,
        )
    ]


def test_review_queue_normalizes_tag_filter(api):
    client, repository = api

    response = client.get(
        f"/api/decks/{DECK_ID}/review",
        params={
            "limit": 7,
            "tag":
                "  CELL   Biology ",
        },
    )

    assert response.status_code == 200
    assert response.json()["tag"] == "cell biology"
    assert repository.calls == [
        (
            "review_queue",
            DECK_ID,
            7,
            "cell biology",
        )
    ]


@pytest.mark.parametrize(
    "tag",
    [
        "   ",
        "x" * 51,
    ],
)
def test_review_queue_rejects_invalid_tag_before_repository(
    api,
    tag,
):
    client, repository = api

    response = client.get(
        f"/api/decks/{DECK_ID}/review",
        params={"tag": tag},
    )

    assert response.status_code == 422
    assert repository.calls == []


@pytest.mark.parametrize("limit", [0, 51])
def test_review_queue_rejects_invalid_limits(api, limit):
    client, repository = api

    response = client.get(
        f"/api/decks/{DECK_ID}/review",
        params={"limit": limit},
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_review_rating_is_forwarded_without_owner_fields(api):
    client, repository = api

    response = client.post(
        f"/api/decks/{DECK_ID}/review",
        json={
            "card_id": str(CARD_ID),
            "rating": 3,
            "review_duration_ms": 1500,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["card"]["review_count"] == 1
    assert body["card"]["fsrs_state"] == 2
    assert body["remaining_due_count"] == 0
    assert repository.calls == [
        (
            "review_card",
            DECK_ID,
            CARD_ID,
            3,
            1500,
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {
            "card_id": str(CARD_ID),
            "rating": 0,
        },
        {
            "card_id": str(CARD_ID),
            "rating": 5,
        },
        {
            "card_id": str(CARD_ID),
            "rating": 3,
            "review_duration_ms": -1,
        },
        {
            "card_id": str(CARD_ID),
            "rating": 3,
            "review_duration_ms": 86_400_001,
        },
        {
            "card_id": str(CARD_ID),
            "rating": 3,
            "user_id": "forged",
        },
    ],
)
def test_review_rejects_invalid_or_forged_payloads_before_repository(
    api,
    payload,
):
    client, repository = api

    response = client.post(
        f"/api/decks/{DECK_ID}/review",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []

def test_duplicate_deck_uses_optional_name(api):
    client, repository = api

    default = client.post(
        f"/api/decks/{DECK_ID}/duplicate",
        json={},
    )
    assert default.status_code == 201
    assert default.json()["name"] == "Copy of Biology Midterm"

    named = client.post(
        f"/api/decks/{DECK_ID}/duplicate",
        json={"name": "  Biology Retake  "},
    )
    assert named.status_code == 201
    assert named.json()["name"] == "Biology Retake"

    assert repository.calls == [
        (
            "duplicate",
            DECK_ID,
            None,
        ),
        (
            "duplicate",
            DECK_ID,
            "Biology Retake",
        ),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "   "},
        {"name": None, "user_id": "forged"},
        {"name": "x" * 201},
    ],
)
def test_duplicate_deck_rejects_invalid_payloads_before_repository(
    api,
    payload,
):
    client, repository = api

    response = client.post(
        f"/api/decks/{DECK_ID}/duplicate",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []

def test_update_card_accepts_partial_changes_and_preserves_null_clearable_fields(api):
    client, repository = api

    response = client.patch(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}",
        json={
            "question":
                "Which organelle makes ATP?",
            "explanation": None,
        },
    )

    assert response.status_code == 200
    assert (
        response.json()["cards"][0]["question"]
        == "Which organelle makes ATP?"
    )
    assert (
        response.json()["cards"][0]["explanation"]
        is None
    )


    tags = client.patch(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}",
        json={
            "tags": [
                "  Finals ",
                "finals",
                "High   Yield",
            ]
        },
    )
    assert tags.status_code == 200
    assert tags.json()["cards"][0]["tags"] == [
        "finals",
        "high yield",
    ]

    cleared = client.patch(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}",
        json={"tags": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["cards"][0]["tags"] == []

    _, deck_id, card_id, payload = (
        repository.calls[0]
    )
    assert deck_id == DECK_ID
    assert card_id == CARD_ID
    assert payload.question == (
        "Which organelle makes ATP?"
    )
    assert "explanation" in (
        payload.model_fields_set
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"question": "   "},
        {"question": None},
        {"question_type": None},
        {"answer": None},
        {"source_pages": None},
        {"tags": None},
        {"tags": [""]},
        {"tags": ["x" * 51]},
        {"tags": [f"tag-{index}" for index in range(21)]},
        {"source_pages": [2, 2]},
        {"source_pages": [0]},
        {"document_sha256": "bad"},
        {"user_id": "forged"},
        {"fsrs_state": 2},
        {"review_count": 0},
    ],
)
def test_update_card_rejects_invalid_or_scheduler_fields_before_repository(
    api,
    payload,
):
    client, repository = api

    response = client.patch(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}",
        json=payload,
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_delete_card_uses_owned_path_identifiers_only(api):
    client, repository = api

    response = client.delete(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}"
    )

    assert response.status_code == 204
    assert repository.calls == [
        (
            "delete_card",
            DECK_ID,
            CARD_ID,
        )
    ]

def test_move_card_forwards_owned_identifiers_and_returns_source_deck(api):
    client, repository = api
    target_deck_id = UUID(
        "33333333-3333-4333-8333-333333333333"
    )

    response = client.post(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}/move",
        json={
            "target_deck_id":
                str(target_deck_id),
        },
    )

    assert response.status_code == 200
    assert response.json()["id"] == str(DECK_ID)
    assert response.json()["card_count"] == 0
    assert repository.calls == [
        (
            "move_card",
            DECK_ID,
            CARD_ID,
            target_deck_id,
        )
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {
            "target_deck_id":
                str(DECK_ID),
        },
        {
            "target_deck_id":
                "not-a-uuid",
        },
        {
            "target_deck_id":
                str(UUID(int=9)),
            "user_id":
                "forged",
        },
    ],
)
def test_move_card_rejects_same_deck_invalid_or_forged_payloads_before_repository(
    api,
    payload,
):
    client, repository = api

    response = client.post(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}/move",
        json=payload,
    )

    assert response.status_code in (
        409,
        422,
    )
    assert repository.calls == []

def test_suspend_and_resume_card_use_owned_path_identifiers(api):
    client, repository = api

    suspended = client.post(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}/suspend"
    )
    assert suspended.status_code == 200
    assert suspended.json()["cards"][0]["suspended"] is True

    resumed = client.post(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}/resume"
    )
    assert resumed.status_code == 200
    assert resumed.json()["cards"][0]["suspended"] is False

    assert repository.calls == [
        (
            "set_card_suspended",
            DECK_ID,
            CARD_ID,
            True,
        ),
        (
            "set_card_suspended",
            DECK_ID,
            CARD_ID,
            False,
        ),
    ]


def test_reset_progress_returns_fresh_scheduler_state(api):
    client, repository = api

    response = client.post(
        f"/api/decks/{DECK_ID}/cards/{CARD_ID}/reset-progress"
    )

    assert response.status_code == 200
    card = response.json()["cards"][0]
    assert card["fsrs_state"] == 1
    assert card["fsrs_step"] == 0
    assert card["stability"] is None
    assert card["difficulty"] is None
    assert card["last_reviewed_at"] is None
    assert card["review_count"] == 0
    assert card["lapse_count"] == 0
    assert card["progress_reset_at"] is not None
    assert repository.calls == [
        (
            "reset_card_progress",
            DECK_ID,
            CARD_ID,
        )
    ]

