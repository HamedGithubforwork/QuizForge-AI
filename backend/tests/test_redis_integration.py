import asyncio

import main as base_app
import main_redis  # noqa: F401
from redis_integration import (
    build_quiz_cache_key,
    enforce_quiz_rate_limit,
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


def test_quiz_cache_key_is_stable():
    first = build_quiz_cache_key(
        user_id="user-1",
        contents=b"same pdf",
        question_count=5,
        difficulty="Medium",
        question_type="mixed",
        focus_pages="1,2",
        focus_question_types="short_answer",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    second = build_quiz_cache_key(
        user_id="user-1",
        contents=b"same pdf",
        question_count=5,
        difficulty="medium",
        question_type="mixed",
        focus_pages="1,2",
        focus_question_types="short_answer",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    assert first == second


def test_quiz_cache_key_changes_with_pdf():
    first = build_quiz_cache_key(
        user_id="user-1",
        contents=b"pdf one",
        question_count=5,
        difficulty="medium",
        question_type="mixed",
        focus_pages="",
        focus_question_types="",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    second = build_quiz_cache_key(
        user_id="user-1",
        contents=b"pdf two",
        question_count=5,
        difficulty="medium",
        question_type="mixed",
        focus_pages="",
        focus_question_types="",
        avoid_questions="[]",
        content_type="application/pdf",
    )

    assert first != second


def test_rate_limit_uses_redis_key():
    fake_redis = FakeRedis()

    asyncio.run(
        enforce_quiz_rate_limit(
            "test-user",
            client=fake_redis,
        )
    )

    assert len(fake_redis.eval_calls) == 1

    _, key_count, key, _ = (
        fake_redis.eval_calls[0]
    )

    assert key_count == 1
    assert key == "quizforge:rate:test-user"


def test_redis_entrypoint_disables_legacy_rate_limiter():
    base_app._generation_requests.clear()

    for _ in range(base_app.QUIZ_RATE_LIMIT + 1):
        base_app.enforce_quiz_rate_limit(
            "test-user",
        )

    assert not base_app._generation_requests
