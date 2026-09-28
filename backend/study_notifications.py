"""Authenticated study-notification preference API."""

from datetime import time
import os
import re
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app_shared import AuthenticatedUser, get_current_user


PUSH_ENDPOINT_HOSTS = {
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
}


def push_endpoint_allowed(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (
            parsed.hostname or ""
        ).lower()
    except ValueError:
        return False

    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        return False

    return (
        host in PUSH_ENDPOINT_HOSTS
        or host.endswith(
            ".notify.windows.com"
        )
    )


router = APIRouter(
    prefix="/api/study-notifications",
    tags=["study-notifications"],
)


class StudyNotificationPreferences(BaseModel):
    enabled: bool = False
    reminder_time: time = time(19, 0)
    timezone: str = "America/Toronto"
    minimum_due_cards: int = Field(default=1, ge=1, le=1000)


class PushPublicKey(BaseModel):
    public_key: str


class PushSubscriptionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(min_length=20, max_length=4096)
    p256dh: str = Field(min_length=20, max_length=512)
    auth: str = Field(min_length=8, max_length=256)

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str):
        if not push_endpoint_allowed(
            value
        ):
            raise ValueError(
                "Push endpoint provider is not supported."
            )
        return value

    @field_validator("p256dh", "auth")
    @classmethod
    def validate_key(cls, value: str):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Push subscription key is invalid.")
        return value


class PushSubscriptionRegistration(BaseModel):
    endpoint_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


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


def vapid_public_key() -> str:
    value = os.getenv(
        "WEB_PUSH_VAPID_PUBLIC_KEY",
        "",
    ).strip()
    if not re.fullmatch(
        r"[A-Za-z0-9_-]{80,120}",
        value,
    ):
        raise HTTPException(
            503,
            "Browser push notifications are not configured.",
        )
    return value


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

@router.get(
    "/push/public-key",
    response_model=PushPublicKey,
)
async def get_push_public_key(
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    if not current_user.issuer or not current_user.subject:
        raise HTTPException(
            403,
            "Browser push notifications are not provisioned.",
        )
    return {
        "public_key": vapid_public_key(),
    }


@router.post(
    "/push/subscriptions",
    status_code=201,
    response_model=PushSubscriptionRegistration,
)
async def register_push_subscription(
    payload: PushSubscriptionCreate,
    request: Request,
    repository=Depends(get_notification_repository),
):
    user_agent = request.headers.get(
        "User-Agent",
        "",
    ).strip()
    return await repository.save_subscription(
        endpoint=payload.endpoint,
        p256dh=payload.p256dh,
        auth=payload.auth,
        user_agent=(
            user_agent[:500]
            if user_agent
            else None
        ),
    )


@router.delete(
    "/push/subscriptions/{endpoint_hash}",
    status_code=204,
    response_class=Response,
)
async def unregister_push_subscription(
    endpoint_hash: str,
    repository=Depends(get_notification_repository),
):
    if not re.fullmatch(
        r"[a-f0-9]{64}",
        endpoint_hash,
    ):
        raise HTTPException(
            422,
            "Push subscription identifier is invalid.",
        )
    await repository.delete_subscription(
        endpoint_hash,
    )
    return Response(status_code=204)

