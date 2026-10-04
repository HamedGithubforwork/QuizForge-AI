import asyncio

import pytest
from fastapi import HTTPException

from app_shared import AuthenticatedUser
import application
from cloud_generation_access import (
    cloud_generation_access_mode,
    get_cloud_generation_access,
    preview_entitled_user_ids,
    require_cloud_generation_access,
)


USER = AuthenticatedUser(
    id="cognito:pool:user-1",
    email="user@example.com",
)


def test_default_mode_preserves_existing_cloud_access(
    monkeypatch,
):
    monkeypatch.delenv(
        "CLOUD_GENERATION_ACCESS_MODE",
        raising=False,
    )
    monkeypatch.delenv(
        "CLOUD_GENERATION_ENTITLED_USER_IDS",
        raising=False,
    )

    decision = get_cloud_generation_access(
        USER
    )

    assert decision.allowed is True
    assert decision.mode == "legacy_open"
    assert decision.reason == "legacy_open"


def test_allowlist_preview_requires_exact_user_entitlement(
    monkeypatch,
):
    monkeypatch.setenv(
        "CLOUD_GENERATION_ACCESS_MODE",
        "allowlist_preview",
    )
    monkeypatch.setenv(
        "CLOUD_GENERATION_ENTITLED_USER_IDS",
        "other-user, cognito:pool:user-1",
    )

    assert preview_entitled_user_ids() == {
        "other-user",
        "cognito:pool:user-1",
    }

    allowed = get_cloud_generation_access(
        USER
    )
    denied = get_cloud_generation_access(
        AuthenticatedUser(
            id="cognito:pool:user-2"
        )
    )

    assert allowed.allowed is True
    assert allowed.reason == "preview_entitled"
    assert denied.allowed is False
    assert denied.reason == "not_entitled"


def test_allowlist_preview_denies_before_cloud_generation(
    monkeypatch,
):
    monkeypatch.setenv(
        "CLOUD_GENERATION_ACCESS_MODE",
        "allowlist_preview",
    )
    monkeypatch.delenv(
        "CLOUD_GENERATION_ENTITLED_USER_IDS",
        raising=False,
    )

    with pytest.raises(
        HTTPException
    ) as error:
        asyncio.run(
            require_cloud_generation_access(
                USER
            )
        )

    assert error.value.status_code == 403
    assert error.value.detail == (
        "GPT Cloud access is not enabled "
        "for this account."
    )


def test_invalid_access_mode_fails_closed(
    monkeypatch,
):
    monkeypatch.setenv(
        "CLOUD_GENERATION_ACCESS_MODE",
        "open-forever",
    )

    with pytest.raises(
        RuntimeError
    ):
        cloud_generation_access_mode()

    with pytest.raises(
        HTTPException
    ) as error:
        asyncio.run(
            require_cloud_generation_access(
                USER
            )
        )

    assert error.value.status_code == 503


def test_generation_route_checks_cloud_access_before_rate_limit_or_source_work(
    monkeypatch,
):
    calls = []

    async def deny(_user):
        calls.append("access")
        raise HTTPException(
            status_code=403,
            detail="GPT Cloud access is not enabled for this account.",
        )

    async def rate_limit(_user_id):
        calls.append("rate_limit")
        raise AssertionError(
            "denied users must not consume cloud rate-limit work"
        )

    monkeypatch.setattr(
        application,
        "require_cloud_generation_access",
        deny,
    )
    monkeypatch.setattr(
        application,
        "enforce_quiz_rate_limit",
        rate_limit,
    )

    with pytest.raises(
        HTTPException
    ) as error:
        asyncio.run(
            application.generate_quiz(
                file=None,
                document_sha256="a" * 64,
                question_count=5,
                difficulty="medium",
                question_type="multiple_choice",
                focus_pages="",
                focus_question_types="",
                avoid_questions="[]",
                generate_new_quiz_instead_of_using_cache=False,
                current_user=USER,
            )
        )

    assert error.value.status_code == 403
    assert calls == ["access"]
