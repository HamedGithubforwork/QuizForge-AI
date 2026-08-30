import asyncio
import time

import processed_documents
from processed_documents import (
    build_document_cache_key_from_sha,
    build_quiz_cache_key_from_sha,
    get_processed_document,
    remember_processed_document,
)
from redis_integration import (
    build_document_cache_key,
    build_quiz_cache_key,
    compute_pdf_sha256,
)


PDF_BYTES = b"same pdf bytes"
PDF_SHA256 = compute_pdf_sha256(
    PDF_BYTES
)
PAGES = [
    {
        "page_number": 1,
        "text": "Processed page text",
    }
]


def test_sha_document_key_matches_existing_content_key():
    assert build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    ) == build_document_cache_key(
        user_id="user-1",
        contents=PDF_BYTES,
    )


def test_sha_quiz_key_matches_existing_content_key():
    expected = build_quiz_cache_key(
        user_id="user-1",
        contents=PDF_BYTES,
        question_count=5,
        difficulty="Medium",
        question_type="mixed",
        focus_pages="1",
        focus_question_types="short_answer",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    actual = build_quiz_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
        question_count=5,
        difficulty="Medium",
        question_type="mixed",
        focus_pages="1",
        focus_question_types="short_answer",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    assert actual == expected


def test_processed_document_memory_fallback_is_user_scoped(
    monkeypatch,
):
    processed_documents._memory_documents.clear()

    async def fake_cache_miss(_cache_key):
        return None

    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_cache_miss,
    )

    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
        pages=PAGES,
    ) is True

    owner_document = asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
    )
    other_user_document = asyncio.run(
        get_processed_document(
            user_id="user-2",
            pdf_sha256=PDF_SHA256,
        )
    )

    assert owner_document == {
        "pdf_sha256": PDF_SHA256,
        "pages": PAGES,
    }
    assert other_user_document is None


def test_expired_memory_document_is_not_returned(
    monkeypatch,
):
    processed_documents._memory_documents.clear()

    async def fake_cache_miss(_cache_key):
        return None

    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_cache_miss,
    )

    cache_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    )
    processed_documents._memory_documents[
        cache_key
    ] = (
        time.monotonic() - 1,
        {
            "pdf_sha256": PDF_SHA256,
            "pages": PAGES,
        },
    )

    result = asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
    )

    assert result is None
    assert cache_key not in (
        processed_documents._memory_documents
    )


def test_invalid_document_hash_is_rejected():
    assert asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256="not-a-sha",
        )
    ) is None
