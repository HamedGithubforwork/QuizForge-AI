"""Authenticated study-deck API backed by the reviewed application database."""

import json
from typing import Any, Literal
from uuid import UUID
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, UUID4, field_validator, model_validator

from app_shared import AuthenticatedUser, get_current_user
from review_service import ReviewDomainError, ReviewService


router = APIRouter(prefix="/api/decks", tags=["decks"])


StudyIntensity = Literal[
    "relaxed",
    "balanced",
    "intensive",
]


def normalize_card_tags(
    value: list[str],
) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    for tag in value:
        cleaned = " ".join(
            tag.split()
        ).casefold()

        if (
            not cleaned
            or len(cleaned) > 50
        ):
            raise ValueError(
                "Tags must contain 1 to 50 characters."
            )

        if cleaned in seen:
            continue

        seen.add(cleaned)
        normalized.append(
            cleaned
        )

    return normalized


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
    tags: list[str] = Field(
        default_factory=list,
        max_length=20,
    )

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

    @field_validator("tags")
    @classmethod
    def normalize_tags(
        cls,
        value: list[str],
    ):
        return normalize_card_tags(
            value
        )

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
    suspended: bool
    progress_reset_at: datetime | None
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


class OfflineReviewRequest(ReviewRequest):
    event_id: UUID4
    reviewed_at: AwareDatetime
    expected_updated_at: AwareDatetime
    expected_study_intensity: StudyIntensity


class OfflineReviewResult(BaseModel):
    event_id: UUID
    replayed: bool
    card: CardRow
    remaining_due_count: int = Field(ge=0)
    next_due_at: datetime | None


class ReviewPreview(BaseModel):
    again: datetime
    hard: datetime
    good: datetime
    easy: datetime


class ReviewQueueCard(CardRow):
    review_preview: ReviewPreview


class ReviewQueue(BaseModel):
    deck_id: UUID
    deck_name: str
    study_intensity: StudyIntensity
    due_count: int = Field(ge=0)
    next_due_at: datetime | None
    cards: list[ReviewQueueCard]


class ReviewResult(BaseModel):
    card: CardRow
    remaining_due_count: int = Field(ge=0)
    next_due_at: datetime | None


class DeckCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    exam_date: date | None = None
    study_intensity: StudyIntensity = "balanced"
    cards: list[CardCreate] = Field(default_factory=list, max_length=50)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str):
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Deck name cannot be blank.")
        return cleaned


class DeckDuplicate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(
        default=None,
        max_length=200,
    )

    @field_validator("name")
    @classmethod
    def clean_name(
        cls,
        value: str | None,
    ):
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError(
                "Deck name cannot be blank."
            )
        return cleaned


class DeckUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    exam_date: date | None = None
    study_intensity: StudyIntensity | None = None

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
        if (
            "study_intensity"
            in self.model_fields_set
            and self.study_intensity
            is None
        ):
            raise ValueError(
                "Study intensity cannot be null."
            )
        return self


class CardMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_deck_id: UUID


class CardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_type: Literal[
        "multiple_choice",
        "true_false",
        "short_answer",
    ] | None = None
    question: str | None = Field(
        default=None,
        max_length=10_000,
    )
    answer: dict[str, Any] | None = None
    choices: list[str] | None = Field(
        default=None,
        max_length=8,
    )
    explanation: str | None = Field(
        default=None,
        max_length=20_000,
    )
    source_filename: str | None = Field(
        default=None,
        max_length=1000,
    )
    document_sha256: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    source_pages: list[int] | None = Field(
        default=None,
        max_length=50,
    )
    tags: list[str] | None = Field(
        default=None,
        max_length=20,
    )

    @field_validator("question")
    @classmethod
    def clean_question(
        cls,
        value: str | None,
    ):
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError(
                "Question cannot be blank."
            )
        return cleaned

    @field_validator("choices")
    @classmethod
    def validate_choices(
        cls,
        value: list[str] | None,
    ):
        if value is None:
            return None
        cleaned = [
            choice.strip()
            for choice in value
        ]
        if any(
            not choice
            or len(choice) > 2000
            for choice in cleaned
        ):
            raise ValueError(
                "Choices must contain non-blank bounded text."
            )
        return cleaned

    @field_validator("tags")
    @classmethod
    def normalize_tags(
        cls,
        value: list[str] | None,
    ):
        if value is None:
            return None

        return normalize_card_tags(
            value
        )

    @field_validator("source_pages")
    @classmethod
    def validate_source_pages(
        cls,
        value: list[int] | None,
    ):
        if value is None:
            return None
        if any(
            type(page) is not int
            or page < 1
            for page in value
        ):
            raise ValueError(
                "Source pages must be positive integers."
            )
        if len(value) != len(
            set(value)
        ):
            raise ValueError(
                "Source pages must be unique."
            )
        return sorted(value)

    @model_validator(mode="after")
    def validate_changes(self):
        if not self.model_fields_set:
            raise ValueError(
                "At least one card field must be changed."
            )

        required = {
            "question_type",
            "question",
            "answer",
            "source_pages",
            "tags",
        }
        for field_name in required:
            if (
                field_name
                in self.model_fields_set
                and getattr(
                    self,
                    field_name,
                )
                is None
            ):
                raise ValueError(
                    f"{field_name} cannot be null."
                )

        encoded = json.dumps(
            self.model_dump(
                mode="json",
                exclude_unset=True,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        if len(encoded) > 100_000:
            raise ValueError(
                "Card update is too large."
            )
        return self


class CardBatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cards: list[CardCreate] = Field(min_length=1, max_length=50)


class DeckSummary(BaseModel):
    id: UUID
    name: str
    description: str | None
    exam_date: date | None = None
    study_intensity: StudyIntensity
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


async def get_review_service(
    repository=Depends(
        get_deck_repository
    ),
):
    return ReviewService(
        repository
    )


def review_http_error(
    error: ReviewDomainError,
):
    return HTTPException(
        error.status_code,
        error.detail,
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
    service=Depends(get_review_service),
):
    if not 1 <= limit <= 50:
        raise HTTPException(
            422,
            "Review limit must be between 1 and 50.",
        )
    try:
        return await service.review_queue(
            deck_id,
            limit=limit,
        )
    except ReviewDomainError as error:
        raise review_http_error(
            error
        ) from None


@router.post(
    "/{deck_id}/review",
    response_model=ReviewResult,
)
async def review_card(
    deck_id: UUID,
    payload: ReviewRequest,
    service=Depends(get_review_service),
):
    try:
        return await service.review_card(
            deck_id,
            card_id=payload.card_id,
            rating=payload.rating,
            review_duration_ms=(
                payload.review_duration_ms
            ),
        )
    except ReviewDomainError as error:
        raise review_http_error(
            error
        ) from None


@router.post("/{deck_id}/offline-review", response_model=OfflineReviewResult)
async def offline_review_card(
    deck_id: UUID,
    payload: OfflineReviewRequest,
    service=Depends(get_review_service),
):
    try:
        return await service.review_card(
            deck_id,
            card_id=payload.card_id,
            rating=payload.rating,
            review_duration_ms=
                payload.review_duration_ms,
            offline=payload,
        )
    except ReviewDomainError as error:
        raise review_http_error(
            error
        ) from None


@router.post(
    "/{deck_id}/duplicate",
    status_code=201,
    response_model=DeckDetail,
)
async def duplicate_deck(
    deck_id: UUID,
    payload: DeckDuplicate,
    repository=Depends(
        get_deck_repository
    ),
):
    return await repository.duplicate(
        deck_id,
        name=payload.name,
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


@router.post(
    "/{deck_id}/cards/{card_id}/move",
    response_model=DeckDetail,
)
async def move_card(
    deck_id: UUID,
    card_id: UUID,
    payload: CardMove,
    repository=Depends(
        get_deck_repository
    ),
):
    if payload.target_deck_id == deck_id:
        raise HTTPException(
            409,
            "Card is already in this deck.",
        )

    return await repository.move_card(
        deck_id,
        card_id,
        payload.target_deck_id,
    )


@router.patch(
    "/{deck_id}/cards/{card_id}",
    response_model=DeckDetail,
)
async def update_card(
    deck_id: UUID,
    card_id: UUID,
    payload: CardUpdate,
    repository=Depends(
        get_deck_repository
    ),
):
    return await repository.update_card(
        deck_id,
        card_id,
        payload,
    )


@router.post(
    "/{deck_id}/cards/{card_id}/suspend",
    response_model=DeckDetail,
)
async def suspend_card(
    deck_id: UUID,
    card_id: UUID,
    repository=Depends(
        get_deck_repository
    ),
):
    return await repository.set_card_suspended(
        deck_id,
        card_id,
        True,
    )


@router.post(
    "/{deck_id}/cards/{card_id}/resume",
    response_model=DeckDetail,
)
async def resume_card(
    deck_id: UUID,
    card_id: UUID,
    repository=Depends(
        get_deck_repository
    ),
):
    return await repository.set_card_suspended(
        deck_id,
        card_id,
        False,
    )


@router.post(
    "/{deck_id}/cards/{card_id}/reset-progress",
    response_model=DeckDetail,
)
async def reset_card_progress(
    deck_id: UUID,
    card_id: UUID,
    repository=Depends(
        get_deck_repository
    ),
):
    return await repository.reset_card_progress(
        deck_id,
        card_id,
    )


@router.delete(
    "/{deck_id}/cards/{card_id}",
    status_code=204,
    response_class=Response,
)
async def delete_card(
    deck_id: UUID,
    card_id: UUID,
    repository=Depends(
        get_deck_repository
    ),
):
    await repository.delete_card(
        deck_id,
        card_id,
    )
    return Response(
        status_code=204
    )


@router.post("/{deck_id}/cards", status_code=201, response_model=DeckDetail)
async def add_cards(
    deck_id: UUID,
    payload: CardBatchCreate,
    repository=Depends(get_deck_repository),
):
    return await repository.add_cards(deck_id, payload.cards)
