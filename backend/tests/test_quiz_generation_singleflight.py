import asyncio
from io import BytesIO

from redis.exceptions import RedisError
from starlette.datastructures import Headers, UploadFile

import main_redis
import redis_integration


class MemoryRedis:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(
        self,
        key,
        value,
        *,
        ex=None,
        nx=False,
    ):
        del ex

        if nx and key in self.values:
            return None

        self.values[key] = value
        return True

    async def eval(
        self,
        _script,
        _key_count,
        key,
        token,
    ):
        if self.values.get(key) != token:
            return 0

        self.values.pop(key, None)
        return 1


class BrokenRedis:
    async def get(self, _key):
        raise RedisError("Redis unavailable")

    async def set(self, *_args, **_kwargs):
        raise RedisError("Redis unavailable")

    async def eval(self, *_args, **_kwargs):
        raise RedisError("Redis unavailable")


def make_upload():
    return UploadFile(
        file=BytesIO(b"same pdf"),
        filename="notes.pdf",
        headers=Headers(
            {
                "content-type": "application/pdf",
            }
        ),
    )


def patch_common_dependencies(
    monkeypatch,
    fake_redis,
    generation,
    metric_results,
):
    async def fake_rate_limit(_user_id):
        return None

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

    async def fake_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        assert duration_ms >= 0
        metric_results.append(
            (cache_result, failed)
        )

    monkeypatch.setattr(
        redis_integration,
        "redis_client",
        fake_redis,
    )
    monkeypatch.setattr(
        main_redis,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        main_redis,
        "get_document_pages_with_cache",
        fake_document_pages,
    )
    monkeypatch.setattr(
        main_redis,
        "generate_quiz_from_pages",
        generation,
    )
    monkeypatch.setattr(
        main_redis,
        "record_quiz_metrics",
        fake_metrics,
    )
    monkeypatch.setattr(
        main_redis,
        "QUIZ_GENERATION_POLL_INTERVAL_SECONDS",
        0.005,
    )
    monkeypatch.setattr(
        main_redis,
        "QUIZ_GENERATION_WAIT_SECONDS",
        1,
    )


async def call_generate(*, bypass=False):
    return await main_redis.generate_quiz(
        file=make_upload(),
        document_sha256="",
        question_count=5,
        difficulty="medium",
        question_type="multiple_choice",
        focus_pages="",
        focus_question_types="",
        avoid_questions="[]",
        generate_new_quiz_instead_of_using_cache=bypass,
        current_user=(
            main_redis.AuthenticatedUser(
                id="test-user"
            )
        ),
    )


def test_identical_concurrent_requests_generate_only_once(
    monkeypatch,
):
    fake_redis = MemoryRedis()
    generation_calls = 0
    metric_results = []

    async def fake_generation(**_kwargs):
        nonlocal generation_calls
        generation_calls += 1
        await asyncio.sleep(0.05)
        return main_redis.Quiz(
            title="Generated once",
            questions=[],
        )

    patch_common_dependencies(
        monkeypatch,
        fake_redis,
        fake_generation,
        metric_results,
    )

    async def scenario():
        return await asyncio.gather(
            call_generate(),
            call_generate(),
        )

    results = asyncio.run(scenario())

    assert generation_calls == 1
    assert [result.title for result in results] == [
        "Generated once",
        "Generated once",
    ]
    assert sorted(metric_results) == [
        ("hit", False),
        ("miss", False),
    ]


def test_generate_new_requests_are_serialized_but_stay_fresh(
    monkeypatch,
):
    fake_redis = MemoryRedis()
    generation_calls = 0
    active_generations = 0
    max_active_generations = 0
    metric_results = []

    async def fake_generation(**_kwargs):
        nonlocal generation_calls
        nonlocal active_generations
        nonlocal max_active_generations

        generation_calls += 1
        generation_number = generation_calls
        active_generations += 1
        max_active_generations = max(
            max_active_generations,
            active_generations,
        )

        try:
            await asyncio.sleep(0.03)
        finally:
            active_generations -= 1

        return main_redis.Quiz(
            title=f"Fresh quiz {generation_number}",
            questions=[],
        )

    patch_common_dependencies(
        monkeypatch,
        fake_redis,
        fake_generation,
        metric_results,
    )

    async def scenario():
        return await asyncio.gather(
            call_generate(bypass=True),
            call_generate(bypass=True),
        )

    results = asyncio.run(scenario())

    assert generation_calls == 2
    assert max_active_generations == 1
    assert {result.title for result in results} == {
        "Fresh quiz 1",
        "Fresh quiz 2",
    }
    assert metric_results == [
        ("bypass", False),
        ("bypass", False),
    ]


def test_redis_lock_failure_falls_back_to_generation(
    monkeypatch,
):
    generation_calls = 0
    metric_results = []

    async def fake_generation(**_kwargs):
        nonlocal generation_calls
        generation_calls += 1
        return main_redis.Quiz(
            title="Fallback quiz",
            questions=[],
        )

    patch_common_dependencies(
        monkeypatch,
        BrokenRedis(),
        fake_generation,
        metric_results,
    )

    result = asyncio.run(
        call_generate()
    )

    assert result.title == "Fallback quiz"
    assert generation_calls == 1
    assert metric_results == [
        ("miss", False)
    ]
