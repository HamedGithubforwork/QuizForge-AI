import asyncio
import os

from redis.asyncio import Redis

import redis_integration
from redis_integration import (
    build_quiz_generation_lock_key,
    release_quiz_generation_lock,
    try_acquire_quiz_generation_lock,
)


def test_quiz_generation_lock_with_real_redis():
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

            cache_key = (
                "quizforge:quiz-cache:"
                "singleflight-real-redis"
            )
            lock_key = build_quiz_generation_lock_key(
                cache_key
            )

            attempts = await asyncio.gather(
                *[
                    try_acquire_quiz_generation_lock(
                        cache_key,
                        client=client,
                    )
                    for _ in range(5)
                ]
            )

            acquired = [
                attempt
                for attempt in attempts
                if attempt.acquired
            ]

            assert len(acquired) == 1
            assert all(
                attempt.backend_available
                for attempt in attempts
            )

            token = acquired[0].token
            assert token
            assert await client.get(lock_key) == token

            ttl = await client.ttl(lock_key)
            assert 1 <= ttl <= (
                redis_integration
                .QUIZ_GENERATION_LOCK_TTL_SECONDS
            )

            released_wrong_token = (
                await release_quiz_generation_lock(
                    cache_key,
                    "not-the-owner",
                    client=client,
                )
            )
            assert released_wrong_token is False
            assert await client.get(lock_key) == token

            released = await release_quiz_generation_lock(
                cache_key,
                token,
                client=client,
            )
            assert released is True
            assert await client.exists(lock_key) == 0

            reacquired = (
                await try_acquire_quiz_generation_lock(
                    cache_key,
                    client=client,
                )
            )
            assert reacquired.acquired is True
            assert reacquired.token
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
