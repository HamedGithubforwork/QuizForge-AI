"""Framework-independent study-review orchestration.

HTTP translation belongs in decks.py. PostgreSQL transactions, locking, and
persistence remain in deck_postgres.py. This module owns review-domain
decisions and FSRS scheduling so they can be tested without infrastructure.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from spaced_repetition import (
    ScheduledReview,
    preview_review_due_times,
    schedule_review,
)


class ReviewDomainError(Exception):
    def __init__(
        self,
        status_code: int,
        detail: str,
    ):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ReviewDecision:
    replayed: bool
    reviewed_at: datetime
    scheduled: ScheduledReview | None


def add_review_previews(
    state: Mapping[str, Any],
    *,
    review_now: datetime,
) -> dict[str, Any]:
    cards = []

    for original in state["cards"]:
        card = dict(original)
        card["review_preview"] = (
            preview_review_due_times(
                card,
                study_intensity=
                    state["study_intensity"],
                review_datetime=review_now,
            )
        )
        cards.append(card)

    return {
        **state,
        "cards": cards,
    }


def prepare_review(
    row: Mapping[str, Any],
    *,
    previous: Mapping[str, Any] | None,
    rating: int,
    review_duration_ms: int | None,
    offline,
    now: datetime,
) -> ReviewDecision:
    replayed = False
    reviewed_at = now

    if offline is not None:
        if previous is not None:
            if (
                previous["card_id"] != row["id"]
                or previous["rating"] != rating
                or previous["reviewed_at"]
                != offline.reviewed_at
                or previous["review_duration_ms"]
                != review_duration_ms
            ):
                raise ReviewDomainError(
                    409,
                    "This review event was already used for different data.",
                )
            replayed = True
        else:
            if (
                row["updated_at"]
                != offline.expected_updated_at
                or row["study_intensity"]
                != offline.expected_study_intensity
            ):
                raise ReviewDomainError(
                    409,
                    "This card changed online. Refresh it before reviewing again.",
                )

            if (
                offline.reviewed_at > now
                or offline.reviewed_at
                < now - timedelta(days=90)
                or offline.reviewed_at
                < row["updated_at"]
            ):
                raise ReviewDomainError(
                    422,
                    "Offline review time is outside the supported range.",
                )

        reviewed_at = offline.reviewed_at

    if replayed:
        return ReviewDecision(
            replayed=True,
            reviewed_at=reviewed_at,
            scheduled=None,
        )

    if row["suspended"]:
        raise ReviewDomainError(
            409,
            "This card is suspended.",
        )

    if row["due_at"] > reviewed_at:
        raise ReviewDomainError(
            409,
            "This card is not due yet.",
        )

    try:
        scheduled = schedule_review(
            row,
            rating,
            review_datetime=reviewed_at,
            review_duration_ms=review_duration_ms,
            study_intensity=
                row["study_intensity"],
        )
    except ValueError:
        raise ReviewDomainError(
            422,
            "Review rating or duration is invalid.",
        ) from None
    except RuntimeError:
        raise ReviewDomainError(
            503,
            "Spaced repetition scheduling is temporarily unavailable.",
        ) from None

    return ReviewDecision(
        replayed=False,
        reviewed_at=reviewed_at,
        scheduled=scheduled,
    )


class ReviewService:
    def __init__(
        self,
        repository,
        *,
        clock=None,
    ):
        self.repository = repository
        self.clock = (
            clock
            or (
                lambda:
                    datetime.now(
                        timezone.utc
                    )
            )
        )

    async def review_queue(
        self,
        deck_id,
        *,
        limit: int,
    ):
        state = (
            await self.repository
            .review_queue_state(
                deck_id,
                limit=limit,
            )
        )

        return add_review_previews(
            state,
            review_now=self.clock(),
        )

    async def review_card(
        self,
        deck_id,
        *,
        card_id,
        rating,
        review_duration_ms,
        offline=None,
    ):
        return await self.repository.apply_review(
            deck_id,
            card_id=card_id,
            rating=rating,
            review_duration_ms=
                review_duration_ms,
            offline=offline,
            prepare_review=prepare_review,
        )
