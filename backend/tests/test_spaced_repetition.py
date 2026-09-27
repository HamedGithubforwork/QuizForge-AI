from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fsrs import Scheduler

from spaced_repetition import (
    card_from_row,
    schedule_review,
)


CARD_ID = UUID("11111111-1111-4111-8111-111111111111")
NOW = datetime(2026, 9, 27, 17, 30, tzinfo=timezone.utc)


def row(**changes):
    return {
        "id": CARD_ID,
        "fsrs_state": 1,
        "fsrs_step": 0,
        "stability": None,
        "difficulty": None,
        "due_at": NOW,
        "last_reviewed_at": None,
        **changes,
    }


def test_card_from_row_preserves_scheduler_state():
    card = card_from_row(
        row(
            fsrs_state=2,
            fsrs_step=None,
            stability=4.2,
            difficulty=5.1,
            due_at=NOW + timedelta(days=4),
            last_reviewed_at=NOW,
        )
    )

    assert card.card_id == CARD_ID.int
    assert int(card.state) == 2
    assert card.step is None
    assert card.stability == 4.2
    assert card.difficulty == 5.1
    assert card.last_review == NOW


@pytest.mark.parametrize("rating", [1, 2, 3, 4])
def test_first_review_produces_complete_future_state(rating):
    result = schedule_review(
        row(),
        rating,
        review_datetime=NOW,
        review_duration_ms=1200,
        scheduler=Scheduler(enable_fuzzing=False),
    )

    assert result.rating == rating
    assert result.reviewed_at == NOW
    assert result.last_reviewed_at == NOW
    assert result.review_duration_ms == 1200
    assert result.stability > 0
    assert 1 <= result.difficulty <= 10
    assert result.due_at > NOW
    assert result.fsrs_state in (1, 2, 3)


def test_again_on_review_counts_as_a_lapse():
    result = schedule_review(
        row(
            fsrs_state=2,
            fsrs_step=None,
            stability=7.0,
            difficulty=5.0,
            due_at=NOW,
            last_reviewed_at=NOW - timedelta(days=7),
        ),
        1,
        review_datetime=NOW,
        scheduler=Scheduler(enable_fuzzing=False),
    )

    assert result.lapse_increment == 1
    assert result.fsrs_state in (2, 3)


def test_again_while_learning_is_not_a_lapse():
    result = schedule_review(
        row(),
        1,
        review_datetime=NOW,
        scheduler=Scheduler(enable_fuzzing=False),
    )

    assert result.lapse_increment == 0


@pytest.mark.parametrize("rating", [0, 5])
def test_invalid_rating_is_rejected(rating):
    with pytest.raises(ValueError, match="between 1 and 4"):
        schedule_review(
            row(),
            rating,
            review_datetime=NOW,
            scheduler=Scheduler(enable_fuzzing=False),
        )


def test_naive_review_datetime_is_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        schedule_review(
            row(),
            3,
            review_datetime=NOW.replace(tzinfo=None),
            scheduler=Scheduler(enable_fuzzing=False),
        )


@pytest.mark.parametrize("duration", [-1, 86_400_001])
def test_invalid_duration_is_rejected(duration):
    with pytest.raises(ValueError, match="duration"):
        schedule_review(
            row(),
            3,
            review_datetime=NOW,
            review_duration_ms=duration,
            scheduler=Scheduler(enable_fuzzing=False),
        )
