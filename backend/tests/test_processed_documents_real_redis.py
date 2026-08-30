import asyncio
import os

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError

import processed_documents
from processed_documents import (
    build_document_cache_key_from_sha,
    get_processed_document,
)
from redis_integration import (
    cache_document,
    compute_pdf_sha256,
    get_cached_document,
)


TEST_REDIS_URL = os.getenv(
    "TEST_REDIS_URL",
    "redis://127.0.0.1:6379/0",
)


async def make_client():
    client = Redis.from_url(
        TEST_REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
    )

    try:
        await client.ping()
    except RedisError:
        await client.aclose()
        return None

    return client


def test_real_redis_processed_document_is_user_scoped(
    monkeypatch,
):
    async def scenario():
        client = await make_client()

        if client is None:
            pytest.skip(
                "real Redis is unavailable"
            )

        try:
            await client.flushdb()

            pdf_sha256 = compute_pdf_sha256(
                b"processed pdf"
            )
            document = {
                "pdf_sha256": pdf_sha256,
                "pages": [
                    {
                        "page_number": 1,
                        "text": "Real Redis page",
                    }
                ],
            }

            owner_key = (
                build_document_cache_key_from_sha(
                    user_id="owner-user",
                    pdf_sha256=pdf_sha256,
                )
            )

            stored = await cache_document(
                owner_key,
                document,
                client=client,
            )
            assert stored is True

            async def real_get_cached_document(
                cache_key,
            ):
                return await get_cached_document(
                    cache_key,
                    client=client,
                )

            monkeypatch.setattr(
                processed_documents,
                "get_cached_document",
                real_get_cached_document,
            )
            processed_documents._memory_documents.clear()

            owner_result = (
                await get_processed_document(
                    user_id="owner-user",
                    pdf_sha256=pdf_sha256,
                )
            )
            other_result = (
                await get_processed_document(
                    user_id="other-user",
                    pdf_sha256=pdf_sha256,
                )
            )

            assert owner_result == document
            assert other_result is None
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
