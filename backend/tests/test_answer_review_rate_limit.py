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


def test_answer_review_fallback_sweeps_expired_buckets_without_removing_active_users(
    monkeypatch,
):
    now = [0.0]
    monkeypatch.setattr(
        redis_integration.time,
        "monotonic",
        lambda: now[0],
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

    request_store = redis_integration._memory_answer_review_requests
    request_store.clear()
    redis_integration._memory_rate_limit_sweep_counts[
        "answer_review"
    ] = 0

    async def scenario():
        for index in range(100):
            await enforce_answer_review_rate_limit(
                f"one-off-{index}",
                client=BrokenRedis(),
            )

        assert len(request_store) == 100

        now[0] = 61.0
        await enforce_answer_review_rate_limit(
            "active-user",
            client=BrokenRedis(),
        )
        await enforce_answer_review_rate_limit(
            "active-user",
            client=BrokenRedis(),
        )

        for index in range(26):
            await enforce_answer_review_rate_limit(
                f"current-{index}",
                client=BrokenRedis(),
            )

        # The sweep runs on fallback admission 128, not on every request.
        assert len(request_store) == 27
        assert "active-user" in request_store
        assert all(
            f"one-off-{index}" not in request_store
            for index in range(100)
        )

        with pytest.raises(HTTPException) as error:
            await enforce_answer_review_rate_limit(
                "active-user",
                client=BrokenRedis(),
            )

        assert error.value.status_code == 429

    try:
        asyncio.run(scenario())
    finally:
        request_store.clear()
        redis_integration._memory_rate_limit_sweep_counts[
            "answer_review"
        ] = 0

