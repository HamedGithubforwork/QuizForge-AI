import asyncio
import os

import pymupdf
from redis.asyncio import Redis

import application
import redis_integration
from observability import METRIC_PREFIX
from redis_integration import build_document_cache_key


PAGE_ONE_TEXT = (
    "QuizForge real PyMuPDF Redis integration page one."
)
PAGE_TWO_TEXT = (
    "Page two proves multi-page extraction survives the cache."
)


def make_real_pdf_bytes() -> bytes:
    document = pymupdf.open()

    try:
        first_page = document.new_page()
        first_page.insert_text(
            (72, 72),
            PAGE_ONE_TEXT,
        )

        second_page = document.new_page()
        second_page.insert_text(
            (72, 72),
            PAGE_TWO_TEXT,
        )

        return document.tobytes()
    finally:
        document.close()


def test_real_pdf_pymupdf_then_real_redis_hit_skips_second_extraction(
    monkeypatch,
):
    redis_url = os.environ.get(
        "TEST_REDIS_URL",
        "redis://127.0.0.1:6379/0",
    )

    async def scenario():
        client = Redis.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=True,
        )

        try:
            # TEST_REDIS_URL points at the disposable Redis service used by
            # this test/CI job. Never point this test at a valued Redis DB.
            await client.flushdb()

            monkeypatch.setattr(
                redis_integration,
                "redis_client",
                client,
            )
            monkeypatch.setattr(
                application,
                "redis_client",
                client,
            )

            real_extract_pdf_pages = (
                application.extract_pdf_pages_off_event_loop
            )
            extraction_calls = 0

            async def counting_real_extract_pdf_pages(contents):
                nonlocal extraction_calls
                extraction_calls += 1
                return await real_extract_pdf_pages(
                    contents
                )

            monkeypatch.setattr(
                application,
                "extract_pdf_pages_off_event_loop",
                counting_real_extract_pdf_pages,
            )

            contents = make_real_pdf_bytes()
            user_id = "real-pdf-redis-test-user"

            first_hash, first_pages = (
                await application.get_document_pages_with_cache(
                    user_id=user_id,
                    contents=contents,
                )
            )

            assert extraction_calls == 1
            assert len(first_pages) == 2
            assert [
                page["page_number"]
                for page in first_pages
            ] == [1, 2]
            assert PAGE_ONE_TEXT in first_pages[0]["text"]
            assert PAGE_TWO_TEXT in first_pages[1]["text"]

            second_hash, second_pages = (
                await application.get_document_pages_with_cache(
                    user_id=user_id,
                    contents=contents,
                )
            )

            cache_key = build_document_cache_key(
                user_id=user_id,
                contents=contents,
            )

            assert first_hash == second_hash
            assert first_pages == second_pages
            assert extraction_calls == 1
            assert await client.exists(cache_key) == 1

            ttl = await client.ttl(cache_key)
            assert ttl > 0
            assert (
                ttl
                <= redis_integration.DOCUMENT_CACHE_TTL_SECONDS
            )

            document_cache_misses = int(
                await client.get(
                    f"{METRIC_PREFIX}document_cache_misses_total"
                )
                or 0
            )
            document_cache_hits = int(
                await client.get(
                    f"{METRIC_PREFIX}document_cache_hits_total"
                )
                or 0
            )

            assert document_cache_misses == 1
            assert document_cache_hits == 1
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
