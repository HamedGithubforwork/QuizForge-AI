import json

import pymupdf
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from main import (
    analyze_extracted_text,
    app,
    parse_avoid_questions,
    parse_focus_pages,
    parse_focus_question_types,
)


client = TestClient(app)


def make_pdf_bytes(
    text: str = (
        "QuizForge AI test document. "
        "This page contains enough selectable text "
        "to be treated as a normal text-based PDF. "
        "It is intentionally longer than the scanned "
        "PDF detection threshold used by the backend."
    ),
) -> bytes:
    document = pymupdf.open()

    try:
        page = document.new_page()
        page.insert_textbox(
            pymupdf.Rect(
                72,
                72,
                540,
                500,
            ),
            text,
        )

        return document.tobytes()
    finally:
        document.close()


def test_health_endpoint():
    response = client.get(
        "/api/health",
    )

    assert response.status_code == 200
    assert response.json() == {
        "message":
            "Frontend connected to FastAPI!"
    }


def test_upload_rejects_non_pdf():
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "notes.txt",
                b"not a pdf",
                "text/plain",
            )
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Only PDF files are allowed."
    )


def test_upload_extracts_text_from_pdf():
    pdf_bytes = make_pdf_bytes()

    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "notes.pdf",
                pdf_bytes,
                "application/pdf",
            )
        },
    )

    assert response.status_code == 200

    data = response.json()

    assert data["filename"] == "notes.pdf"
    assert data["page_count"] == 1
    assert data["character_count"] > 100
    assert (
        data["extractable_page_count"]
        == 1
    )
    assert data["scanned_likely"] is False
    assert data["warning"] is None

    assert len(data["pages"]) == 1
    assert (
        data["pages"][0]["page_number"]
        == 1
    )
    assert (
        "QuizForge AI test document"
        in data["pages"][0]["text"]
    )


def test_analyze_extracted_text_flags_scan():
    analysis = analyze_extracted_text(
        [
            {
                "page_number": 1,
                "text": "",
            }
        ]
    )

    assert (
        analysis["scanned_likely"]
        is True
    )
    assert (
        analysis["total_characters"]
        == 0
    )
    assert (
        analysis[
            "extractable_page_count"
        ]
        == 0
    )
    assert analysis["warning"]


def test_parse_focus_pages():
    assert parse_focus_pages(
        "5, 3, 3, 1",
        5,
    ) == [1, 3, 5]


@pytest.mark.parametrize(
    "value",
    [
        "0",
        "6",
        "1,9",
        "hello",
    ],
)
def test_parse_focus_pages_rejects_invalid_values(
    value,
):
    with pytest.raises(
        HTTPException,
    ) as error:
        parse_focus_pages(
            value,
            5,
        )

    assert error.value.status_code == 400


def test_parse_focus_question_types():
    assert parse_focus_question_types(
        "multiple_choice,short_answer"
    ) == [
        "multiple_choice",
        "short_answer",
    ]


def test_parse_focus_question_types_rejects_invalid_type():
    with pytest.raises(
        HTTPException,
    ) as error:
        parse_focus_question_types(
            "multiple_choice,essay"
        )

    assert error.value.status_code == 400


def test_parse_avoid_questions():
    value = json.dumps(
        [
            "What is TCP?",
            "What is PATCH?",
        ]
    )

    assert parse_avoid_questions(
        value
    ) == [
        "What is TCP?",
        "What is PATCH?",
    ]


@pytest.mark.parametrize(
    "value",
    [
        "{not valid json",
        '"not a list"',
        "[1, 2, 3]",
    ],
)
def test_parse_avoid_questions_rejects_invalid_values(
    value,
):
    with pytest.raises(
        HTTPException,
    ) as error:
        parse_avoid_questions(
            value
        )

    assert error.value.status_code == 400


def test_generate_rejects_invalid_question_count_without_calling_ai():
    pdf_bytes = make_pdf_bytes()

    response = client.post(
        "/api/quizzes/generate",
        files={
            "file": (
                "notes.pdf",
                pdf_bytes,
                "application/pdf",
            )
        },
        data={
            "question_count": "7",
            "difficulty": "medium",
            "question_type":
                "multiple_choice",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Question count must be "
        "5, 10, or 15."
    )


def test_generate_rejects_invalid_difficulty_without_calling_ai():
    pdf_bytes = make_pdf_bytes()

    response = client.post(
        "/api/quizzes/generate",
        files={
            "file": (
                "notes.pdf",
                pdf_bytes,
                "application/pdf",
            )
        },
        data={
            "question_count": "5",
            "difficulty": "impossible",
            "question_type":
                "multiple_choice",
        },
    )

    assert response.status_code == 400
    assert (
        "Difficulty must be"
        in response.json()["detail"]
    )


def test_generate_rejects_invalid_question_type_without_calling_ai():
    pdf_bytes = make_pdf_bytes()

    response = client.post(
        "/api/quizzes/generate",
        files={
            "file": (
                "notes.pdf",
                pdf_bytes,
                "application/pdf",
            )
        },
        data={
            "question_count": "5",
            "difficulty": "medium",
            "question_type": "essay",
        },
    )

    assert response.status_code == 400
    assert (
        "Question type must be"
        in response.json()["detail"]
    )


def test_generate_rejects_invalid_focus_page_without_calling_ai():
    pdf_bytes = make_pdf_bytes()

    response = client.post(
        "/api/quizzes/generate",
        files={
            "file": (
                "notes.pdf",
                pdf_bytes,
                "application/pdf",
            )
        },
        data={
            "question_count": "5",
            "difficulty": "medium",
            "question_type":
                "multiple_choice",
            "focus_pages": "99",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "One or more focus pages "
        "do not exist in the PDF."
    )
