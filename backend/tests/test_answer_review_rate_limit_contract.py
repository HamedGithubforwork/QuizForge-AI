from fastapi.testclient import TestClient

import app_shared
from app_shared import (
    AuthenticatedUser,
    create_app,
    get_current_user,
)


async def reject_review(_payload, _user_id):
    from fastapi import HTTPException

    raise HTTPException(
        status_code=429,
        detail=(
            "Too many semantic answer review requests. "
            "Please wait before trying again."
        ),
        headers={
            "Retry-After": "42",
        },
    )


def test_answer_review_endpoint_preserves_429_retry_after(
    monkeypatch,
):
    monkeypatch.setattr(
        app_shared,
        "review_borderline_answers_with_ai",
        reject_review,
    )

    app = create_app()
    app.dependency_overrides[
        get_current_user
    ] = lambda: AuthenticatedUser(
        id="test-user",
        email="test@example.com",
    )

    payload = {
        "cases": [
            {
                "question_index": 0,
                "question": "What is TCP?",
                "correct_answer": (
                    "Transmission Control Protocol"
                ),
                "accepted_answers": [
                    "TCP",
                ],
                "answer_groups": [
                    [
                        "TCP",
                        "Transmission Control Protocol",
                    ]
                ],
                "required_group_count": 1,
                "student_answer": "transport control protocol",
                "explanation": "TCP is the expected term.",
            }
        ]
    }

    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/answers/review",
                json=payload,
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 429
    assert response.headers[
        "Retry-After"
    ] == "42"
    assert response.json()["detail"] == (
        "Too many semantic answer review requests. "
        "Please wait before trying again."
    )
