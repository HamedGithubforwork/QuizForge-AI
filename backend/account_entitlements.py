import os
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from app_shared import AuthenticatedUser


AdFreeEntitlementMode = Literal[
    "none",
    "allowlist_preview",
]


class AccountEntitlements(BaseModel):
    lifetime_ad_free: bool


@dataclass(frozen=True)
class LifetimeAdFreeDecision:
    entitled: bool
    mode: AdFreeEntitlementMode
    reason: str


def ad_free_entitlement_mode() -> AdFreeEntitlementMode:
    value = os.getenv(
        "AD_FREE_ENTITLEMENT_MODE",
        "none",
    ).strip()

    if value not in {
        "none",
        "allowlist_preview",
    }:
        raise RuntimeError(
            "AD_FREE_ENTITLEMENT_MODE is invalid."
        )

    return value


def preview_ad_free_user_ids() -> set[str]:
    return {
        value.strip()
        for value in os.getenv(
            "AD_FREE_ENTITLED_USER_IDS",
            "",
        ).split(",")
        if value.strip()
    }


def get_lifetime_ad_free_decision(
    current_user: AuthenticatedUser,
) -> LifetimeAdFreeDecision:
    mode = ad_free_entitlement_mode()

    if mode == "none":
        return LifetimeAdFreeDecision(
            entitled=False,
            mode=mode,
            reason="not_purchased",
        )

    entitled = (
        current_user.id
        in preview_ad_free_user_ids()
    )

    return LifetimeAdFreeDecision(
        entitled=entitled,
        mode=mode,
        reason=(
            "preview_entitled"
            if entitled
            else "not_entitled"
        ),
    )


def get_account_entitlements(
    current_user: AuthenticatedUser,
) -> AccountEntitlements:
    decision = get_lifetime_ad_free_decision(
        current_user
    )

    return AccountEntitlements(
        lifetime_ad_free=decision.entitled,
    )
