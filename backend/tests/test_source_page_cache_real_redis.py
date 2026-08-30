import asyncio
import os

from redis.asyncio import Redis

from source_page_cache import (
    build_source_page_key,
    build_source_page_manifest_key,
    get_cached_source_page,
    seed_source_page_cache,
)


PAGES = [
    {
        "page_number": 1,
        "text": "Real Redis source page one",
    },
    {
        "page_number": 2,
        "text": "Real Redis source page two",
    },
]


def test_real_redis_source_page_pipeline_round_trip():
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
        document_cache_key = (
            "quizforge:document-cache:"
            "real-source-page-test"
        )

        try:
            await client.flushdb()
            await client.set(
                document_cache_key,
                "full document placeholder",
                ex=60,
            )

            stored = await seed_source_page_cache(
                document_cache_key,
                PAGES,
                client=client,
            )

            status, text = (
                await get_cached_source_page(
                    document_cache_key,
                    2,
                    client=client,
                )
            )

            assert stored is True
            assert status == "ok"
            assert text == PAGES[1]["text"]
            assert await client.exists(
                build_source_page_manifest_key(
                    document_cache_key
                )
            ) == 1
            assert await client.exists(
                build_source_page_key(
                    document_cache_key,
                    2,
                )
            ) == 1
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
