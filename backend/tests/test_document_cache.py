import asyncio

import main_redis
import redis_integration
from redis_integration import (
    build_document_cache_key,
    cache_document,
    compute_pdf_sha256,
    get_cached_document,
)


class FakeDocumentRedis:
    def __init__(self):
        self.values = {}
        self.expirations = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(
        self,
        key,
        value,
        ex=None,
    ):
        self.values[key] = value
        self.expirations[key] = ex
        return True


def test_document_cache_key_is_stable_for_same_pdf():
    first = build_document_cache_key(
        user_id="user-1",
        contents=b"same pdf bytes",
    )

    second = build_document_cache_key(
        user_id="user-1",
        contents=b"same pdf bytes",
    )

    assert first == second


def test_document_cache_key_changes_with_pdf_contents():
    first = build_document_cache_key(
        user_id="user-1",
        contents=b"pdf one",
    )

    second = build_document_cache_key(
        user_id="user-1",
        contents=b"pdf two",
    )

    assert first != second


def test_document_cache_key_is_isolated_per_user():
    first = build_document_cache_key(
        user_id="user-1",
        contents=b"same pdf",
    )

    second = build_document_cache_key(
        user_id="user-2",
        contents=b"same pdf",
    )

    assert first != second


def test_document_cache_round_trip():
    fake_redis = FakeDocumentRedis()
    contents = b"same pdf"
    cache_key = build_document_cache_key(
        user_id="user-1",
        contents=contents,
    )
    document = {
        "pdf_sha256": compute_pdf_sha256(
            contents
        ),
        "pages": [
            {
                "page_number": 1,
                "text": "Cached extracted text",
            }
        ],
    }

    stored = asyncio.run(
        cache_document(
            cache_key,
            document,
            client=fake_redis,
        )
    )

    cached = asyncio.run(
        get_cached_document(
            cache_key,
            client=fake_redis,
        )
    )

    assert stored is True
    assert cached == document
    assert (
        fake_redis.expirations[cache_key]
        == redis_integration.DOCUMENT_CACHE_TTL_SECONDS
    )


def test_document_cache_hit_skips_pdf_extraction(
    monkeypatch,
):
    contents = b"same pdf"
    pages = [
        {
            "page_number": 1,
            "text": "Already extracted",
        }
    ]
    pdf_sha256 = compute_pdf_sha256(
        contents
    )
    metric_results = []

    async def fake_get_cached_document(
        _cache_key,
    ):
        return {
            "pdf_sha256": pdf_sha256,
            "pages": pages,
        }

    async def fake_record_document_cache_metric(
        _client,
        cache_result,
    ):
        metric_results.append(cache_result)

    def fail_extraction(_contents):
        raise AssertionError(
            "a document-cache hit must not run PyMuPDF extraction"
        )

    monkeypatch.setattr(
        main_redis,
        "get_cached_document",
        fake_get_cached_document,
    )
    monkeypatch.setattr(
        main_redis,
        "record_document_cache_metric",
        fake_record_document_cache_metric,
    )
    monkeypatch.setattr(
        main_redis,
        "extract_pdf_pages_without_redis",
        fail_extraction,
    )

    result_hash, result_pages = asyncio.run(
        main_redis.get_document_pages_with_cache(
            user_id="user-1",
            contents=contents,
        )
    )

    assert result_hash == pdf_sha256
    assert result_pages == pages
    assert metric_results == ["hit"]


def test_document_cache_miss_extracts_and_stores(
    monkeypatch,
):
    contents = b"same pdf"
    pages = [
        {
            "page_number": 1,
            "text": "Newly extracted",
        }
    ]
    stored_documents = []
    metric_results = []

    async def fake_get_cached_document(
        _cache_key,
    ):
        return None

    def fake_extraction(received_contents):
        assert received_contents == contents
        return pages

    async def fake_cache_document(
        cache_key,
        document,
    ):
        stored_documents.append(
            (cache_key, document)
        )
        return True

    async def fake_record_document_cache_metric(
        _client,
        cache_result,
    ):
        metric_results.append(cache_result)

    monkeypatch.setattr(
        main_redis,
        "get_cached_document",
        fake_get_cached_document,
    )
    monkeypatch.setattr(
        main_redis,
        "extract_pdf_pages_without_redis",
        fake_extraction,
    )
    monkeypatch.setattr(
        main_redis,
        "cache_document",
        fake_cache_document,
    )
    monkeypatch.setattr(
        main_redis,
        "record_document_cache_metric",
        fake_record_document_cache_metric,
    )

    result_hash, result_pages = asyncio.run(
        main_redis.get_document_pages_with_cache(
            user_id="user-1",
            contents=contents,
        )
    )

    assert result_hash == compute_pdf_sha256(
        contents
    )
    assert result_pages == pages
    assert len(stored_documents) == 1
    assert stored_documents[0][1] == {
        "pdf_sha256": result_hash,
        "pages": pages,
    }
    assert metric_results == ["miss"]


def test_request_context_reuses_cached_pages(
    monkeypatch,
):
    contents = b"same pdf"
    pages = [
        {
            "page_number": 1,
            "text": "Context-cached text",
        }
    ]

    def fail_extraction(_contents):
        raise AssertionError(
            "matching request context must skip extraction"
        )

    monkeypatch.setattr(
        main_redis,
        "extract_pdf_pages_without_redis",
        fail_extraction,
    )

    token = (
        main_redis._document_pages_context.set(
            (
                compute_pdf_sha256(contents),
                pages,
            )
        )
    )

    try:
        result = (
            main_redis.extract_pdf_pages_from_context(
                contents
            )
        )
    finally:
        main_redis._document_pages_context.reset(
            token
        )

    assert result == pages
