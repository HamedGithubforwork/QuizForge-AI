"""Authenticated study-notification preference API."""

import base64
from datetime import datetime, time
import os
import re
from urllib.parse import urlparse
from uuid import UUID
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


class WebPushKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")

    p256dh: str = Field(
        min_length=40,
        max_length=256,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    auth: str = Field(
        min_length=16,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
    )


class WebPushSubscriptionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(
        min_length=10,
        max_length=4096,
    )
    keys: WebPushKeys

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str):
        cleaned = value.strip()
        parsed = urlparse(cleaned)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise ValueError(
                "Push endpoint must be a valid HTTPS URL."
            )
        return cleaned


class WebPushSubscriptionSummary(BaseModel):
    id: UUID
    endpoint_sha256: str
    failure_count: int = Field(ge=0)
    last_success_at: datetime | None
    created_at: datetime
    updated_at: datetime


class VapidPublicKeyResponse(BaseModel):
    public_key: str


def vapid_public_key() -> str:
    value = os.getenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        "",
    ).strip()
    if not re.fullmatch(
        r"[A-Za-z0-9_-]{80,100}",
        value,
    ):
        raise HTTPException(
            503,
            "Browser notifications are not configured.",
        )
    try:
        raw = base64.urlsafe_b64decode(
            value
            + "="
            * (-len(value) % 4)
        )
    except ValueError:
        raise HTTPException(
            503,
            "Browser notifications are not configured.",
        ) from None
    if len(raw) != 65 or raw[0] != 4:
        raise HTTPException(
            503,
            "Browser notifications are not configured.",
        )
    return value


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
    "/vapid-public-key",
    response_model=VapidPublicKeyResponse,
)
async def get_vapid_public_key(
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    if not current_user.subject:
        raise HTTPException(
            403,
            "Browser notification access is not provisioned.",
        )
    return {
        "public_key": vapid_public_key(),
    }


@router.get(
    "/subscriptions",
    response_model=list[WebPushSubscriptionSummary],
)
async def list_push_subscriptions(
    repository=Depends(get_notification_repository),
):
    return await repository.list_subscriptions()


@router.post(
    "/subscriptions",
    status_code=201,
    response_model=WebPushSubscriptionSummary,
)
async def save_push_subscription(
    payload: WebPushSubscriptionCreate,
    repository=Depends(get_notification_repository),
):
    return await repository.save_subscription(
        payload,
    )


@router.delete(
    "/subscriptions/{subscription_id}",
    status_code=204,
)
async def delete_push_subscription(
    subscription_id: UUID,
    repository=Depends(get_notification_repository),
):
    await repository.delete_subscription(
        subscription_id,
    )
    return None


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
