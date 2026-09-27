"""Context selection, grounding enforcement, and cache write for generated quizzes."""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException


async def generate_grounded_quiz(
    *,
    pages: list[dict[str, Any]],
    question_count: int,
    difficulty: str,
    question_type: str,
    focus_pages: str,
    focus_question_types: str,
    avoid_questions: str,
    cache_key: str,
    parse_focus_pages: Callable[[str, int], list[int]],
    parse_avoid_questions: Callable[[str], list[str]],
    build_generation_pages: Callable[..., Any],
    generate_quiz_from_pages: Callable[..., Awaitable[Any]],
    cache_quiz: Callable[[str, Any], Awaitable[Any]],
    log_event: Callable[..., Any],
):
    focus_page_numbers = (
        parse_focus_pages(
            focus_pages,
            len(pages),
        )
    )
    previous_questions = (
        parse_avoid_questions(
            avoid_questions
        )
    )
    generation_pages = build_generation_pages(
        pages,
        focus_page_numbers=(
            focus_page_numbers
        ),
        query_texts=previous_questions,
    )
    selection = generation_pages.selection

    log_event(
        "quiz_context_selected",
        original_page_count=len(pages),
        selected_page_count=len(
            selection.source_pages
        ),
        total_chunk_count=(
            selection.total_chunk_count
        ),
        selected_chunk_count=len(
            selection.chunks
        ),
        total_character_count=(
            selection.total_character_count
        ),
        selected_character_count=(
            selection.selected_character_count
        ),
        truncated=selection.truncated,
        focus_page_count=len(
            focus_page_numbers
        ),
    )

    quiz = await generate_quiz_from_pages(
        pages=generation_pages,
        question_count=question_count,
        difficulty=difficulty,
        question_type=question_type,
        focus_pages=focus_pages,
        focus_question_types=(
            focus_question_types
        ),
        avoid_questions=avoid_questions,
    )

    cited_pages = {
        page_number
        for question in quiz.questions
        for page_number in question.source_pages
    }
    invalid_context_pages = (
        cited_pages
        - generation_pages.source_pages
    )

    if invalid_context_pages:
        log_event(
            "quiz_context_grounding_rejected",
            level=logging.WARNING,
            invalid_source_page_count=len(
                invalid_context_pages
            ),
        )
        raise HTTPException(
            status_code=502,
            detail=(
                "The AI cited source material that was not included "
                "in the selected document context. Please try "
                "generating the quiz again."
            ),
        )

    # A requested new generation replaces the older cached quiz.
    await cache_quiz(
        cache_key,
        quiz,
    )

    return quiz
