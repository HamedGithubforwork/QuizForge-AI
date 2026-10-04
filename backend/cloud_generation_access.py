import os
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException

from app_shared import AuthenticatedUser


CloudAccessMode = Literal[
    "legacy_open",
    "allowlist_preview",
]


@dataclass(frozen=True)
class CloudGenerationAccess:
    allowed: bool
    mode: CloudAccessMode
    reason: str


def cloud_generation_access_mode() -> CloudAccessMode:
    value = os.getenv(
        "CLOUD_GENERATION_ACCESS_MODE",
        "legacy_open",
    ).strip()

    if value not in {
        "legacy_open",
        "allowlist_preview",
    }:
        raise RuntimeError(
            "CLOUD_GENERATION_ACCESS_MODE is invalid."
        )

    return value


def preview_entitled_user_ids() -> set[str]:
    return {
        value.strip()
        for value in os.getenv(
            "CLOUD_GENERATION_ENTITLED_USER_IDS",
            "",
        ).split(",")
        if value.strip()
    }


def get_cloud_generation_access(
    current_user: AuthenticatedUser,
) -> CloudGenerationAccess:
    mode = cloud_generation_access_mode()

    if mode == "legacy_open":
        return CloudGenerationAccess(
            allowed=True,
            mode=mode,
            reason="legacy_open",
        )

    allowed = (
        current_user.id
        in preview_entitled_user_ids()
    )

    return CloudGenerationAccess(
        allowed=allowed,
        mode=mode,
        reason=(
            "preview_entitled"
            if allowed
            else "not_entitled"
        ),
    )


async def require_cloud_generation_access(
    current_user: AuthenticatedUser,
):
    try:
        decision = get_cloud_generation_access(
            current_user
        )
    except RuntimeError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "GPT Cloud access is temporarily "
                "unavailable."
            ),
        ) from error

    if not decision.allowed:
        raise HTTPException(
            status_code=403,
            detail=(
                "GPT Cloud access is not enabled "
                "for this account."
            ),
        )

    return decision
