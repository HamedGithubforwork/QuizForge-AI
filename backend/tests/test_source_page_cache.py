import asyncio

import processed_documents
from redis_integration import (
    DOCUMENT_CACHE_TTL_SECONDS,
    build_document_cache_key_from_sha,
)
from source_page_cache import (
    build_source_page_key,
    build_source_page_manifest_key,
    get_cached_source_page,
    seed_source_page_cache,
)


DOCUMENT_SHA = "a" * 64
PAGES = [
    {
        "page_number": 1,
        "text": "Page one source text",
    },
    {
        "page_number": 2,
        "text": "Page two source text",
    },
]


class FakeSourcePageRedis:
    def __init__(self):
        self.values = {}
        self.expirations = {}
        self.get_calls = []
        self.exists_calls = []

    async def get(self, key):
        self.get_calls.append(key)
        return self.values.get(key)

    async def exists(self, key):
        self.exists_calls.append(key)
        return int(key in self.values)

    async def set(
        self,
        key,
        value,
        *,
        ex=None,
    ):
        self.values[key] = value
        self.expirations[key] = ex
        return True


def test_seeded_source_page_read_does_not_get_full_document():
    fake_redis = FakeSourcePageRedis()
    cache_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=DOCUMENT_SHA,
    )
    fake_redis.values[cache_key] = (
        "pretend this is the large full document JSON"
    )

    stored = asyncio.run(
        seed_source_page_cache(
            cache_key,
            PAGES,
            client=fake_redis,
        )
    )

    assert stored is True
    assert (
        fake_redis.expirations[
            build_source_page_manifest_key(
                cache_key
            )
        ]
        == DOCUMENT_CACHE_TTL_SECONDS
    )
    assert (
        fake_redis.expirations[
            build_source_page_key(
                cache_key,
                2,
            )
        ]
        == DOCUMENT_CACHE_TTL_SECONDS
    )

    fake_redis.get_calls.clear()
    fake_redis.exists_calls.clear()

    status, text = asyncio.run(
        get_cached_source_page(
            cache_key,
            2,
            client=fake_redis,
        )
    )

    assert status == "ok"
    assert text == PAGES[1]["text"]
    assert fake_redis.exists_calls == [
        cache_key
    ]
    assert cache_key not in fake_redis.get_calls
    assert fake_redis.get_calls == [
        build_source_page_manifest_key(
            cache_key
        ),
        build_source_page_key(
            cache_key,
            2,
        ),
    ]


def test_manifest_distinguishes_missing_page_from_missing_document():
    fake_redis = FakeSourcePageRedis()
    cache_key = build_document_cache_key_from_sha(
        user_id="user-1",
        pdf_sha256=DOCUMENT_SHA,
    )
    fake_redis.values[cache_key] = "document exists"

    asyncio.run(
        seed_source_page_cache(
            cache_key,
            PAGES,
            client=fake_redis,
        )
    )

    missing_page_status, _ = asyncio.run(
        get_cached_source_page(
            cache_key,
            99,
            client=fake_redis,
        )
    )

    other_user_key = (
        build_document_cache_key_from_sha(
            user_id="user-2",
            pdf_sha256=DOCUMENT_SHA,
        )
    )
    missing_document_status, _ = asyncio.run(
        get_cached_source_page(
            other_user_key,
            1,
            client=fake_redis,
        )
    )

    assert missing_page_status == "missing_page"
    assert (
        missing_document_status
        == "missing_document"
    )


def test_processed_document_read_seeds_source_pages(
    monkeypatch,
):
    seeded = []

    async def fake_get_cached_document(
        _cache_key,
    ):
        return {
            "pdf_sha256": DOCUMENT_SHA,
            "pages": PAGES,
        }

    async def fake_seed_source_page_cache(
        cache_key,
        pages,
    ):
        seeded.append(
            (cache_key, pages)
        )
        return True

    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_get_cached_document,
    )
    monkeypatch.setattr(
        processed_documents,
        "seed_source_page_cache",
        fake_seed_source_page_cache,
    )

    document = asyncio.run(
        processed_documents.get_processed_document(
            user_id="user-1",
            pdf_sha256=DOCUMENT_SHA,
        )
    )

    assert document == {
        "pdf_sha256": DOCUMENT_SHA,
        "pages": PAGES,
    }
    assert len(seeded) == 1
    assert seeded[0][1] == PAGES


def test_unseeded_legacy_document_falls_back_once_and_backfills(
    monkeypatch,
):
    seeded = []

    async def fake_get_cached_source_page(
        _cache_key,
        _page_number,
    ):
        return "unseeded", None

    async def fake_get_cached_document(
        _cache_key,
    ):
        return {
            "pdf_sha256": DOCUMENT_SHA,
            "pages": PAGES,
        }

    async def fake_seed_source_page_cache(
        cache_key,
        pages,
    ):
        seeded.append(
            (cache_key, pages)
        )
        return True

    monkeypatch.setattr(
        processed_documents,
        "get_cached_source_page",
        fake_get_cached_source_page,
    )
    monkeypatch.setattr(
        processed_documents,
        "get_cached_document",
        fake_get_cached_document,
    )
    monkeypatch.setattr(
        processed_documents,
        "seed_source_page_cache",
        fake_seed_source_page_cache,
    )

    status, text = asyncio.run(
        processed_documents.get_processed_page(
            user_id="user-1",
            pdf_sha256=DOCUMENT_SHA,
            page_number=2,
        )
    )

    assert status == "ok"
    assert text == PAGES[1]["text"]
    assert len(seeded) == 1
    assert seeded[0][1] == PAGES
