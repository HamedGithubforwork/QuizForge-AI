import asyncio

import pytest

import generation_usage
import observability
import application


class FakePipeline:
    def __init__(self, values):
        self.values = values

    def incrby(self, key, amount):
        self.values[key] = self.values.get(key, 0) + amount
        return self

    async def execute(self):
        return []


class FakeRedis:
    def __init__(self):
        self.values = {}

    def pipeline(self, transaction=False):
        assert transaction is False
        return FakePipeline(self.values)


def test_local_generation_event_records_only_bounded_kinds():
    client = FakeRedis()

    asyncio.run(
        generation_usage.record_local_generation_event(
            client,
            generation_usage.LocalGenerationEvent(
                kind="quiz"
            ),
        )
    )
    asyncio.run(
        generation_usage.record_local_generation_event(
            client,
            generation_usage.LocalGenerationEvent(
                kind="targeted_practice"
            ),
        )
    )

    assert client.values[
        f"{observability.METRIC_PREFIX}local_quiz_generations_total"
    ] == 1
    assert client.values[
        f"{observability.METRIC_PREFIX}local_targeted_practice_generations_total"
    ] == 1


def test_local_generation_event_rejects_arbitrary_payload():
    with pytest.raises(Exception):
        generation_usage.LocalGenerationEvent(
            kind="arbitrary"
        )


def test_generation_provider_metric_rejects_unknown_dimensions():
    with pytest.raises(ValueError):
        asyncio.run(
            observability.record_generation_provider_metric(
                None,
                provider="local",
                event="raw_prompt",
            )
        )


def test_local_usage_route_records_authenticated_event(monkeypatch):
    recorded = []

    async def fake_record(_client, event):
        recorded.append(event.kind)

    monkeypatch.setattr(
        application,
        "record_local_generation_event",
        fake_record,
    )

    result = asyncio.run(
        application.record_local_generation_usage(
            generation_usage.LocalGenerationEvent(
                kind="quiz"
            ),
            application.AuthenticatedUser(
                id="user-1"
            ),
        )
    )

    assert result is None
    assert recorded == ["quiz"]


def test_cloud_metrics_distinguish_request_from_actual_model_call(monkeypatch):
    events = []

    async def fake_provider_metric(
        _client,
        *,
        provider,
        event,
    ):
        events.append((provider, event))

    async def fake_rate_limit(_user_id):
        return None

    async def fake_cached_quiz(
        _cache_key,
        _model,
    ):
        return application.Quiz(
            title="Cached",
            questions=[],
        )

    async def fake_quiz_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        assert duration_ms >= 0
        assert cache_result == "hit"
        assert failed is False

    monkeypatch.setattr(
        application,
        "record_generation_provider_metric",
        fake_provider_metric,
    )
    monkeypatch.setattr(
        application,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        application,
        "get_cached_quiz",
        fake_cached_quiz,
    )
    monkeypatch.setattr(
        application,
        "record_quiz_metrics",
        fake_quiz_metrics,
    )

    result = asyncio.run(
        application.generate_quiz(
            file=None,
            document_sha256="a" * 64,
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=False,
            current_user=application.AuthenticatedUser(
                id="user-1"
            ),
        )
    )

    assert result.title == "Cached"
    assert events == [
        ("cloud", "request"),
    ]


def test_cloud_model_call_metric_records_only_after_cache_miss(monkeypatch):
    events = []

    async def fake_provider_metric(
        _client,
        *,
        provider,
        event,
    ):
        events.append((provider, event))

    async def fake_rate_limit(_user_id):
        return None

    async def no_cached_quiz(
        _cache_key,
        _model,
    ):
        return None

    async def fake_turn(
        _cache_key,
        *,
        use_cached_result,
    ):
        assert use_cached_result is True
        return None, None

    async def fake_pages(
        *,
        user_id,
        pdf_sha256,
        contents,
    ):
        assert user_id == "user-1"
        assert contents is None
        return [
            {
                "page_number": 1,
                "text": "Enough synthetic study material.",
            }
        ]

    async def fake_generation(**kwargs):
        await kwargs["on_model_call"]()
        return application.Quiz(
            title="Generated",
            questions=[],
        )

    async def fake_cache(
        _cache_key,
        _quiz,
    ):
        return None

    async def fake_quiz_metrics(
        _client,
        *,
        cache_result,
        duration_ms,
        failed=False,
    ):
        assert duration_ms >= 0
        assert cache_result == "miss"
        assert failed is False

    monkeypatch.setattr(
        application,
        "record_generation_provider_metric",
        fake_provider_metric,
    )
    monkeypatch.setattr(
        application,
        "enforce_quiz_rate_limit",
        fake_rate_limit,
    )
    monkeypatch.setattr(
        application,
        "get_cached_quiz",
        no_cached_quiz,
    )
    monkeypatch.setattr(
        application,
        "acquire_quiz_generation_turn",
        fake_turn,
    )
    monkeypatch.setattr(
        application,
        "get_generation_pages",
        fake_pages,
    )
    monkeypatch.setattr(
        application,
        "generate_quiz_from_pages",
        fake_generation,
    )
    monkeypatch.setattr(
        application,
        "cache_quiz",
        fake_cache,
    )
    monkeypatch.setattr(
        application,
        "record_quiz_metrics",
        fake_quiz_metrics,
    )

    result = asyncio.run(
        application.generate_quiz(
            file=None,
            document_sha256="a" * 64,
            question_count=5,
            difficulty="medium",
            question_type="multiple_choice",
            focus_pages="",
            focus_question_types="",
            avoid_questions="[]",
            generate_new_quiz_instead_of_using_cache=False,
            current_user=application.AuthenticatedUser(
                id="user-1"
            ),
        )
    )

    assert result.title == "Generated"
    assert events == [
        ("cloud", "request"),
        ("cloud", "model_call"),
    ]
