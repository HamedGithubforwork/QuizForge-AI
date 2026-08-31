import asyncio

from fastapi import HTTPException

import application


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
        application,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        application,
        "get_processed_document",
        fake_get_processed_document,
    )
    monkeypatch.setattr(
        application,
        "get_cached_quiz",
        fake_get_cached_quiz,
    )
    monkeypatch.setattr(
        application,
        "acquire_quiz_generation_turn",
        fake_acquire_turn,
    )
    monkeypatch.setattr(
        application,
        "cache_quiz",
        fake_cache_quiz,
    )
    monkeypatch.setattr(
        application,
        "record_quiz_metrics",
        fake_record_quiz_metrics,
    )
    monkeypatch.setattr(
        application,
        "record_document_cache_metric",
        fake_record_document_cache_metric,
    )


def call_generation(user_id: str):
    return asyncio.run(
        application.generate_quiz(
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
                application.AuthenticatedUser(
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
        return application.Quiz(
            title="Handle quiz",
            questions=[],
        )

    monkeypatch.setattr(
        application,
        "generate_quiz_from_pages",
        fake_generation,
    )

    result = call_generation(
        "owner-user"
    )

    assert result.title == "Handle quiz"
    assert len(generated_pages) == 1
    assert len(generated_pages[0]) == 1
    assert list(generated_pages[0]) == PAGES


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
        application,
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
        application,
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


def test_generation_rejects_citation_outside_selected_context(
    monkeypatch,
):
    large_pages = [
        {
            "page_number": page_number,
            "text": (
                f"Page {page_number} study material. "
                + "x" * 6_000
            ),
        }
        for page_number in range(1, 31)
    ]

    patch_generation_dependencies(
        monkeypatch,
        processed_document={
            "pdf_sha256": DOCUMENT_SHA256,
            "pages": large_pages,
        },
    )

    async def fake_generation(**kwargs):
        generation_pages = kwargs["pages"]
        omitted_page = next(
            page_number
            for page_number in range(1, 31)
            if page_number
            not in generation_pages.source_pages
        )

        return application.Quiz.model_validate(
            {
                "title": "Ungrounded quiz",
                "questions": [
                    {
                        "question_type": "multiple_choice",
                        "question": "Ungrounded question?",
                        "choices": [
                            "Correct",
                            "Wrong A",
                            "Wrong B",
                            "Wrong C",
                        ],
                        "correct_index": 0,
                        "correct_answer": "Correct",
                        "accepted_answers": [
                            "Correct"
                        ],
                        "grading": {
                            "grading_version": 2,
                            "grading_mode": "none",
                            "answer_groups": [],
                            "required_group_count": 0,
                            "numeric_value": 0,
                            "numeric_tolerance": 0,
                            "numeric_unit": "",
                        },
                        "explanation": "Test explanation.",
                        "source_pages": [
                            omitted_page
                        ],
                    }
                ],
            }
        )

    async def fail_cache_quiz(
        _cache_key,
        _quiz,
    ):
        raise AssertionError(
            "ungrounded quiz must not be cached"
        )

    monkeypatch.setattr(
        application,
        "generate_quiz_from_pages",
        fake_generation,
    )
    monkeypatch.setattr(
        application,
        "cache_quiz",
        fail_cache_quiz,
    )

    try:
        call_generation(
            "owner-user"
        )
    except HTTPException as error:
        assert error.status_code == 502
        assert error.detail == (
            "The AI cited source material that was not included "
            "in the selected document context. Please try "
            "generating the quiz again."
        )
    else:
        raise AssertionError(
            "ungrounded source citation must be rejected"
        )
