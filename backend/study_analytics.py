"""Owner-scoped study analytics for the signed-in learner."""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app_shared import AuthenticatedUser, get_current_user


router = APIRouter(
    prefix="/api/study-analytics",
    tags=["study-analytics"],
)


class ActivityMetrics(BaseModel):
    reviews_today: int = Field(ge=0)
    reviews_last_7_days: int = Field(ge=0)
    study_time_today_ms: int = Field(ge=0)
    study_time_last_7_days_ms: int = Field(ge=0)
    active_days_last_7_days: int = Field(ge=0, le=7)


class MemoryMetrics(BaseModel):
    total_cards: int = Field(ge=0)
    active_cards: int = Field(ge=0)
    suspended_cards: int = Field(ge=0)
    due_cards: int = Field(ge=0)
    new_cards: int = Field(ge=0)
    learning_cards: int = Field(ge=0)
    review_cards: int = Field(ge=0)
    mature_cards: int = Field(ge=0)
    retention_card_count: int = Field(ge=0)
    estimated_retention: float | None = Field(
        default=None,
        ge=0,
        le=1,
    )


class RatingDistribution(BaseModel):
    again: int = Field(ge=0)
    hard: int = Field(ge=0)
    good: int = Field(ge=0)
    easy: int = Field(ge=0)
    total: int = Field(ge=0)


class DifficultCard(BaseModel):
    card_id: str
    deck_id: str
    deck_name: str
    question: str
    lapse_count: int = Field(ge=0)
    review_count: int = Field(ge=0)
    difficulty: float | None = Field(
        default=None,
        ge=1,
        le=10,
    )
    tags: list[str] = Field(
        default_factory=list,
    )


class StudyAnalyticsSummary(BaseModel):
    timezone: str
    generated_at: datetime
    total_decks: int = Field(ge=0)
    activity: ActivityMetrics
    memory: MemoryMetrics
    ratings_last_30_days: RatingDistribution
    difficult_cards: list[DifficultCard]


class AnalyticsQuery(BaseModel):
    timezone: str = "UTC"

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str):
        cleaned = value.strip()
        try:
            ZoneInfo(cleaned)
        except ZoneInfoNotFoundError:
            raise ValueError(
                "Timezone must be a valid IANA timezone."
            ) from None
        return cleaned


async def get_analytics_repository(
    request: Request,
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    from history_database import history_backend

    if history_backend() != "postgres":
        raise HTTPException(
            503,
            "Study analytics require PostgreSQL storage.",
        )

    pool = getattr(
        request.app.state,
        "history_pool",
        None,
    )
    if pool is None:
        raise HTTPException(
            503,
            "Study analytics are temporarily unavailable.",
        )

    if (
        not current_user.issuer
        or not current_user.subject
    ):
        raise HTTPException(
            403,
            "Study analytics are not provisioned.",
        )

    from study_analytics_postgres import (
        PostgresStudyAnalyticsRepository,
    )

    return PostgresStudyAnalyticsRepository(
        pool,
        issuer=current_user.issuer,
        subject=current_user.subject,
    )


@router.get(
    "/summary",
    response_model=StudyAnalyticsSummary,
)
async def get_study_analytics(
    timezone: str = "UTC",
    repository=Depends(
        get_analytics_repository
    ),
):
    try:
        query = AnalyticsQuery(
            timezone=timezone
        )
    except ValueError as error:
        raise HTTPException(
            422,
            str(error),
        ) from None

    return await repository.summary(
        timezone_name=query.timezone
    )
