import asyncio
from io import BytesIO

import main as base_app
import main_redis
from starlette.datastructures import Headers, UploadFile

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


def make_upload():
    return UploadFile(
        file=BytesIO(b"same pdf"),
        filename="notes.pdf",
        headers=Headers(
            {
                "content-type":
                    "application/pdf",
            }
        ),
    )


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


def test_normal_generation_can_return_cached_quiz(
    monkeypatch,
):
    cached_quiz = main_redis.Quiz(
        title="Cached quiz",
        questions=[],
    )
    metric_results = []

    async def fake_rate_limit(_user_id):
        return None

    async def fake_get_cached_quiz(
        _cache_key,
        _quiz_model,
    ):
        return cached_quiz

    async def fail_generation(**_kwargs):
        raise AssertionError(
            "cached generation should not call the AI generator"
        )

    async def fake_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        metric_results.append(
            (cache_result, failed)
        )

    monkeypatch.setattr(
        main_redis,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        main_redis,
        "get_cached_quiz",
        fake_get_cached_quiz,
    )
    monkeypatch.setattr(
        main_redis,
        "generate_quiz_without_redis",
        fail_generation,
    )
    monkeypatch.setattr(
        main_redis,
        "record_quiz_metrics",
        fake_metrics,
    )

    result = asyncio.run(
        main_redis.generate_quiz(
            file=make_upload(),
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=False,
            current_user=(
                main_redis.AuthenticatedUser(
                    id="test-user"
                )
            ),
        )
    )

    assert result.title == "Cached quiz"
    assert metric_results == [("hit", False)]


def test_generate_new_quiz_instead_of_using_cache_bypasses_cache(
    monkeypatch,
):
    generated_quiz = main_redis.Quiz(
        title="Fresh quiz",
        questions=[],
    )
    calls = {
        "cache_reads": 0,
        "generation": 0,
        "cache_writes": 0,
    }
    metric_results = []

    async def fake_rate_limit(_user_id):
        return None

    async def fail_cache_read(
        _cache_key,
        _quiz_model,
    ):
        calls["cache_reads"] += 1
        raise AssertionError(
            "new quiz generation must bypass the cached quiz lookup"
        )

    async def fake_document_pages(
        user_id,
        contents,
    ):
        assert user_id == "test-user"
        assert contents == b"same pdf"
        return (
            "test-document-hash",
            [
                {
                    "page_number": 1,
                    "text": "Test document text",
                }
            ],
        )

    async def fake_generation(**_kwargs):
        calls["generation"] += 1
        return generated_quiz

    async def fake_cache_quiz(
        _cache_key,
        quiz,
    ):
        calls["cache_writes"] += 1
        assert quiz is generated_quiz

    async def fake_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        metric_results.append(
            (cache_result, failed)
        )

    monkeypatch.setattr(
        main_redis,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        main_redis,
        "get_cached_quiz",
        fail_cache_read,
    )
    monkeypatch.setattr(
        main_redis,
        "get_document_pages_with_cache",
        fake_document_pages,
    )
    monkeypatch.setattr(
        main_redis,
        "generate_quiz_without_redis",
        fake_generation,
    )
    monkeypatch.setattr(
        main_redis,
        "cache_quiz",
        fake_cache_quiz,
    )
    monkeypatch.setattr(
        main_redis,
        "record_quiz_metrics",
        fake_metrics,
    )

    result = asyncio.run(
        main_redis.generate_quiz(
            file=make_upload(),
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=True,
            current_user=(
                main_redis.AuthenticatedUser(
                    id="test-user"
                )
            ),
        )
    )

    assert result.title == "Fresh quiz"
    assert calls == {
        "cache_reads": 0,
        "generation": 1,
        "cache_writes": 1,
    }
    assert metric_results == [
        ("bypass", False)
    ]
