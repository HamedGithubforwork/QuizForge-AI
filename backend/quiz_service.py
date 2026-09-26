import json
import logging
import os
from typing import Literal

import pymupdf
from fastapi import HTTPException
from openai import OpenAIError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from observability import log_event
from outbound_clients import get_openai_client
from quiz_prompt import (
    build_focus_instructions,
    build_quiz_prompt,
    build_study_material,
    build_validation_retry,
)
from quiz_validation import get_quiz_validation_errors


MAX_FILE_SIZE = 15 * 1024 * 1024
MAX_AI_CHARACTERS = 100_000
MIN_EXTRACTABLE_CHARACTERS = 100
SCAN_CHARACTERS_PER_PAGE = 50

VALID_QUESTION_COUNTS = {5, 10, 15}
VALID_DIFFICULTIES = {
    "easy",
    "medium",
    "hard",
}
VALID_QUESTION_TYPES = {
    "multiple_choice",
    "true_false",
    "short_answer",
    "mixed",
}


class ShortAnswerGradingSpec(BaseModel):
    grading_version: Literal[2]
    grading_mode: Literal[
        "none",
        "concepts",
        "exact",
        "numeric",
    ]
    answer_groups: list[list[str]]
    required_group_count: int = Field(
        ge=0,
    )
    numeric_value: float
    numeric_tolerance: float = Field(
        ge=0,
    )
    numeric_unit: str


class QuizQuestion(BaseModel):
    question_type: Literal[
        "multiple_choice",
        "true_false",
        "short_answer",
    ]
    question: str
    choices: list[str]
    correct_index: int = Field(
        ge=-1,
        le=3,
    )
    correct_answer: str
    accepted_answers: list[str]
    grading: ShortAnswerGradingSpec
    explanation: str
    source_pages: list[int] = Field(
        min_length=1,
    )


class Quiz(BaseModel):
    title: str
    questions: list[QuizQuestion]


def validate_pdf_content_type(
    content_type: str | None,
):
    if content_type != "application/pdf":
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are allowed.",
        )


def validate_pdf_size(contents: bytes):
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=(
                "PDF is too large. "
                "Maximum size is 15 MB."
            ),
        )


def normalize_quiz_settings(
    question_count: int,
    difficulty: str,
    question_type: str,
):
    if question_count not in VALID_QUESTION_COUNTS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Question count must be "
                "5, 10, or 15."
            ),
        )

    normalized_difficulty = difficulty.lower()

    if normalized_difficulty not in VALID_DIFFICULTIES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Difficulty must be "
                "easy, medium, or hard."
            ),
        )

    normalized_question_type = question_type.lower()

    if normalized_question_type not in VALID_QUESTION_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Question type must be "
                "multiple_choice, true_false, "
                "short_answer, or mixed."
            ),
        )

    return (
        question_count,
        normalized_difficulty,
        normalized_question_type,
    )


def extract_pdf_pages(contents: bytes):
    try:
        document = pymupdf.open(
            stream=contents,
            filetype="pdf",
        )
    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail="Could not read this PDF.",
        ) from error

    if document.needs_pass:
        document.close()
        raise HTTPException(
            status_code=400,
            detail=(
                "Password-protected PDFs are "
                "not supported yet."
            ),
        )

    pages = []

    try:
        for page_number, page in enumerate(
            document,
            start=1,
        ):
            text = page.get_text().strip()
            pages.append(
                {
                    "page_number": page_number,
                    "text": text,
                }
            )
    finally:
        document.close()

    return pages


async def extract_pdf_pages_off_event_loop(
    contents: bytes,
):
    return await run_in_threadpool(
        extract_pdf_pages,
        contents,
    )


def analyze_extracted_text(pages):
    total_characters = sum(
        len(page["text"])
        for page in pages
    )

    extractable_page_count = sum(
        1
        for page in pages
        if len(page["text"].strip()) >= 20
    )

    scan_threshold = max(
        MIN_EXTRACTABLE_CHARACTERS,
        len(pages) * SCAN_CHARACTERS_PER_PAGE,
    )

    scanned_likely = (
        total_characters < scan_threshold
    )

    warning = None

    if scanned_likely:
        warning = (
            "Very little selectable text was detected. "
            "This PDF may be scanned or image-based. "
            "OCR support is not available yet."
        )

    return {
        "total_characters": total_characters,
        "extractable_page_count": extractable_page_count,
        "scanned_likely": scanned_likely,
        "warning": warning,
    }


def parse_focus_pages(
    focus_pages: str,
    page_count: int,
):
    if not focus_pages.strip():
        return []

    try:
        page_numbers = sorted(
            {
                int(value.strip())
                for value in focus_pages.split(",")
                if value.strip()
            }
        )
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "Focus pages must be "
                "comma-separated page numbers."
            ),
        ) from error

    invalid_pages = [
        page_number
        for page_number in page_numbers
        if page_number < 1
        or page_number > page_count
    ]

    if invalid_pages:
        raise HTTPException(
            status_code=400,
            detail=(
                "One or more focus pages "
                "do not exist in the PDF."
            ),
        )

    return page_numbers


def parse_focus_question_types(
    focus_question_types: str,
):
    if not focus_question_types.strip():
        return []

    valid_focus_types = {
        "multiple_choice",
        "true_false",
        "short_answer",
    }

    focus_types = [
        value.strip()
        for value in focus_question_types.split(",")
        if value.strip()
    ]

    invalid_types = [
        value
        for value in focus_types
        if value not in valid_focus_types
    ]

    if invalid_types:
        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid weak-area "
                "question type."
            ),
        )

    return focus_types


def parse_avoid_questions(
    avoid_questions: str,
):
    if not avoid_questions.strip():
        return []

    try:
        parsed = json.loads(
            avoid_questions
        )
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not read the previous "
                "question list."
            ),
        ) from error

    if (
        not isinstance(parsed, list)
        or not all(
            isinstance(value, str)
            for value in parsed
        )
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Previous questions must be "
                "a list of text values."
            ),
        )

    return [
        value.strip()
        for value in parsed
        if value.strip()
    ]


async def generate_quiz_from_pages(
    *,
    pages,
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str = "",
    focus_question_types: str = "",
    avoid_questions: str = "[]",
):
    analysis = analyze_extracted_text(
        pages,
    )

    total_characters = analysis[
        "total_characters"
    ]

    if analysis["scanned_likely"]:
        raise HTTPException(
            status_code=400,
            detail=(
                "Very little selectable text "
                "was detected. This PDF may "
                "be scanned or image-based. "
                "OCR support is not available yet."
            ),
        )

    if total_characters > MAX_AI_CHARACTERS:
        raise HTTPException(
            status_code=400,
            detail=(
                "This PDF contains too much text "
                "for the current prototype."
            ),
        )

    focus_page_numbers = parse_focus_pages(
        focus_pages,
        len(pages),
    )

    focus_types = parse_focus_question_types(
        focus_question_types,
    )

    previous_questions = parse_avoid_questions(
        avoid_questions,
    )

    api_key = os.getenv(
        "OPENAI_API_KEY"
    )

    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                "Quiz generation is not "
                "configured on the backend."
            ),
        )

    study_material = build_study_material(
        pages,
    )
    focus_instructions = build_focus_instructions(
        focus_page_numbers,
        focus_types,
        previous_questions,
    )
    prompt = build_quiz_prompt(
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_instructions=focus_instructions,
    )

    client = await get_openai_client(
        api_key,
    )

    quiz = None
    validation_errors: list[str] = []

    for generation_attempt in range(2):
        retry_instruction = (
            build_validation_retry(
                validation_errors,
            )
            if generation_attempt > 0
            else ""
        )

        try:
            response = await client.responses.parse(
                model="gpt-5.6-luna",
                input=[
                    {
                        "role": "developer",
                        "content": (
                            prompt
                            + retry_instruction
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Generate a quiz from "
                            "the following study "
                            "material:\n\n"
                            + study_material
                        ),
                    },
                ],
                text_format=Quiz,
            )
        except OpenAIError as error:
            log_event(
                "openai_quiz_generation_error",
                level=logging.ERROR,
                error_type=type(error).__name__,
            )

            raise HTTPException(
                status_code=502,
                detail=(
                    "The quiz generation service "
                    "is temporarily unavailable. "
                    "Please try again."
                ),
            ) from error

        quiz = response.output_parsed

        if quiz is None:
            validation_errors = [
                "The response could not be parsed into the quiz schema."
            ]
            continue

        validation_errors = (
            get_quiz_validation_errors(
                quiz,
                question_count=question_count,
                requested_question_type=question_type,
                page_count=len(pages),
            )
        )

        if not validation_errors:
            break

        log_event(
            "quiz_validation_failed",
            level=logging.WARNING,
            generation_attempt=(
                generation_attempt + 1
            ),
            issue_count=len(validation_errors),
        )

    if quiz is None or validation_errors:
        raise HTTPException(
            status_code=502,
            detail=(
                "The AI returned inconsistent quiz or grading data after validation. "
                "Please try generating the quiz again."
            ),
        )

    return quiz
