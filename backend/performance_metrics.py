import contextvars
import functools
import time

from observability import (
    elapsed_ms,
    record_timing_sample,
)


_validation_timings: contextvars.ContextVar[
    list[float] | None
] = contextvars.ContextVar(
    "quizforge_validation_timings",
    default=None,
)
_quiz_service_installed = False


async def _record_timing(
    timing_name: str,
    duration_ms: float,
):
    from redis_integration import redis_client

    await record_timing_sample(
        redis_client,
        timing_name,
        duration_ms,
    )


def _timed_async_function(
    function,
    timing_name: str,
):
    @functools.wraps(function)
    async def wrapper(*args, **kwargs):
        started_at = time.perf_counter()

        try:
            return await function(
                *args,
                **kwargs,
            )
        finally:
            await _record_timing(
                timing_name,
                elapsed_ms(started_at),
            )

    wrapper._quizforge_timing_name = timing_name
    return wrapper


class _TimedResponsesProxy:
    def __init__(self, responses):
        self._responses = responses

    async def parse(self, *args, **kwargs):
        started_at = time.perf_counter()

        try:
            return await self._responses.parse(
                *args,
                **kwargs,
            )
        finally:
            await _record_timing(
                "openai_generation_latency_ms",
                elapsed_ms(started_at),
            )

    def __getattr__(self, name):
        return getattr(
            self._responses,
            name,
        )


class _TimedOpenAIClientProxy:
    def __init__(self, client):
        self._client = client
        self.responses = _TimedResponsesProxy(
            client.responses
        )

    def __getattr__(self, name):
        return getattr(
            self._client,
            name,
        )


def _install_quiz_service_instrumentation(
    application_module,
):
    global _quiz_service_installed

    import quiz_service

    if not _quiz_service_installed:
        original_get_openai_client = (
            quiz_service.get_openai_client
        )

        @functools.wraps(
            original_get_openai_client
        )
        async def timed_get_openai_client(
            *args,
            **kwargs,
        ):
            client = await original_get_openai_client(
                *args,
                **kwargs,
            )
            return _TimedOpenAIClientProxy(
                client
            )

        original_validator = (
            quiz_service.get_quiz_validation_errors
        )

        @functools.wraps(original_validator)
        def timed_validator(*args, **kwargs):
            started_at = time.perf_counter()

            try:
                return original_validator(
                    *args,
                    **kwargs,
                )
            finally:
                samples = (
                    _validation_timings.get()
                )
                if samples is not None:
                    samples.append(
                        elapsed_ms(started_at)
                    )

        original_generate = (
            quiz_service.generate_quiz_from_pages
        )

        @functools.wraps(original_generate)
        async def timed_generate(
            *args,
            **kwargs,
        ):
            samples: list[float] = []
            token = _validation_timings.set(
                samples
            )

            try:
                return await original_generate(
                    *args,
                    **kwargs,
                )
            finally:
                _validation_timings.reset(token)
                for duration_ms in samples:
                    await _record_timing(
                        "quiz_validation_latency_ms",
                        duration_ms,
                    )

        quiz_service.get_openai_client = (
            timed_get_openai_client
        )
        quiz_service.get_quiz_validation_errors = (
            timed_validator
        )
        quiz_service.generate_quiz_from_pages = (
            timed_generate
        )
        _quiz_service_installed = True

    application_module.generate_quiz_from_pages = (
        quiz_service.generate_quiz_from_pages
    )


def install_performance_instrumentation(
    application_module,
):
    if getattr(
        application_module,
        "_performance_metrics_installed",
        False,
    ):
        return

    phase_functions = {
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

    for function_name, timing_name in (
        phase_functions.items()
    ):
        function = getattr(
            application_module,
            function_name,
        )
        setattr(
            application_module,
            function_name,
            _timed_async_function(
                function,
                timing_name,
            ),
        )

    _install_quiz_service_instrumentation(
        application_module
    )
    application_module._performance_metrics_installed = (
        True
    )
