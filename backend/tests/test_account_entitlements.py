import asyncio

import pytest

from app_shared import AuthenticatedUser
import application
from account_entitlements import (
    ad_free_entitlement_mode,
    get_account_entitlements,
    get_lifetime_ad_free_decision,
    preview_ad_free_user_ids,
)


USER = AuthenticatedUser(
    id="cognito:pool:user-1",
    email="user@example.com",
)


def test_default_entitlement_is_not_ad_free(
    monkeypatch,
):
    monkeypatch.delenv(
        "AD_FREE_ENTITLEMENT_MODE",
        raising=False,
    )
    monkeypatch.delenv(
        "AD_FREE_ENTITLED_USER_IDS",
        raising=False,
    )

    decision = get_lifetime_ad_free_decision(
        USER
    )
    snapshot = get_account_entitlements(
        USER
    )

    assert decision.entitled is False
    assert decision.mode == "none"
    assert decision.reason == "not_purchased"
    assert snapshot.model_dump() == {
        "lifetime_ad_free": False,
    }


def test_preview_allowlist_requires_exact_authenticated_user_id(
    monkeypatch,
):
    monkeypatch.setenv(
        "AD_FREE_ENTITLEMENT_MODE",
        "allowlist_preview",
    )
    monkeypatch.setenv(
        "AD_FREE_ENTITLED_USER_IDS",
        "other-user, cognito:pool:user-1",
    )

    assert preview_ad_free_user_ids() == {
        "other-user",
        "cognito:pool:user-1",
    }

    entitled = get_lifetime_ad_free_decision(
        USER
    )
    denied = get_lifetime_ad_free_decision(
        AuthenticatedUser(
            id="cognito:pool:user-2"
        )
    )

    assert entitled.entitled is True
    assert entitled.reason == "preview_entitled"
    assert denied.entitled is False
    assert denied.reason == "not_entitled"


def test_invalid_entitlement_mode_fails_closed(
    monkeypatch,
):
    monkeypatch.setenv(
        "AD_FREE_ENTITLEMENT_MODE",
        "trust-client",
    )

    with pytest.raises(
        RuntimeError
    ):
        ad_free_entitlement_mode()


def test_public_entitlement_snapshot_does_not_expose_preview_configuration(
    monkeypatch,
):
    monkeypatch.setenv(
        "AD_FREE_ENTITLEMENT_MODE",
        "allowlist_preview",
    )
    monkeypatch.setenv(
        "AD_FREE_ENTITLED_USER_IDS",
        USER.id,
    )

    snapshot = get_account_entitlements(
        USER
    )

    assert snapshot.model_dump() == {
        "lifetime_ad_free": True,
    }


def test_authenticated_entitlement_route_returns_server_decision(
    monkeypatch,
):
    monkeypatch.setenv(
        "AD_FREE_ENTITLEMENT_MODE",
        "allowlist_preview",
    )
    monkeypatch.setenv(
        "AD_FREE_ENTITLED_USER_IDS",
        USER.id,
    )

    result = asyncio.run(
        application.get_account_entitlements_route(
            current_user=USER,
        )
    )

    assert result.model_dump() == {
        "lifetime_ad_free": True,
    }
