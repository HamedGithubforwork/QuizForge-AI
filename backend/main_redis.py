import logging
import os
import time
from contextvars import ContextVar
from types import FunctionType

from fastapi import (
    Depends,
    FastAPI,
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
    record_document_cache_metric,
    record_quiz_metrics,
)
from redis_integration import (
    build_document_cache_key,
    build_quiz_cache_key,
    cache_document,
    cache_quiz,
    compute_pdf_sha256,
    enforce_quiz_rate_limit,
    get_cached_document,
    get_cached_quiz,
    redis_client,
)


AuthenticatedUser = base_app.AuthenticatedUser
Quiz = base_app.Quiz
get_current_user = base_app.get_current_user
extract_pdf_pages_without_redis = (
    base_app.extract_pdf_pages
)


# Redis-aware requests may pre-load PDF pages before delegating to the
# base endpoint logic. ContextVar keeps those pages isolated to the current
# request without changing main.py's global extraction function.
_document_pages_context = ContextVar(
    "quizforge_document_pages_context",
    default=None,
)


def extract_pdf_pages_from_context(
    contents: bytes,
):
    cached_context = (
        _document_pages_context.get()
    )

    if cached_context is not None:
        cached_hash, cached_pages = (
            cached_context
        )

        if (
            compute_pdf_sha256(contents)
            == cached_hash
        ):
            return cached_pages

    return extract_pdf_pages_without_redis(
        contents
    )


def _skip_local_quiz_rate_limit(
    _user_id: str,
):
    """The Redis entrypoint already applies the shared limiter."""


def _clone_endpoint_with_global_overrides(
    endpoint,
    **overrides,
):
    """Clone a base endpoint with isolated runtime dependencies.

    The cloned function receives a copy of the base endpoint's global
    namespace with only the requested dependencies replaced. This keeps the
    production Redis path from mutating main.py globals while still reusing
    the authoritative validation and response logic.
    """

    endpoint_globals = dict(
        endpoint.__globals__
    )
    endpoint_globals.update(overrides)

    cloned_endpoint = FunctionType(
        endpoint.__code__,
        endpoint_globals,
        endpoint.__name__,
        endpoint.__defaults__,
        endpoint.__closure__,
    )

    cloned_endpoint.__kwdefaults__ = (
        dict(endpoint.__kwdefaults__)
        if endpoint.__kwdefaults__
        else None
    )
    cloned_endpoint.__annotations__ = dict(
        getattr(
            endpoint,
            "__annotations__",
            {},
        )
    )
    cloned_endpoint.__dict__.update(
        getattr(endpoint, "__dict__", {})
    )
    cloned_endpoint.__doc__ = endpoint.__doc__
    cloned_endpoint.__module__ = endpoint.__module__
    cloned_endpoint.__qualname__ = endpoint.__qualname__

    return cloned_endpoint


# These delegates reuse the base endpoint code without changing the base
# application's global rate limiter, PDF extractor, or route table.
upload_pdf_without_redis = (
    _clone_endpoint_with_global_overrides(
        base_app.upload_pdf,
        extract_pdf_pages=(
            extract_pdf_pages_from_context
        ),
    )
)

generate_quiz_without_redis = (
    _clone_endpoint_with_global_overrides(
        base_app.generate_quiz,
        enforce_quiz_rate_limit=(
            _skip_local_quiz_rate_limit
        ),
        extract_pdf_pages=(
            extract_pdf_pages_from_context
        ),
    )
)


def create_redis_app():
    """Build the production app without mutating the base FastAPI app."""

    redis_app = FastAPI(
        title=base_app.app.title,
        version=base_app.app.version,
    )

    # Preserve the base security-header and CORS middleware configuration.
    redis_app.user_middleware = list(
        base_app.app.user_middleware
    )
    redis_app.exception_handlers.update(
        base_app.app.exception_handlers
    )

    # FastAPI already created fresh documentation routes for redis_app.
    # Reuse only the base business routes that are not replaced below.
    built_in_paths = {
        path
        for path in (
            base_app.app.openapi_url,
            "/docs",
            "/docs/oauth2-redirect",
            "/redoc",
        )
        if path
    }

    overridden_paths = {
        "/api/documents/upload",
        "/api/quizzes/generate",
    }

    for route in base_app.app.routes:
        route_path = getattr(
            route,
            "path",
            None,
        )

        if (
            route_path in built_in_paths
            or route_path in overridden_paths
        ):
            continue

        redis_app.router.routes.append(route)

    return redis_app


app = create_redis_app()


async def get_document_pages_with_cache(
    user_id: str,
    contents: bytes,
):
    pdf_sha256 = compute_pdf_sha256(
        contents
    )

    cache_key = build_document_cache_key(
        user_id=user_id,
        contents=contents,
    )

    cached_document = await get_cached_document(
        cache_key
    )

    if cached_document is not None:
        await record_document_cache_metric(
            redis_client,
            "hit",
        )

        log_event(
            "document_cache_lookup",
            cache_result="hit",
            page_count=len(
                cached_document["pages"]
            ),
        )

        return (
            cached_document["pdf_sha256"],
            cached_document["pages"],
        )

    pages = extract_pdf_pages_without_redis(
        contents
    )

    cached = await cache_document(
        cache_key,
        {
            "pdf_sha256": pdf_sha256,
            "pages": pages,
        },
    )

    await record_document_cache_metric(
        redis_client,
        "miss",
    )

    log_event(
        "document_cache_lookup",
        cache_result="miss",
        page_count=len(pages),
        stored=cached,
    )

    return pdf_sha256, pages


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


@app.post("/api/documents/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    if file.content_type != "application/pdf":
        return await upload_pdf_without_redis(
            file=file,
            _current_user=current_user,
        )

    contents = await file.read()
    await file.seek(0)

    if len(contents) > base_app.MAX_FILE_SIZE:
        return await upload_pdf_without_redis(
            file=file,
            _current_user=current_user,
        )

    pdf_sha256, pages = (
        await get_document_pages_with_cache(
            user_id=current_user.id,
            contents=contents,
        )
    )

    context_token = (
        _document_pages_context.set(
            (pdf_sha256, pages)
        )
    )

    try:
        return await upload_pdf_without_redis(
            file=file,
            _current_user=current_user,
        )
    finally:
        _document_pages_context.reset(
            context_token
        )


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
    generate_new_quiz_instead_of_using_cache: bool = Form(False),
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
        if generate_new_quiz_instead_of_using_cache
        else "miss"
    )

    if not generate_new_quiz_instead_of_using_cache:
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

    context_token = None

    should_prepare_document_cache = (
        file.content_type == "application/pdf"
        and len(contents)
        <= base_app.MAX_FILE_SIZE
        and question_count in [5, 10, 15]
        and difficulty.lower()
        in ["easy", "medium", "hard"]
        and question_type.lower()
        in [
            "multiple_choice",
            "true_false",
            "short_answer",
            "mixed",
        ]
    )

    try:
        if should_prepare_document_cache:
            pdf_sha256, pages = (
                await get_document_pages_with_cache(
                    user_id=current_user.id,
                    contents=contents,
                )
            )

            context_token = (
                _document_pages_context.set(
                    (pdf_sha256, pages)
                )
            )

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
    finally:
        if context_token is not None:
            _document_pages_context.reset(
                context_token
            )

    # Store the newly generated quiz under the normal request cache key.
    # A requested new generation therefore replaces the older cached quiz.
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
