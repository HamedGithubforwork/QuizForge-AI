from fastapi import Depends, File, Form, UploadFile

from main import (
    AuthenticatedUser,
    Quiz,
    app,
    generate_quiz as generate_quiz_without_redis,
    get_current_user,
)
from redis_integration import (
    build_quiz_cache_key,
    cache_quiz,
    enforce_quiz_rate_limit,
    get_cached_quiz,
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
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
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

    cached_quiz = await get_cached_quiz(
        cache_key,
        Quiz,
    )

    if cached_quiz is not None:
        return cached_quiz

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

    await cache_quiz(
        cache_key,
        quiz,
    )

    return quiz
