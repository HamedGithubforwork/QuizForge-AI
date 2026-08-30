import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import application
from redis_integration import QuizGenerationLockAttempt


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now


def test_poll_delay_uses_bounded_downward_jitter(
    monkeypatch,
):
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_POLL_MAX_INTERVAL_SECONDS",
        1.0,
    )
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_POLL_JITTER_RATIO",
        0.2,
    )

    bounds = []

    def choose_floor(low, high):
        bounds.append((low, high))
        return low

    monkeypatch.setattr(
        application.random,
        "uniform",
        choose_floor,
    )

    delay = application.get_quiz_generation_poll_delay(
        2.0
    )

    assert delay == pytest.approx(0.8)
    assert bounds == [
        (pytest.approx(0.8), pytest.approx(1.0))
    ]


def test_waiter_backoff_caps_polling_and_preserves_timeout(
    monkeypatch,
):
    clock = FakeClock()
    sleep_calls = []
    lock_attempts = 0

    async def fake_sleep(delay):
        sleep_calls.append(delay)
        clock.now += delay

    async def always_locked(_cache_key):
        nonlocal lock_attempts
        lock_attempts += 1
        return QuizGenerationLockAttempt(
            backend_available=True,
            acquired=False,
        )

    monkeypatch.setattr(
        application,
        "time",
        clock,
    )
    monkeypatch.setattr(
        application,
        "asyncio",
        SimpleNamespace(sleep=fake_sleep),
    )
    monkeypatch.setattr(
        application,
        "try_acquire_quiz_generation_lock",
        always_locked,
    )
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_WAIT_SECONDS",
        2.0,
    )
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_POLL_INTERVAL_SECONDS",
        0.1,
    )
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_POLL_MAX_INTERVAL_SECONDS",
        0.4,
    )
    monkeypatch.setattr(
        application,
        "QUIZ_GENERATION_POLL_JITTER_RATIO",
        0.0,
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            application.acquire_quiz_generation_turn(
                "quiz-cache-key",
                use_cached_result=False,
            )
        )

    assert error.value.status_code == 503
    assert error.value.headers == {
        "Retry-After": "2",
    }
    assert clock.now == pytest.approx(2.0)
    assert sleep_calls[:3] == pytest.approx(
        [0.1, 0.2, 0.4]
    )
    assert max(sleep_calls) <= 0.4
    assert lock_attempts < 10
