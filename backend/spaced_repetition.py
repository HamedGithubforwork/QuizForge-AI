"""Small adapter between QuizForge card rows and the FSRS scheduler."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping, Any
from uuid import UUID

from fsrs import Card, Rating, Scheduler, State


STUDY_INTENSITY_RETENTION = {
    "relaxed": 0.85,
    "balanced": 0.90,
    "intensive": 0.95,
}

DEFAULT_STUDY_INTENSITY = "balanced"


def desired_retention(
    study_intensity: str,
) -> float:
    try:
        return STUDY_INTENSITY_RETENTION[
            study_intensity
        ]
    except KeyError:
        raise ValueError(
            "Study intensity is invalid."
        ) from None


def scheduler_for_intensity(
    study_intensity: str,
    *,
    enable_fuzzing: bool = True,
) -> Scheduler:
    return Scheduler(
        desired_retention=desired_retention(
            study_intensity
        ),
        enable_fuzzing=enable_fuzzing,
    )


DEFAULT_SCHEDULER = (
    scheduler_for_intensity(
        DEFAULT_STUDY_INTENSITY
    )
)


@dataclass(frozen=True)
class ScheduledReview:
    fsrs_state: int
    fsrs_step: int | None
    stability: float
    difficulty: float
    due_at: datetime
    last_reviewed_at: datetime
    rating: int
    reviewed_at: datetime
    review_duration_ms: int | None
    lapse_increment: int


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("FSRS timestamps must be timezone-aware.")
    return value.astimezone(timezone.utc)


def card_from_row(row: Mapping[str, Any]) -> Card:
    card_id = UUID(str(row["id"])).int
    due = as_utc(row["due_at"])
    last_reviewed = row.get("last_reviewed_at")

    return Card(
        card_id=card_id,
        state=State(int(row["fsrs_state"])),
        step=row["fsrs_step"],
        stability=(
            float(row["stability"])
            if row["stability"] is not None
            else None
        ),
        difficulty=(
            float(row["difficulty"])
            if row["difficulty"] is not None
            else None
        ),
        due=due,
        last_review=(
            as_utc(last_reviewed)
            if last_reviewed is not None
            else None
        ),
    )


def schedule_review(
    row: Mapping[str, Any],
    rating: int,
    *,
    review_datetime: datetime | None = None,
    review_duration_ms: int | None = None,
    study_intensity: str = DEFAULT_STUDY_INTENSITY,
    scheduler: Scheduler | None = None,
) -> ScheduledReview:
    try:
        fsrs_rating = Rating(rating)
    except ValueError:
        raise ValueError("Review rating must be between 1 and 4.") from None

    if review_duration_ms is not None and not 0 <= review_duration_ms <= 86_400_000:
        raise ValueError("Review duration is outside the supported range.")

    current = (
        datetime.now(timezone.utc)
        if review_datetime is None
        else as_utc(review_datetime)
    )
    before = card_from_row(row)
    active_scheduler = (
        scheduler
        if scheduler is not None
        else scheduler_for_intensity(
            study_intensity
        )
    )

    updated, log = active_scheduler.review_card(
        before,
        fsrs_rating,
        review_datetime=current,
        review_duration=review_duration_ms,
    )

    if updated.stability is None or updated.difficulty is None:
        raise RuntimeError("FSRS returned incomplete card state.")

    lapse_increment = int(
        before.state == State.Review
        and fsrs_rating == Rating.Again
    )

    return ScheduledReview(
        fsrs_state=int(updated.state),
        fsrs_step=updated.step,
        stability=float(updated.stability),
        difficulty=float(updated.difficulty),
        due_at=as_utc(updated.due),
        last_reviewed_at=as_utc(updated.last_review),
        rating=int(log.rating),
        reviewed_at=as_utc(log.review_datetime),
        review_duration_ms=log.review_duration,
        lapse_increment=lapse_increment,
    )

def preview_review_due_times(
    row: Mapping[str, Any],
    *,
    study_intensity: str = DEFAULT_STUDY_INTENSITY,
    review_datetime: datetime | None = None,
) -> dict[str, datetime]:
    current = (
        datetime.now(timezone.utc)
        if review_datetime is None
        else as_utc(review_datetime)
    )
    preview_scheduler = (
        scheduler_for_intensity(
            study_intensity,
            enable_fuzzing=False,
        )
    )
    labels = {
        1: "again",
        2: "hard",
        3: "good",
        4: "easy",
    }

    return {
        label: schedule_review(
            row,
            rating,
            review_datetime=current,
            study_intensity=
                study_intensity,
            scheduler=
                preview_scheduler,
        ).due_at
        for rating, label
        in labels.items()
    }

