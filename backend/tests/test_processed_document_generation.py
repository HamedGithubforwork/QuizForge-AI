import asyncio

from fastapi import HTTPException

import main_redis


DOCUMENT_SHA256 = "a" * 64
PAGES = [
    {
        "page_number": 1,
        "text": "Processed study material",
    }
]


def patch_generation_dependencies(
    monkeypatch,
    *,
    processed_document,
):
    async def fake_rate_limit(_user_id):
        return None

    async def fake_get_processed_document(
        *,
        user_id,
        pdf_sha256,
    ):
        assert pdf_sha256 == DOCUMENT_SHA256

        if user_id != "owner-user":
            return None

        return processed_document

    async def fake_get_cached_quiz(
        _cache_key,
        _quiz_model,
    ):
        return None

    async def fake_acquire_turn(
        _cache_key,
        *,
        use_cached_result,
    ):
        assert use_cached_result is True
        return None, None

    async def fake_cache_quiz(
        _cache_key,
        _quiz,
    ):
        return None

    async def fake_record_quiz_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        assert cache_result in {
            "miss",
            "hit",
        }
        assert duration_ms >= 0
        assert isinstance(failed, bool)

    async def fake_record_document_cache_metric(
        _client,
        _cache_result,
    ):
        return None

    monkeypatch.setattr(
        main_redis,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        main_redis,
        "get_processed_document",
        fake_get_processed_document,
    )
    monkeypatch.setattr(
        main_redis,
        "get_cached_quiz",
        fake_get_cached_quiz,
    )
    monkeypatch.setattr(
        main_redis,
        "acquire_quiz_generation_turn",
        fake_acquire_turn,
    )
    monkeypatch.setattr(
        main_redis,
        "cache_quiz",
        fake_cache_quiz,
    )
    monkeypatch.setattr(
        main_redis,
        "record_quiz_metrics",
        fake_record_quiz_metrics,
    )
    monkeypatch.setattr(
        main_redis,
        "record_document_cache_metric",
        fake_record_document_cache_metric,
    )


def call_generation(user_id: str):
    return asyncio.run(
        main_redis.generate_quiz(
            file=None,
            document_sha256=(
                DOCUMENT_SHA256
            ),
            question_count=5,
            difficulty="medium",
            question_type=(
                "multiple_choice"
            ),
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=False,
            current_user=(
                main_redis.AuthenticatedUser(
                    id=user_id
                )
            ),
        )
    )


def test_generation_uses_processed_pages_without_pdf_upload(
    monkeypatch,
):
    generated_pages = []

    patch_generation_dependencies(
        monkeypatch,
        processed_document={
            "pdf_sha256": DOCUMENT_SHA256,
            "pages": PAGES,
        },
    )

    async def fake_generation(**kwargs):
        generated_pages.append(
            kwargs["pages"]
        )
        return main_redis.Quiz(
            title="Handle quiz",
            questions=[],
        )

    monkeypatch.setattr(
        main_redis,
        "generate_quiz_from_pages",
        fake_generation,
    )

    result = call_generation(
        "owner-user"
    )

    assert result.title == "Handle quiz"
    assert generated_pages == [PAGES]


def test_expired_processed_document_requires_reprocessing(
    monkeypatch,
):
    patch_generation_dependencies(
        monkeypatch,
        processed_document=None,
    )

    async def fail_generation(**_kwargs):
        raise AssertionError(
            "expired document must not reach AI generation"
        )

    monkeypatch.setattr(
        main_redis,
        "generate_quiz_from_pages",
        fail_generation,
    )

    try:
        call_generation(
            "owner-user"
        )
    except HTTPException as error:
        assert error.status_code == 410
        assert error.detail == (
            "Processed document expired or is unavailable. "
            "Please process the PDF again."
        )
    else:
        raise AssertionError(
            "expired handle should return HTTP 410"
        )


def test_same_hash_cannot_access_another_users_document(
    monkeypatch,
):
    patch_generation_dependencies(
        monkeypatch,
        processed_document={
            "pdf_sha256": DOCUMENT_SHA256,
            "pages": PAGES,
        },
    )

    async def fail_generation(**_kwargs):
        raise AssertionError(
            "cross-user document access must be rejected"
        )

    monkeypatch.setattr(
        main_redis,
        "generate_quiz_from_pages",
        fail_generation,
    )

    try:
        call_generation(
            "different-user"
        )
    except HTTPException as error:
        assert error.status_code == 410
    else:
        raise AssertionError(
            "another user's handle must not resolve"
        )
