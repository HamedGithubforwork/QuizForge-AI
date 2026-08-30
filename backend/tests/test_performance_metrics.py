import asyncio

import app_shared
import main
import main_redis
import quiz_service


class FakeAuthResponse:
    status_code = 200

    def json(self):
        return {
            "id": "performance-user",
            "email": "performance@example.com",
        }


class FakeAuthClient:
    async def get(self, *_args, **_kwargs):
        return FakeAuthResponse()


def test_canonical_app_has_expected_phase_timers():
    expected = {
        "get_cached_document": (
            "document_cache_lookup_latency_ms"
        ),
        "cache_document": (
            "document_cache_write_latency_ms"
        ),
        "extract_pdf_pages_off_event_loop": (
            "pdf_extraction_latency_ms"
        ),
        "get_cached_quiz": (
            "quiz_cache_lookup_latency_ms"
        ),
        "cache_quiz": (
            "quiz_cache_write_latency_ms"
        ),
    }

    for function_name, timing_name in expected.items():
        function = getattr(
            main_redis,
            function_name,
        )
        assert getattr(
            function,
            "_quizforge_timing_name",
            None,
        ) == timing_name

    assert main.app is main_redis.app


def test_quiz_generation_instrumentation_wraps_openai_and_validation():
    assert hasattr(
        quiz_service.get_openai_client,
        "__wrapped__",
    )
    assert hasattr(
        quiz_service.get_quiz_validation_errors,
        "__wrapped__",
    )
    assert (
        main_redis.generate_quiz_from_pages
        is quiz_service.generate_quiz_from_pages
    )


def test_authentication_records_timing_after_supabase_lookup(
    monkeypatch,
):
    recorded = []

    async def fake_get_http_client():
        return FakeAuthClient()

    async def fake_record_auth_timing(started_at):
        recorded.append(started_at)

    monkeypatch.setattr(
        app_shared,
        "SUPABASE_URL",
        "https://example.supabase.co",
    )
    monkeypatch.setattr(
        app_shared,
        "SUPABASE_PUBLISHABLE_KEY",
        "test-key",
    )
    monkeypatch.setattr(
        app_shared,
        "get_http_client",
        fake_get_http_client,
    )
    monkeypatch.setattr(
        app_shared,
        "_record_auth_timing",
        fake_record_auth_timing,
    )

    user = asyncio.run(
        app_shared.get_current_user(
            "Bearer test-token"
        )
    )

    assert user.id == "performance-user"
    assert len(recorded) == 1
    assert isinstance(recorded[0], float)
