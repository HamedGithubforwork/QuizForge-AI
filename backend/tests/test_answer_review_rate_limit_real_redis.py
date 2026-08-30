import asyncio
import os

import pytest
from fastapi import HTTPException
from redis.asyncio import Redis

import redis_integration
from redis_integration import (
    enforce_answer_review_rate_limit,
)


def test_answer_review_rate_limit_with_real_redis(
    monkeypatch,
):
    redis_url = os.environ.get(
        "TEST_REDIS_URL",
        "redis://127.0.0.1:6379/0",
    )

    monkeypatch.setattr(
        redis_integration,
        "ANSWER_REVIEW_RATE_LIMIT",
        2,
    )
    monkeypatch.setattr(
        redis_integration,
        "ANSWER_REVIEW_RATE_WINDOW_SECONDS",
        60,
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

            user_id = "answer-review-real-redis-user"
            key = (
                "quizforge:rate:answer-review:"
                f"{user_id}"
            )

            await enforce_answer_review_rate_limit(
                user_id,
                client=client,
            )
            await enforce_answer_review_rate_limit(
                user_id,
                client=client,
            )

            with pytest.raises(
                HTTPException,
            ) as error:
                await enforce_answer_review_rate_limit(
                    user_id,
                    client=client,
                )

            assert error.value.status_code == 429
            assert error.value.detail == (
                "Too many semantic answer review requests. "
                "Please wait before trying again."
            )

            retry_after = int(
                error.value.headers[
                    "Retry-After"
                ]
            )
            assert 1 <= retry_after <= 60

            assert await client.get(key) == "3"

            ttl = await client.ttl(key)
            assert 1 <= ttl <= 60

            assert await client.exists(
                f"quizforge:rate:{user_id}"
            ) == 0
        finally:
            await client.flushdb()
            await client.aclose()

    asyncio.run(scenario())
