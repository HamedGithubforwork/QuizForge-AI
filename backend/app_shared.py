import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from answer_review import (
    AnswerReviewRequest,
    AnswerReviewResponse,
    review_borderline_answers_with_ai,
)


ENV_FILE = Path(__file__).resolve().parent / ".env"

load_dotenv(
    dotenv_path=ENV_FILE,
    override=True,
)


DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


class AuthenticatedUser(BaseModel):
    id: str
    email: str | None = None


def get_allowed_origins():
    configured_origins = os.getenv(
        "ALLOWED_ORIGINS",
        "",
    )

    if not configured_origins.strip():
        return DEFAULT_ALLOWED_ORIGINS

    return [
        origin.strip().rstrip("/")
        for origin in configured_origins.split(",")
        if origin.strip()
    ]


def get_positive_int_env(
    name: str,
    default: int,
):
    raw_value = os.getenv(name)

    if not raw_value:
        return default

    try:
        value = int(raw_value)
    except ValueError:
        return default

    return max(1, value)


SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "",
).rstrip("/")

SUPABASE_PUBLISHABLE_KEY = os.getenv(
    "SUPABASE_PUBLISHABLE_KEY",
    "",
)


async def get_current_user(
    authorization: str | None = Header(
        default=None,
    ),
):
    if (
        not authorization
        or not authorization.startswith(
            "Bearer "
        )
    ):
        raise HTTPException(
            status_code=401,
            detail="Authentication is required.",
        )

    if (
        not SUPABASE_URL
        or not SUPABASE_PUBLISHABLE_KEY
    ):
        raise HTTPException(
            status_code=500,
            detail=(
                "Supabase authentication is "
                "not configured on the backend."
            ),
        )

    access_token = authorization[
        len("Bearer "):
    ].strip()

    if not access_token:
        raise HTTPException(
            status_code=401,
            detail="Authentication is required.",
        )

    try:
        async with httpx.AsyncClient(
            timeout=8.0,
        ) as client:
            response = await client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={
                    "apikey": SUPABASE_PUBLISHABLE_KEY,
                    "Authorization": (
                        f"Bearer {access_token}"
                    ),
                },
            )
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "Authentication service is "
                "temporarily unavailable."
            ),
        ) from error

    if response.status_code != 200:
        if response.status_code >= 500:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Authentication service is "
                    "temporarily unavailable."
                ),
            )

        raise HTTPException(
            status_code=401,
            detail=(
                "Your session is invalid or "
                "has expired."
            ),
        )

    try:
        user_data = response.json()
    except ValueError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "Authentication service returned "
                "an invalid response."
            ),
        ) from error

    user_id = user_data.get("id")

    if not isinstance(user_id, str):
        raise HTTPException(
            status_code=401,
            detail=(
                "Your session is invalid or "
                "has expired."
            ),
        )

    email = user_data.get("email")

    return AuthenticatedUser(
        id=user_id,
        email=(
            email
            if isinstance(email, str)
            else None
        ),
    )


def create_app():
    app = FastAPI(
        title="QuizForge AI API",
        version="0.7.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_allowed_origins(),
        allow_credentials=False,
        allow_methods=[
            "GET",
            "POST",
        ],
        allow_headers=[
            "Authorization",
            "Content-Type",
        ],
    )

    @app.middleware("http")
    async def add_security_headers(
        request,
        call_next,
    ):
        response = await call_next(request)

        response.headers[
            "X-Content-Type-Options"
        ] = "nosniff"
        response.headers[
            "Referrer-Policy"
        ] = "no-referrer"
        response.headers[
            "Permissions-Policy"
        ] = (
            "camera=(), microphone=(), "
            "geolocation=()"
        )
        response.headers[
            "X-Frame-Options"
        ] = "DENY"
        response.headers[
            "Strict-Transport-Security"
        ] = (
            "max-age=31536000; "
            "includeSubDomains"
        )

        return response

    @app.get("/")
    def root():
        return {
            "message": (
                "QuizForge AI backend is running"
            )
        }

    @app.get("/api/health")
    def health_check():
        return {
            "message": (
                "Frontend connected to FastAPI!"
            )
        }

    @app.post(
        "/api/answers/review",
        response_model=AnswerReviewResponse,
    )
    async def review_borderline_answers(
        payload: AnswerReviewRequest,
        current_user: AuthenticatedUser = Depends(
            get_current_user
        ),
    ):
        return await review_borderline_answers_with_ai(
            payload,
            current_user.id,
        )

    return app
