import asyncio
from types import SimpleNamespace

import app_shared
import application
import main
import performance_metrics
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
            application,
            function_name,
        )
        assert getattr(
            function,
            "_quizforge_timing_name",
            None,
        ) == timing_name

    assert main.app is application.app


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
        application.generate_quiz_from_pages
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


def test_quiz_generation_batches_each_contexts_validation_samples(
    monkeypatch,
):
    recorded_batches = []

    def fake_validator(*_args, **_kwargs):
        return []

    async def fake_generate(label, validation_count):
        for _ in range(validation_count):
            quiz_service.get_quiz_validation_errors()
            await asyncio.sleep(0)
        return label

    async def capture_timing_batch(timing_name, durations_ms):
        recorded_batches.append((timing_name, list(durations_ms)))

    monkeypatch.setattr(quiz_service, "get_quiz_validation_errors", fake_validator)
    monkeypatch.setattr(quiz_service, "generate_quiz_from_pages", fake_generate)
    monkeypatch.setattr(performance_metrics, "_quiz_service_installed", False)
    monkeypatch.setattr(performance_metrics, "_record_timings", capture_timing_batch)
    instrumented_application = SimpleNamespace()
    performance_metrics._install_quiz_service_instrumentation(
        instrumented_application
    )

    async def run_generations():
        return await asyncio.gather(
            instrumented_application.generate_quiz_from_pages("single", 1),
            instrumented_application.generate_quiz_from_pages("retry", 2),
        )

    assert asyncio.run(run_generations()) == ["single", "retry"]
    assert len(recorded_batches) == 2
    assert all(name == "quiz_validation_latency_ms" for name, _ in recorded_batches)
    assert sorted(len(samples) for _, samples in recorded_batches) == [1, 2]
    assert all(duration >= 0 for _, samples in recorded_batches for duration in samples)

