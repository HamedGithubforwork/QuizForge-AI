"""Separate opt-in enrollment authority. Never mount in the history API."""
from contextlib import asynccontextmanager
import os
import re
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
import httpx
import jwt
from pydantic import BaseModel, ConfigDict, Field
from psycopg_pool import AsyncConnectionPool

from cognito_auth import CognitoSettings, verifier_for
from history_database import connection_settings
from identity_database import IdentityRepository, check_identity_role
from identity_proofs import Identity, supabase_link_proof


class Intent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["enroll", "link"]


class Confirmation(Intent):
    nonce: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


def public_legacy_key(key):
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{20,}", key):
        return True
    try:
        # Classifies the public configuration key, never authorizes a user.
        claims = jwt.decode(key, options={"verify_signature": False})
        return claims.get("role") == "anon" and claims.get("ref") == "vfxmsvphgcaizqnbyjip"
    except (jwt.PyJWTError, ValueError, TypeError):
        return False


def settings():
    environment = os.getenv("IDENTITY_ENVIRONMENT", "")
    if not environment and os.getenv("IDENTITY_STAGING_ENABLED") == "true":
        environment = "staging"
    if environment not in ("staging", "production"):
        raise RuntimeError("Identity enrollment requires an explicit environment")
    origin = os.getenv("IDENTITY_ALLOWED_ORIGIN", "")
    parsed = urlparse(origin)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or not (parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")))):
        raise RuntimeError("Enrollment requires one exact HTTPS or local test origin")
    url = os.getenv("IDENTITY_SUPABASE_URL", "").rstrip("/")
    key = os.getenv("IDENTITY_SUPABASE_PUBLISHABLE_KEY", "")
    legacy = urlparse(url)
    if url and (legacy.scheme != "https" or not legacy.hostname or legacy.username or legacy.password
                or legacy.path or legacy.query or legacy.fragment or not key):
        raise RuntimeError("Legacy proof requires an exact HTTPS origin and a publishable key")
    if environment == "production":
        if (origin != "https://quizfromnotes.com" or os.getenv("IDENTITY_STAGING_ENABLED") == "true"
                or url != "https://vfxmsvphgcaizqnbyjip.supabase.co" or not public_legacy_key(key)
                or os.getenv("IDENTITY_DB_NAME") != "quizforge"
                or not re.fullmatch(r"quizforge-production\.[a-z0-9]+\.ca-central-1\.rds\.amazonaws\.com",
                                    os.getenv("IDENTITY_DB_HOST", ""))):
            raise RuntimeError("Production enrollment requires the exact reviewed domain, source and database")
    return origin, url, key


def create_identity_app():
    origin, legacy_url, legacy_key = settings()
    cognito = CognitoSettings.from_environment()

    @asynccontextmanager
    async def lifespan(app):
        kwargs, size = connection_settings(prefix="IDENTITY_DB")
        pool = AsyncConnectionPool(kwargs=kwargs, min_size=1, max_size=size, max_waiting=10,
                                   timeout=5, open=False, configure=check_identity_role)
        try:
            await pool.open(wait=True, timeout=15)
            async with httpx.AsyncClient() as client:
                app.state.pool, app.state.http = pool, client
                yield
        finally:
            await pool.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=[origin], allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type", "X-Legacy-Authorization"])

    @app.middleware("http")
    async def protect(request, call_next):
        from starlette.responses import JSONResponse
        if request.headers.get("origin") != origin:
            return JSONResponse({"detail": "Untrusted request origin."}, status_code=403)
        # Bounded JSON bodies even when Transfer-Encoding is chunked.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 2048:
                return JSONResponse({"detail": "Request is too large."}, status_code=413)
        request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    async def repository(request, authorization, legacy_authorization, mode=None):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Sign in to Cognito first.")
        subject, email = await verifier_for(cognito).verify(authorization[7:], request.app.state.http,
                                                           max_auth_age=300 if mode else None)
        legacy = None
        if mode == "link":
            if not legacy_url or not legacy_authorization or not legacy_authorization.startswith("Bearer "):
                raise HTTPException(401, "A fresh sign-in to the existing account is required.")
            legacy = await supabase_link_proof(legacy_authorization[7:], request.app.state.http, legacy_url, legacy_key)
        elif legacy_authorization:
            raise HTTPException(400, "Legacy proof is only accepted for account linking.")
        return IdentityRepository(request.app.state.pool, Identity(cognito.issuer, subject), legacy), subject, email

    @app.get("/identity/session")
    async def session(request: Request, authorization: str | None = Header(default=None)):
        repo, subject, email = await repository(request, authorization, None)
        return {"enrolled": await repo.enrolled(), "id": f"cognito:{cognito.pool_id}:{subject}", "email": email}

    @app.post("/identity/challenge")
    async def challenge(body: Intent, request: Request, authorization: str | None = Header(default=None),
                        x_legacy_authorization: str | None = Header(default=None)):
        repo, _, _ = await repository(request, authorization, x_legacy_authorization, body.mode)
        return {"nonce": await repo.challenge(body.mode), "expires_in": 300}

    @app.post("/identity/confirm", status_code=204)
    async def confirm(body: Confirmation, request: Request, authorization: str | None = Header(default=None),
                      x_legacy_authorization: str | None = Header(default=None)):
        repo, _, _ = await repository(request, authorization, x_legacy_authorization, body.mode)
        await repo.confirm(body.nonce, body.mode)

    return app
