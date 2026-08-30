import asyncio
import json
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


def test_redis_hit_discards_duplicate_memory_fallback(
    monkeypatch,
):
    processed_documents._memory_documents.clear()

    document = {
        "pdf_sha256": PDF_SHA256,
        "pages": PAGES,
    }

    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
        pages=PAGES,
    ) is True

    cache_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    )
    assert cache_key in processed_documents._memory_documents

    async def fake_cache_hit(_cache_key):
        return document

    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_cache_hit,
    )

    result = asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256=PDF_SHA256,
        )
    )

    assert result == document
    assert cache_key not in processed_documents._memory_documents


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

    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
        pages=PAGES,
    ) is True

    cache_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=PDF_SHA256,
    )
    (
        _expires_at,
        serialized_size,
        document,
    ) = processed_documents._memory_documents[
        cache_key
    ]
    processed_documents._memory_documents[
        cache_key
    ] = (
        time.monotonic() - 1,
        serialized_size,
        document,
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


def test_memory_fallback_evicts_least_recently_used_entry(
    monkeypatch,
):
    processed_documents._memory_documents.clear()

    monkeypatch.setattr(
        processed_documents,
        "PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES",
        2,
    )
    monkeypatch.setattr(
        processed_documents,
        "PROCESSED_DOCUMENT_MEMORY_MAX_BYTES",
        10_000,
    )

    async def fake_cache_miss(_cache_key):
        return None

    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_cache_miss,
    )

    hashes = [
        compute_pdf_sha256(value)
        for value in (b"one", b"two", b"three")
    ]

    for index, pdf_sha256 in enumerate(hashes[:2], start=1):
        assert remember_processed_document(
            user_id="user-1",
            pdf_sha256=pdf_sha256,
            pages=[
                {
                    "page_number": 1,
                    "text": f"document {index}",
                }
            ],
        ) is True

    assert asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256=hashes[0],
        )
    ) is not None

    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=hashes[2],
        pages=[
            {
                "page_number": 1,
                "text": "document 3",
            }
        ],
    ) is True

    first_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=hashes[0],
    )
    second_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=hashes[1],
    )
    third_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=hashes[2],
    )

    assert list(processed_documents._memory_documents) == [
        first_key,
        third_key,
    ]
    assert second_key not in processed_documents._memory_documents


def test_memory_fallback_respects_total_byte_limit(
    monkeypatch,
):
    processed_documents._memory_documents.clear()

    first_hash = compute_pdf_sha256(b"first")
    second_hash = compute_pdf_sha256(b"second")
    pages = [
        {
            "page_number": 1,
            "text": "x" * 120,
        }
    ]

    document_size = len(
        json.dumps(
            {
                "pdf_sha256": first_hash,
                "pages": pages,
            },
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    )

    monkeypatch.setattr(
        processed_documents,
        "PROCESSED_DOCUMENT_MEMORY_MAX_ENTRIES",
        10,
    )
    monkeypatch.setattr(
        processed_documents,
        "PROCESSED_DOCUMENT_MEMORY_MAX_BYTES",
        document_size * 2 - 1,
    )

    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=first_hash,
        pages=pages,
    ) is True
    assert remember_processed_document(
        user_id="user-1",
        pdf_sha256=second_hash,
        pages=pages,
    ) is True

    first_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=first_hash,
    )
    second_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=second_hash,
    )

    assert first_key not in processed_documents._memory_documents
    assert second_key in processed_documents._memory_documents
    assert (
        processed_documents._memory_document_bytes()
        <= processed_documents.PROCESSED_DOCUMENT_MEMORY_MAX_BYTES
    )


def test_invalid_document_hash_is_rejected():
    assert asyncio.run(
        get_processed_document(
            user_id="user-1",
            pdf_sha256="not-a-sha",
        )
    ) is None
