from datetime import datetime, timezone

from fastapi.testclient import TestClient
import pytest

import study_analytics
from main import app


class FakeRepository:
    def __init__(self):
        self.calls = []

    async def summary(
        self,
        *,
        timezone_name,
    ):
        self.calls.append(
            (
                "summary",
                timezone_name,
            )
        )
        return {
            "timezone":
                timezone_name,
            "generated_at":
                datetime(
                    2026,
                    9,
                    29,
                    1,
                    0,
                    tzinfo=timezone.utc,
                ),
            "total_decks": 2,
            "activity": {
                "reviews_today": 3,
                "reviews_last_7_days": 12,
                "study_time_today_ms": 60000,
                "study_time_last_7_days_ms": 300000,
                "active_days_last_7_days": 4,
            },
            "memory": {
                "total_cards": 20,
                "active_cards": 18,
                "suspended_cards": 2,
                "due_cards": 4,
                "new_cards": 5,
                "learning_cards": 3,
                "review_cards": 10,
                "mature_cards": 4,
                "retention_card_count": 13,
                "estimated_retention": 0.91,
            },
            "ratings_last_30_days": {
                "again": 2,
                "hard": 3,
                "good": 10,
                "easy": 5,
                "total": 20,
            },
            "difficult_cards": [
                {
                    "card_id":
                        "11111111-1111-4111-8111-111111111111",
                    "deck_id":
                        "22222222-2222-4222-8222-222222222222",
                    "deck_name":
                        "Biology",
                    "question":
                        "What is ATP?",
                    "lapse_count": 3,
                    "review_count": 9,
                    "difficulty": 8.2,
                    "tags": [
                        "cell biology"
                    ],
                },
            ],
        }


@pytest.fixture
def api():
    repository = FakeRepository()
    app.dependency_overrides[
        study_analytics
        .get_analytics_repository
    ] = lambda: repository
    try:
        yield TestClient(app), repository
    finally:
        app.dependency_overrides.clear()


def test_analytics_require_authentication():
    response = TestClient(app).get(
        "/api/study-analytics/summary"
    )
    assert response.status_code == 401


def test_summary_forwards_valid_iana_timezone(api):
    client, repository = api

    response = client.get(
        "/api/study-analytics/summary",
        params={
            "timezone":
                "America/Toronto"
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert (
        body["timezone"]
        == "America/Toronto"
    )
    assert (
        body["activity"][
            "reviews_today"
        ]
        == 3
    )
    assert (
        body["memory"][
            "estimated_retention"
        ]
        == 0.91
    )
    assert (
        body["difficult_cards"][0][
            "lapse_count"
        ]
        == 3
    )
    assert repository.calls == [
        (
            "summary",
            "America/Toronto",
        )
    ]


@pytest.mark.parametrize(
    "value",
    [
        "",
        "Not/A_Real_Zone",
        "../../../etc/passwd",
    ],
)
def test_invalid_timezone_is_rejected_before_repository(
    api,
    value,
):
    client, repository = api

    response = client.get(
        "/api/study-analytics/summary",
        params={
            "timezone": value,
        },
    )

    assert response.status_code == 422
    assert repository.calls == []
