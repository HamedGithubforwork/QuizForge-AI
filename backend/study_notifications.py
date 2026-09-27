"""Authenticated study-notification preference API."""

from datetime import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app_shared import AuthenticatedUser, get_current_user


router = APIRouter(
    prefix="/api/study-notifications",
    tags=["study-notifications"],
)


class StudyNotificationPreferences(BaseModel):
    enabled: bool = False
    reminder_time: time = time(19, 0)
    timezone: str = "America/Toronto"
    minimum_due_cards: int = Field(default=1, ge=1, le=1000)


class StudyNotificationPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    reminder_time: time
    timezone: str = Field(min_length=1, max_length=100)
    minimum_due_cards: int = Field(ge=1, le=1000)

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


async def get_notification_repository(
    request: Request,
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    from history_database import history_backend

    if history_backend() != "postgres":
        raise HTTPException(
            503,
            "Study notifications require PostgreSQL storage.",
        )

    pool = getattr(request.app.state, "history_pool", None)
    if pool is None:
        raise HTTPException(
            503,
            "Study notification settings are temporarily unavailable.",
        )

    if not current_user.issuer or not current_user.subject:
        raise HTTPException(
            403,
            "Study notification settings are not provisioned.",
        )

    from notification_preferences_postgres import (
        PostgresNotificationPreferencesRepository,
    )

    return PostgresNotificationPreferencesRepository(
        pool,
        issuer=current_user.issuer,
        subject=current_user.subject,
    )


@router.get(
    "/preferences",
    response_model=StudyNotificationPreferences,
)
async def get_preferences(
    repository=Depends(get_notification_repository),
):
    return await repository.get()


@router.put(
    "/preferences",
    response_model=StudyNotificationPreferences,
)
async def update_preferences(
    payload: StudyNotificationPreferencesUpdate,
    repository=Depends(get_notification_repository),
):
    return await repository.save(payload)
