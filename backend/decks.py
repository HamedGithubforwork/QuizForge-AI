"""Authenticated study-deck API backed by the reviewed application database."""

import json
from typing import Any, Literal
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app_shared import AuthenticatedUser, get_current_user


router = APIRouter(prefix="/api/decks", tags=["decks"])


class CardCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_type: Literal["multiple_choice", "true_false", "short_answer"]
    question: str = Field(min_length=1, max_length=10_000)
    answer: dict[str, Any]
    choices: list[str] | None = Field(default=None, max_length=8)
    explanation: str | None = Field(default=None, max_length=20_000)
    source_filename: str | None = Field(default=None, max_length=1000)
    document_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    source_pages: list[int] = Field(default_factory=list, max_length=50)

    @field_validator("question")
    @classmethod
    def clean_question(cls, value: str):
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Question cannot be blank.")
        return cleaned

    @field_validator("choices")
    @classmethod
    def validate_choices(cls, value: list[str] | None):
        if value is None:
            return None
        cleaned = [choice.strip() for choice in value]
        if any(not choice or len(choice) > 2000 for choice in cleaned):
            raise ValueError("Choices must contain non-blank bounded text.")
        return cleaned

    @field_validator("source_pages")
    @classmethod
    def validate_source_pages(cls, value: list[int]):
        if any(type(page) is not int or page < 1 for page in value):
            raise ValueError("Source pages must be positive integers.")
        if len(value) != len(set(value)):
            raise ValueError("Source pages must be unique.")
        return sorted(value)

    @model_validator(mode="after")
    def validate_payload_size(self):
        encoded = json.dumps(
            self.model_dump(mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        if len(encoded) > 100_000:
            raise ValueError("Card is too large.")
        return self


class CardRow(CardCreate):
    id: UUID
    deck_id: UUID
    fsrs_state: Literal[1, 2, 3]
    fsrs_step: int | None
    stability: float | None
    difficulty: float | None
    due_at: datetime
    last_reviewed_at: datetime | None
    review_count: int = Field(ge=0)
    lapse_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: UUID
    rating: Literal[1, 2, 3, 4]
    review_duration_ms: int | None = Field(
        default=None,
        ge=0,
        le=86_400_000,
    )


class ReviewQueue(BaseModel):
    deck_id: UUID
    deck_name: str
    due_count: int = Field(ge=0)
    next_due_at: datetime | None
    cards: list[CardRow]


class ReviewResult(BaseModel):
    card: CardRow
    remaining_due_count: int = Field(ge=0)
    next_due_at: datetime | None


class DeckCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    cards: list[CardCreate] = Field(default_factory=list, max_length=50)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str):
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Deck name cannot be blank.")
        return cleaned


class DeckUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None):
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Deck name cannot be blank.")
        return cleaned

    @model_validator(mode="after")
    def validate_changes(self):
        if not self.model_fields_set:
            raise ValueError("At least one deck field must be changed.")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Deck name cannot be null.")
        return self


class CardBatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cards: list[CardCreate] = Field(min_length=1, max_length=50)


class DeckSummary(BaseModel):
    id: UUID
    name: str
    description: str | None
    card_count: int = Field(ge=0)
    due_count: int = Field(ge=0)
    next_due_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DeckDetail(DeckSummary):
    cards: list[CardRow]


async def get_deck_repository(
    request: Request,
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    from history_database import history_backend

    if history_backend() != "postgres":
        raise HTTPException(503, "Study decks require PostgreSQL storage.")

    pool = getattr(request.app.state, "history_pool", None)
    if pool is None:
        raise HTTPException(503, "Study decks are temporarily unavailable.")

    if not current_user.issuer or not current_user.subject:
        raise HTTPException(403, "Study deck access is not provisioned.")

    from deck_postgres import PostgresDeckRepository

    return PostgresDeckRepository(
        pool,
        issuer=current_user.issuer,
        subject=current_user.subject,
    )


@router.get("", response_model=list[DeckSummary])
async def list_decks(repository=Depends(get_deck_repository)):
    return await repository.list()


@router.post("", status_code=201, response_model=DeckDetail)
async def create_deck(
    payload: DeckCreate,
    repository=Depends(get_deck_repository),
):
    return await repository.create(payload)


@router.get("/{deck_id}", response_model=DeckDetail)
async def get_deck(
    deck_id: UUID,
    repository=Depends(get_deck_repository),
):
    return await repository.get(deck_id)


@router.get(
    "/{deck_id}/review",
    response_model=ReviewQueue,
)
async def get_review_queue(
    deck_id: UUID,
    limit: int = 20,
    repository=Depends(get_deck_repository),
):
    if not 1 <= limit <= 50:
        raise HTTPException(
            422,
            "Review limit must be between 1 and 50.",
        )
    return await repository.review_queue(
        deck_id,
        limit=limit,
    )


@router.post(
    "/{deck_id}/review",
    response_model=ReviewResult,
)
async def review_card(
    deck_id: UUID,
    payload: ReviewRequest,
    repository=Depends(get_deck_repository),
):
    return await repository.review_card(
        deck_id,
        card_id=payload.card_id,
        rating=payload.rating,
        review_duration_ms=(
            payload.review_duration_ms
        ),
    )


@router.patch("/{deck_id}", response_model=DeckDetail)
async def update_deck(
    deck_id: UUID,
    payload: DeckUpdate,
    repository=Depends(get_deck_repository),
):
    return await repository.update(deck_id, payload)


@router.delete("/{deck_id}", status_code=204, response_class=Response)
async def delete_deck(
    deck_id: UUID,
    repository=Depends(get_deck_repository),
):
    await repository.delete(deck_id)
    return Response(status_code=204)


@router.post("/{deck_id}/cards", status_code=201, response_model=DeckDetail)
async def add_cards(
    deck_id: UUID,
    payload: CardBatchCreate,
    repository=Depends(get_deck_repository),
):
    return await repository.add_cards(deck_id, payload.cards)
