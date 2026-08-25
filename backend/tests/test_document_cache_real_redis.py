import asyncio
import os

import main_redis
import redis_integration
from redis.asyncio import Redis

from redis_integration import build_document_cache_key


def test_real_redis_document_cache_miss_then_hit_skips_extraction(
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
            await client.flushdb()

            monkeypatch.setattr(
                redis_integration,
                "redis_client",
                client,
            )
            monkeypatch.setattr(
                main_redis,
                "redis_client",
                client,
            )

            extraction_calls = 0

            def fake_extract_pdf_pages(contents):
                nonlocal extraction_calls
                extraction_calls += 1

                return [
                    {
                        "page_number": 1,
                        "text": (
                            "Extracted once and then reused "
                            "from the real Redis cache."
                        ),
                    }
                ]

            monkeypatch.setattr(
                main_redis,
                "extract_pdf_pages_without_redis",
                fake_extract_pdf_pages,
            )

            contents = b"real redis document cache test pdf"
            user_id = "real-redis-test-user"

            first_hash, first_pages = (
                await main_redis.get_document_pages_with_cache(
                    user_id=user_id,
                    contents=contents,
                )
            )

            second_hash, second_pages = (
                await main_redis.get_document_pages_with_cache(
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
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
