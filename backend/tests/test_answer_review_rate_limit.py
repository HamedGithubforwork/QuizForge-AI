import asyncio

import pytest
from fastapi import HTTPException
from redis.exceptions import RedisError

import redis_integration
from redis_integration import (
    enforce_answer_review_rate_limit,
)


class FakeRedis:
    def __init__(self):
        self.eval_calls = []

    async def eval(
        self,
        script,
        key_count,
        key,
        window_seconds,
    ):
        self.eval_calls.append(
            (
                script,
                key_count,
                key,
                window_seconds,
            )
        )
        return [1, window_seconds]


class BrokenRedis:
    async def eval(
        self,
        _script,
        _key_count,
        _key,
        _window_seconds,
    ):
        raise RedisError(
            "Redis unavailable"
        )


def test_answer_review_rate_limit_uses_separate_redis_key():
    fake_redis = FakeRedis()

    asyncio.run(
        enforce_answer_review_rate_limit(
            "test-user",
            client=fake_redis,
        )
    )

    assert len(fake_redis.eval_calls) == 1

    _, key_count, key, window_seconds = (
        fake_redis.eval_calls[0]
    )

    assert key_count == 1
    assert key == (
        "quizforge:rate:answer-review:"
        "test-user"
    )
    assert window_seconds == (
        redis_integration
        .ANSWER_REVIEW_RATE_WINDOW_SECONDS
    )


def test_answer_review_redis_failure_falls_back_to_memory(
    monkeypatch,
):
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

    redis_integration._memory_answer_review_requests.clear()

    async def scenario():
        await enforce_answer_review_rate_limit(
            "fallback-user",
            client=BrokenRedis(),
        )
        await enforce_answer_review_rate_limit(
            "fallback-user",
            client=BrokenRedis(),
        )

        with pytest.raises(
            HTTPException,
        ) as error:
            await enforce_answer_review_rate_limit(
                "fallback-user",
                client=BrokenRedis(),
            )

        assert error.value.status_code == 429
        assert error.value.detail == (
            "Too many semantic answer review requests. "
            "Please wait before trying again."
        )
        assert int(
            error.value.headers[
                "Retry-After"
            ]
        ) >= 1

    try:
        asyncio.run(scenario())
    finally:
        redis_integration._memory_answer_review_requests.clear()


def test_answer_review_fallback_is_independent_from_quiz_fallback(
    monkeypatch,
):
    monkeypatch.setattr(
        redis_integration,
        "ANSWER_REVIEW_RATE_LIMIT",
        1,
    )
    monkeypatch.setattr(
        redis_integration,
        "QUIZ_RATE_LIMIT",
        1,
    )

    redis_integration._memory_answer_review_requests.clear()
    redis_integration._memory_generation_requests.clear()

    async def scenario():
        await enforce_answer_review_rate_limit(
            "same-user",
            client=BrokenRedis(),
        )
        await redis_integration.enforce_quiz_rate_limit(
            "same-user",
            client=BrokenRedis(),
        )

    try:
        asyncio.run(scenario())
    finally:
        redis_integration._memory_answer_review_requests.clear()
        redis_integration._memory_generation_requests.clear()
