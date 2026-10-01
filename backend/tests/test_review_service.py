from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

import review_service
from review_service import (
    ReviewDomainError,
    ReviewService,
    add_review_previews,
    prepare_review,
)


CARD_ID = UUID(
    "22222222-2222-4222-8222-222222222222"
)
DECK_ID = UUID(
    "11111111-1111-4111-8111-111111111111"
)
NOW = datetime(
    2026,
    10,
    1,
    12,
    0,
    tzinfo=timezone.utc,
)


def row(**overrides):
    return {
        "id": CARD_ID,
        "deck_id": DECK_ID,
        "fsrs_state": 1,
        "fsrs_step": 0,
        "stability": None,
        "difficulty": None,
        "due_at": NOW - timedelta(days=1),
        "last_reviewed_at": None,
        "review_count": 0,
        "lapse_count": 0,
        "suspended": False,
        "updated_at": NOW - timedelta(days=2),
        "study_intensity": "balanced",
        **overrides,
    }


def offline(**overrides):
    return SimpleNamespace(
        event_id=uuid4(),
        reviewed_at=NOW - timedelta(hours=1),
        expected_updated_at=
            NOW - timedelta(days=2),
        expected_study_intensity=
            "balanced",
        **overrides,
    )


def assert_domain_error(
    status_code,
    function,
):
    with pytest.raises(
        ReviewDomainError
    ) as caught:
        function()

    assert (
        caught.value.status_code
        == status_code
    )


def test_add_review_previews_is_pure_and_complete():
    card = row()
    state = {
        "deck_id": DECK_ID,
        "deck_name": "Biology",
        "study_intensity": "balanced",
        "due_count": 1,
        "next_due_at": None,
        "cards": [card],
    }

    result = add_review_previews(
        state,
        review_now=NOW,
    )

    assert (
        "review_preview"
        not in card
    )
    assert set(
        result["cards"][0][
            "review_preview"
        ]
    ) == {
        "again",
        "hard",
        "good",
        "easy",
    }


def test_offline_replay_is_idempotent():
    event = offline()
    previous = {
        "card_id": CARD_ID,
        "rating": 3,
        "reviewed_at":
            event.reviewed_at,
        "review_duration_ms": 1200,
    }

    decision = prepare_review(
        row(),
        previous=previous,
        rating=3,
        review_duration_ms=1200,
        offline=event,
        now=NOW,
    )

    assert decision.replayed is True
    assert decision.scheduled is None
    assert (
        decision.reviewed_at
        == event.reviewed_at
    )


def test_changed_replay_is_rejected():
    event = offline()
    previous = {
        "card_id": CARD_ID,
        "rating": 4,
        "reviewed_at":
            event.reviewed_at,
        "review_duration_ms": 1200,
    }

    assert_domain_error(
        409,
        lambda: prepare_review(
            row(),
            previous=previous,
            rating=3,
            review_duration_ms=1200,
            offline=event,
            now=NOW,
        ),
    )


@pytest.mark.parametrize(
    "change",
    [
        {
            "expected_study_intensity":
                "intensive"
        },
        {
            "expected_updated_at":
                NOW - timedelta(days=3)
        },
    ],
)
def test_stale_offline_state_is_rejected(
    change,
):
    event = offline(**change)

    assert_domain_error(
        409,
        lambda: prepare_review(
            row(),
            previous=None,
            rating=3,
            review_duration_ms=1200,
            offline=event,
            now=NOW,
        ),
    )


@pytest.mark.parametrize(
    "reviewed_at",
    [
        NOW + timedelta(seconds=1),
        NOW - timedelta(days=91),
        NOW - timedelta(days=3),
    ],
)
def test_invalid_offline_time_is_rejected(
    reviewed_at,
):
    event = offline(
        reviewed_at=reviewed_at
    )

    assert_domain_error(
        422,
        lambda: prepare_review(
            row(),
            previous=None,
            rating=3,
            review_duration_ms=1200,
            offline=event,
            now=NOW,
        ),
    )


def test_suspended_and_not_due_cards_are_rejected():
    assert_domain_error(
        409,
        lambda: prepare_review(
            row(suspended=True),
            previous=None,
            rating=3,
            review_duration_ms=None,
            offline=None,
            now=NOW,
        ),
    )
    assert_domain_error(
        409,
        lambda: prepare_review(
            row(
                due_at=
                    NOW
                    + timedelta(hours=1)
            ),
            previous=None,
            rating=3,
            review_duration_ms=None,
            offline=None,
            now=NOW,
        ),
    )


def test_valid_review_returns_fsrs_schedule():
    decision = prepare_review(
        row(),
        previous=None,
        rating=3,
        review_duration_ms=800,
        offline=None,
        now=NOW,
    )

    assert decision.replayed is False
    assert decision.scheduled is not None
    assert decision.scheduled.rating == 3
    assert (
        decision.scheduled
        .review_duration_ms
        == 800
    )
    assert (
        decision.scheduled.reviewed_at
        == NOW
    )


def test_scheduler_validation_and_failure_are_domain_errors(
    monkeypatch,
):
    assert_domain_error(
        422,
        lambda: prepare_review(
            row(),
            previous=None,
            rating=9,
            review_duration_ms=None,
            offline=None,
            now=NOW,
        ),
    )

    def unavailable(*_args, **_kwargs):
        raise RuntimeError(
            "scheduler unavailable"
        )

    monkeypatch.setattr(
        review_service,
        "schedule_review",
        unavailable,
    )

    assert_domain_error(
        503,
        lambda: prepare_review(
            row(),
            previous=None,
            rating=3,
            review_duration_ms=None,
            offline=None,
            now=NOW,
        ),
    )


def test_review_service_owns_orchestration_contract():
    class Repository:
        def __init__(self):
            self.prepare = None

        async def review_queue_state(
            self,
            deck_id,
            *,
            limit,
        ):
            assert deck_id == DECK_ID
            assert limit == 10
            return {
                "deck_id": deck_id,
                "deck_name": "Biology",
                "study_intensity":
                    "balanced",
                "due_count": 1,
                "next_due_at": None,
                "cards": [row()],
            }

        async def apply_review(
            self,
            deck_id,
            **kwargs,
        ):
            assert deck_id == DECK_ID
            self.prepare = (
                kwargs["prepare_review"]
            )
            return {"committed": True}

    repository = Repository()
    service = ReviewService(
        repository,
        clock=lambda: NOW,
    )

    queue = asyncio.run(
        service.review_queue(
            DECK_ID,
            limit=10,
        )
    )
    result = asyncio.run(
        service.review_card(
            DECK_ID,
            card_id=CARD_ID,
            rating=3,
            review_duration_ms=500,
        )
    )

    assert (
        "review_preview"
        in queue["cards"][0]
    )
    assert result == {
        "committed": True
    }
    assert (
        repository.prepare
        is prepare_review
    )
