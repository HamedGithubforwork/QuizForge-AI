import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import quiz_service
from quiz_generation_api import generate_quiz_response


def test_invalid_previous_question_list_stops_before_cache_or_source_reads():
    called = {"source": False, "cache_key": False}

    async def allow_rate_limit(_user_id):
        return None

    async def record_metrics(*_args, **_kwargs):
        return None

    async def source_identity(**_kwargs):
        called["source"] = True
        raise AssertionError("source should not be read")

    def build_cache_key(**_kwargs):
        called["cache_key"] = True
        raise AssertionError("cache key should not be built")

    runtime = SimpleNamespace(
        enforce_rate_limit=allow_rate_limit,
        normalize_settings=lambda count, difficulty, question_type: (
            count,
            difficulty,
            question_type,
        ),
        parse_avoid_questions=quiz_service.parse_avoid_questions,
        record_metrics=record_metrics,
        redis_client=None,
        log_event=lambda *_args, **_kwargs: None,
        get_source_identity=source_identity,
        build_cache_key=build_cache_key,
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            generate_quiz_response(
                file=None,
                document_sha256="",
                question_count=5,
                difficulty="medium",
                question_type="multiple_choice",
                focus_pages="",
                focus_question_types="",
                avoid_questions='["Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q", "Q"]',
                generate_new_quiz_instead_of_using_cache=False,
                current_user=SimpleNamespace(id="test-user"),
                runtime=runtime,
            )
        )

    assert error.value.status_code == 400
    assert called == {"source": False, "cache_key": False}
