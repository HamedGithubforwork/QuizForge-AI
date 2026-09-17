"""Authenticated history boundary with a replaceable persistence adapter.

The temporary Supabase adapter uses the caller's JWT, never a service-role key.
Explicit owner predicates supplement the existing database RLS policies.
"""

import asyncio
from datetime import datetime
import json
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

import app_shared
from app_shared import AuthenticatedUser, get_current_user
from outbound_clients import get_http_client
from processed_documents import normalize_document_sha256


router = APIRouter(prefix="/api/quiz-history", tags=["quiz-history"])


class HistoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quiz_title: str = Field(min_length=1, max_length=500)
    source_filename: str = Field(min_length=1, max_length=1000)
    document_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    difficulty: Literal["easy", "medium", "hard"]
    question_type: Literal["multiple_choice", "true_false", "short_answer", "mixed"]
    question_count: int = Field(ge=1, le=15)
    score: int = Field(ge=0)
    percentage: int = Field(ge=0, le=100)
    quiz_data: dict[str, Any]
    selected_answers: dict[str, int | str]

    @model_validator(mode="after")
    def validate_attempt(self):
        if self.score > self.question_count:
            raise ValueError("Score cannot exceed question count.")
        if len(json.dumps(self.model_dump()).encode()) > 1_500_000:
            raise ValueError("Quiz history entry is too large.")
        return self


class HistoryRow(BaseModel):
    id: UUID
    user_id: UUID
    quiz_title: str
    source_filename: str
    document_sha256: str | None = None
    difficulty: str
    question_type: str
    question_count: int
    score: int
    percentage: int
    quiz_data: Any
    selected_answers: dict[str, int | str]
    created_at: datetime


class HistoryCursor(BaseModel):
    createdAt: datetime
    id: UUID


class HistoryPage(BaseModel):
    items: list[HistoryRow]
    totalCount: int | None
    hasMore: bool
    nextCursor: HistoryCursor | None


class SupabaseHistoryRepository:
    def __init__(self, client, *, user_id: str, authorization: str):
        self.client = client
        self.user_id = user_id
        self.headers = {"apikey": app_shared.SUPABASE_PUBLISHABLE_KEY,
                        "Authorization": authorization}
        self.url = app_shared.SUPABASE_URL.rstrip("/") + "/rest/v1/quiz_history"

    async def request(self, method, *, params=None, payload=None, prefer=None):
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        try:
            response = await self.client.request(method, self.url, params=params,
                                                 json=payload, headers=headers)
        except httpx.RequestError as error:
            raise HTTPException(503, "Quiz history is temporarily unavailable.") from error
        if response.status_code in (401, 403):
            raise HTTPException(response.status_code, "Quiz history access was denied.")
        if response.status_code not in (200, 201, 204, 206):
            # Never expose database errors, headers, or authentication values.
            raise HTTPException(503, "Quiz history is temporarily unavailable.")
        return response

    def rows(self, response):
        try:
            raw = response.json()
            if not isinstance(raw, list):
                raise ValueError("Expected rows")
            rows = [HistoryRow.model_validate(item) for item in raw]
            if any(str(row.user_id) != self.user_id for row in rows):
                raise ValueError("Unexpected owner")
            return rows
        except (ValueError, ValidationError) as error:
            raise HTTPException(502, "Quiz history returned an invalid response.") from error

    def query(self, limit):
        return {"select": "*", "user_id": f"eq.{self.user_id}",
                "order": "created_at.desc,id.desc", "limit": str(limit)}

    async def page(self, *, limit, cursor_created_at=None, cursor_id=None):
        params = self.query(limit + 1)
        if cursor_created_at is not None:
            # Both values have already been parsed as datetime/UUID by FastAPI.
            timestamp = cursor_created_at.isoformat()
            params["or"] = f"(created_at.lt.{timestamp},and(created_at.eq.{timestamp},id.lt.{cursor_id}))"
        response = await self.request("GET", params=params,
                                      prefer="count=exact" if cursor_id is None else None)
        rows = self.rows(response)
        items = rows[:limit]
        has_more = len(rows) > limit
        total = None
        if cursor_id is None:
            raw_count = response.headers.get("Content-Range", "").rsplit("/", 1)[-1]
            total = int(raw_count) if raw_count.isdigit() else len(rows)
        return HistoryPage(items=items, totalCount=total, hasMore=has_more,
                           nextCursor=HistoryCursor(createdAt=items[-1].created_at, id=items[-1].id)
                           if has_more else None)

    async def for_document(self, *, source_filename, document_sha256, limit):
        if document_sha256 is None:
            response = await self.request("GET", params={**self.query(limit),
                                                          "source_filename": f"eq.{source_filename}"})
            return self.rows(response)
        hashed, legacy = await asyncio.gather(
            self.request("GET", params={**self.query(limit), "document_sha256": f"eq.{document_sha256}"}),
            self.request("GET", params={**self.query(limit), "document_sha256": "is.null",
                                         "source_filename": f"eq.{source_filename}"}),
        )
        rows = self.rows(hashed)
        # Old rows may carry their hash inside quiz_data. Preserve identity
        # matching so a different PDF with the same filename cannot be mixed in.
        for row in self.rows(legacy):
            nested = row.quiz_data if isinstance(row.quiz_data, dict) else {}
            legacy_hash = normalize_document_sha256(nested.get("document_sha256"))
            if legacy_hash is None or legacy_hash == document_sha256:
                rows.append(row)
        unique = {row.id: row for row in rows}
        return sorted(unique.values(), key=lambda row: (row.created_at, row.id), reverse=True)[:limit]

    async def create(self, entry):
        payload = {**entry.model_dump(), "user_id": self.user_id}
        await self.request("POST", payload=payload, prefer="return=minimal")

    async def delete(self, entry_id):
        # An absent or other user's row is an idempotent no-op, with no leakage.
        await self.request("DELETE", params={"id": f"eq.{entry_id}", "user_id": f"eq.{self.user_id}"},
                           prefer="return=minimal")


async def get_history_repository(
    request: Request,
    current_user: AuthenticatedUser = Depends(get_current_user),
    authorization: str | None = Header(default=None),
):
    if not authorization:
        raise HTTPException(401, "Authentication is required.")
    from history_database import history_backend
    backend = getattr(request.app.state, "history_backend", None) or history_backend()
    if backend == "postgres":
        from history_postgres import PostgresHistoryRepository
        pool = getattr(request.app.state, "history_pool", None)
        if pool is None:
            raise HTTPException(503, "Quiz history is temporarily unavailable.")
        # Only the verified provider identity may select the internal owner UUID.
        if not current_user.issuer or not current_user.subject:
            raise HTTPException(403, "Quiz history access is not provisioned.")
        return PostgresHistoryRepository(pool, issuer=current_user.issuer, subject=current_user.subject)
    if current_user.provider != "supabase":
        raise HTTPException(503, "Quiz history is not configured for this authentication provider.")
    return SupabaseHistoryRepository(await get_http_client(), user_id=current_user.id,
                                      authorization=authorization)


@router.get("", response_model=HistoryPage)
async def list_history(
    limit: int = Query(default=20, ge=1, le=50),
    cursor_created_at: datetime | None = None,
    cursor_id: UUID | None = None,
    repository=Depends(get_history_repository),
):
    if (cursor_created_at is None) != (cursor_id is None):
        raise HTTPException(422, "Both history cursor fields are required together.")
    if cursor_created_at is not None and cursor_created_at.tzinfo is None:
        raise HTTPException(422, "History cursor timestamp must include a timezone.")
    return await repository.page(limit=limit, cursor_created_at=cursor_created_at, cursor_id=cursor_id)


@router.get("/document", response_model=list[HistoryRow])
async def document_history(
    source_filename: str = Query(min_length=1, max_length=1000),
    document_sha256: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$"),
    limit: int = Query(default=30, ge=1, le=50),
    repository=Depends(get_history_repository),
):
    return await repository.for_document(source_filename=source_filename,
                                          document_sha256=document_sha256, limit=limit)


@router.post("", status_code=201, response_class=Response)
async def create_history(entry: HistoryCreate, repository=Depends(get_history_repository)):
    await repository.create(entry)
    return Response(status_code=201)


@router.delete("/{entry_id}", status_code=204, response_class=Response)
async def delete_history(entry_id: UUID, repository=Depends(get_history_repository)):
    await repository.delete(entry_id)
    return Response(status_code=204)
