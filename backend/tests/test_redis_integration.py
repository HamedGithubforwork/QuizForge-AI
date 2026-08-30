import asyncio
from io import BytesIO

import application
import main
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


def test_canonical_application_uses_shared_rate_limiter():
    assert (
        application.enforce_quiz_rate_limit
        is enforce_quiz_rate_limit
    )
    assert main.app is application.app


def test_normal_generation_can_return_cached_quiz(
    monkeypatch,
):
    cached_quiz = application.Quiz(
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
        application,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        application,
        "get_cached_quiz",
        fake_get_cached_quiz,
    )
    monkeypatch.setattr(
        application,
        "generate_quiz_from_pages",
        fail_generation,
    )
    monkeypatch.setattr(
        application,
        "record_quiz_metrics",
        fake_metrics,
    )

    result = asyncio.run(
        application.generate_quiz(
            file=make_upload(),
            document_sha256="",
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=False,
            current_user=(
                application.AuthenticatedUser(
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
    generated_quiz = application.Quiz(
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
        pdf_sha256=None,
    ):
        assert user_id == "test-user"
        assert contents == b"same pdf"
        assert pdf_sha256 is not None
        return (
            pdf_sha256,
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
        application,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        application,
        "get_cached_quiz",
        fail_cache_read,
    )
    monkeypatch.setattr(
        application,
        "get_document_pages_with_cache",
        fake_document_pages,
    )
    monkeypatch.setattr(
        application,
        "generate_quiz_from_pages",
        fake_generation,
    )
    monkeypatch.setattr(
        application,
        "cache_quiz",
        fake_cache_quiz,
    )
    monkeypatch.setattr(
        application,
        "record_quiz_metrics",
        fake_metrics,
    )

    result = asyncio.run(
        application.generate_quiz(
            file=make_upload(),
            document_sha256="",
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=True,
            current_user=(
                application.AuthenticatedUser(
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
