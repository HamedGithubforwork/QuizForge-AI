import logging
import os
import time

from fastapi import (
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)

import main as base_app
from admin_metrics import get_metric_snapshot
from observability import (
    elapsed_ms,
    log_event,
    observe_http_request,
    record_quiz_metrics,
)
from redis_integration import (
    build_quiz_cache_key,
    cache_quiz,
    enforce_quiz_rate_limit,
    get_cached_quiz,
    redis_client,
)


AuthenticatedUser = base_app.AuthenticatedUser
Quiz = base_app.Quiz
app = base_app.app
get_current_user = base_app.get_current_user
generate_quiz_without_redis = base_app.generate_quiz


# The Redis entrypoint owns quiz-generation rate limiting. Disable the
# legacy process-local limiter in main.py for this process so a cache miss
# is not rate-limited twice. Running `uvicorn main:app` directly is
# unaffected and still uses the original in-memory limiter.
base_app.enforce_quiz_rate_limit = lambda _user_id: None


@app.middleware("http")
async def observability_middleware(
    request,
    call_next,
):
    return await observe_http_request(
        request,
        call_next,
        redis_client,
    )


def get_admin_user_ids():
    return {
        user_id.strip()
        for user_id in os.getenv(
            "ADMIN_USER_IDS",
            "",
        ).split(",")
        if user_id.strip()
    }


async def require_admin(
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    if current_user.id not in get_admin_user_ids():
        raise HTTPException(
            status_code=403,
            detail="Admin access is required.",
        )

    return current_user


@app.get("/api/admin/metrics")
async def admin_metrics(
    _current_user: AuthenticatedUser = Depends(
        require_admin
    ),
):
    return await get_metric_snapshot(
        redis_client,
    )


# Replace the original quiz-generation route with a Redis-aware wrapper.
# The underlying generation function remains unchanged.
app.router.routes = [
    route
    for route in app.router.routes
    if getattr(route, "path", None)
    != "/api/quizzes/generate"
]


@app.post(
    "/api/quizzes/generate",
    response_model=Quiz,
)
async def generate_quiz(
    file: UploadFile = File(...),
    question_count: int = Form(5),
    difficulty: str = Form("medium"),
    question_type: str = Form(
        "multiple_choice"
    ),
    focus_pages: str = Form(""),
    focus_question_types: str = Form(""),
    avoid_questions: str = Form("[]"),
    force_new_quiz: bool = Form(False),
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    started_at = time.perf_counter()

    # Redis is the shared rate limiter across backend instances.
    await enforce_quiz_rate_limit(
        current_user.id,
    )

    contents = await file.read()
    await file.seek(0)

    cache_key = build_quiz_cache_key(
        user_id=current_user.id,
        contents=contents,
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_pages=focus_pages,
        focus_question_types=(
            focus_question_types
        ),
        avoid_questions=avoid_questions,
        content_type=file.content_type,
    )

    cache_result = (
        "bypass"
        if force_new_quiz
        else "miss"
    )

    if not force_new_quiz:
        cached_quiz = await get_cached_quiz(
            cache_key,
            Quiz,
        )

        if cached_quiz is not None:
            duration = elapsed_ms(
                started_at,
            )

            await record_quiz_metrics(
                redis_client,
                cache_result="hit",
                duration_ms=duration,
            )

            log_event(
                "quiz_generation_completed",
                cache_result="hit",
                duration_ms=duration,
                question_count=question_count,
            )

            return cached_quiz

    try:
        quiz = await generate_quiz_without_redis(
            file=file,
            question_count=question_count,
            difficulty=difficulty,
            question_type=question_type,
            focus_pages=focus_pages,
            focus_question_types=(
                focus_question_types
            ),
            avoid_questions=avoid_questions,
            current_user=current_user,
        )
    except HTTPException as error:
        duration = elapsed_ms(
            started_at,
        )
        failed = error.status_code >= 500

        await record_quiz_metrics(
            redis_client,
            cache_result=cache_result,
            duration_ms=duration,
            failed=failed,
        )

        log_event(
            (
                "quiz_generation_failed"
                if failed
                else "quiz_generation_rejected"
            ),
            level=(
                logging.ERROR
                if failed
                else logging.WARNING
            ),
            cache_result=cache_result,
            duration_ms=duration,
            question_count=question_count,
            status_code=error.status_code,
            error_type=type(error).__name__,
        )

        raise
    except Exception as error:
        duration = elapsed_ms(
            started_at,
        )

        await record_quiz_metrics(
            redis_client,
            cache_result=cache_result,
            duration_ms=duration,
            failed=True,
        )

        log_event(
            "quiz_generation_failed",
            level=logging.ERROR,
            cache_result=cache_result,
            duration_ms=duration,
            question_count=question_count,
            error_type=type(error).__name__,
        )

        raise

    # Store the newly generated quiz under the normal request cache key.
    # A forced new generation therefore replaces the older cached quiz.
    await cache_quiz(
        cache_key,
        quiz,
    )

    duration = elapsed_ms(
        started_at,
    )

    await record_quiz_metrics(
        redis_client,
        cache_result=cache_result,
        duration_ms=duration,
    )

    log_event(
        "quiz_generation_completed",
        cache_result=cache_result,
        duration_ms=duration,
        question_count=question_count,
    )

    return quiz
