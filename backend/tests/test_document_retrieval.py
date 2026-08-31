import asyncio
from types import SimpleNamespace

import quiz_service
from document_retrieval import (
    build_generation_pages,
    select_document_context,
    split_page_text,
)
from quiz_service import (
    Quiz,
    QuizQuestion,
    ShortAnswerGradingSpec,
)


def _page(
    page_number: int,
    text: str,
):
    return {
        "page_number": page_number,
        "text": text,
    }


def _none_grading():
    return ShortAnswerGradingSpec(
        grading_version=2,
        grading_mode="none",
        answer_groups=[],
        required_group_count=0,
        numeric_value=0,
        numeric_tolerance=0,
        numeric_unit="",
    )


def _multiple_choice_quiz(
    source_page: int,
):
    questions = []

    for index in range(5):
        correct_answer = (
            f"Correct answer {index}"
        )
        questions.append(
            QuizQuestion(
                question_type="multiple_choice",
                question=(
                    f"Question {index}?"
                ),
                choices=[
                    correct_answer,
                    f"Wrong A {index}",
                    f"Wrong B {index}",
                    f"Wrong C {index}",
                ],
                correct_index=0,
                correct_answer=correct_answer,
                accepted_answers=[
                    correct_answer
                ],
                grading=_none_grading(),
                explanation=(
                    f"Explanation {index}."
                ),
                source_pages=[source_page],
            )
        )

    return Quiz(
        title="Large document quiz",
        questions=questions,
    )


def test_split_page_text_bounds_long_lines():
    chunks = split_page_text(
        "x" * 2_500,
        max_characters=1_000,
    )

    assert [
        len(chunk)
        for chunk in chunks
    ] == [
        1_000,
        1_000,
        500,
    ]


def test_small_document_keeps_all_source_pages():
    pages = [
        _page(
            page_number,
            f"Page {page_number} study material."
            * 10,
        )
        for page_number in range(1, 4)
    ]

    selection = select_document_context(
        pages
    )

    assert selection.truncated is False
    assert selection.source_pages == {
        1,
        2,
        3,
    }
    assert len(selection.chunks) == 3


def test_large_document_context_is_bounded_and_spread():
    pages = [
        _page(
            page_number,
            (
                f"Page {page_number} material. "
                + "x" * 900
            ),
        )
        for page_number in range(1, 11)
    ]

    selection = select_document_context(
        pages,
        max_context_characters=2_100,
        max_chunk_characters=1_000,
    )

    assert selection.truncated is True
    assert (
        selection.selected_character_count
        <= 2_100
    )
    assert 1 in selection.source_pages
    assert 10 in selection.source_pages
    assert len(selection.source_pages) == 2


def test_focus_and_lexical_matches_win_tight_budget():
    pages = [
        _page(
            1,
            "Ordinary networking material. "
            + "x" * 850,
        ),
        _page(
            2,
            "Ordinary database material. "
            + "x" * 850,
        ),
        _page(
            3,
            "TCP retransmission congestion window details. "
            + "x" * 820,
        ),
        _page(
            4,
            "Ordinary testing material. "
            + "x" * 850,
        ),
        _page(
            5,
            "Priority weak area material. "
            + "x" * 850,
        ),
    ]

    selection = select_document_context(
        pages,
        focus_page_numbers=[5],
        query_texts=[
            "How does TCP congestion retransmission work?"
        ],
        max_context_characters=2_000,
        max_chunk_characters=1_000,
    )

    assert selection.source_pages == {
        3,
        5,
    }


def test_generation_sequence_preserves_original_page_count():
    pages = [
        _page(
            page_number,
            f"Page {page_number}. "
            + "x" * 900,
        )
        for page_number in range(1, 11)
    ]

    generation_pages = build_generation_pages(
        pages,
        max_context_characters=2_100,
        max_chunk_characters=1_000,
    )

    iterated_pages = list(
        generation_pages
    )

    assert len(generation_pages) == 10
    assert len(iterated_pages) == 2
    assert {
        page["page_number"]
        for page in iterated_pages
    } == generation_pages.source_pages


def test_large_document_can_reach_quiz_generation(
    monkeypatch,
):
    pages = [
        _page(
            page_number,
            (
                f"Page {page_number} concept material. "
                + "x" * 5_500
            ),
        )
        for page_number in range(1, 31)
    ]

    generation_pages = build_generation_pages(
        pages,
        max_context_characters=50_000,
        max_chunk_characters=6_000,
    )

    assert sum(
        len(page["text"])
        for page in pages
    ) > quiz_service.MAX_AI_CHARACTERS
    assert sum(
        len(page["text"])
        for page in generation_pages
    ) < quiz_service.MAX_AI_CHARACTERS
    assert generation_pages.selection.truncated

    source_page = min(
        generation_pages.source_pages
    )
    quiz = _multiple_choice_quiz(
        source_page
    )
    captured_inputs = []

    class FakeResponses:
        async def parse(
            self,
            *,
            model,
            input,
            text_format,
        ):
            captured_inputs.append(input)
            return SimpleNamespace(
                output_parsed=quiz
            )

    fake_client = SimpleNamespace(
        responses=FakeResponses()
    )

    async def fake_get_openai_client(
        api_key,
    ):
        assert api_key == "test-key"
        return fake_client

    monkeypatch.setenv(
        "OPENAI_API_KEY",
        "test-key",
    )
    monkeypatch.setattr(
        quiz_service,
        "get_openai_client",
        fake_get_openai_client,
    )

    result = asyncio.run(
        quiz_service.generate_quiz_from_pages(
            pages=generation_pages,
            question_count=5,
            difficulty="medium",
            question_type=(
                "multiple_choice"
            ),
        )
    )

    assert result == quiz
    assert len(captured_inputs) == 1

    user_content = captured_inputs[0][1][
        "content"
    ]
    assert (
        f"--- PAGE {source_page} ---"
        in user_content
    )
    assert len(user_content) < 100_000
