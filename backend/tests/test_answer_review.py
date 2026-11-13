import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app_shared
from answer_review import (
    ANSWER_REVIEW_USER_PREFIX,
    MAX_ANSWER_REVIEW_PAYLOAD_BYTES,
    AnswerReviewCase,
    AnswerReviewDecision,
    AnswerReviewModelResponse,
    AnswerReviewRequest,
    normalize_review_response,
    serialize_review_cases,
)
from app_shared import (
    AuthenticatedUser,
    create_app,
    get_current_user,
)


def make_request():
    return AnswerReviewRequest(
        cases=[
            AnswerReviewCase(
                question_index=2,
                question=(
                    "What therapy focuses on changing unhelpful thoughts?"
                ),
                correct_answer=(
                    "Cognitive behavioural therapy"
                ),
                accepted_answers=[
                    "CBT",
                ],
                answer_groups=[
                    [
                        "cognitive behavioural therapy",
                        "cognitive behavioral therapy",
                        "CBT",
                    ]
                ],
                required_group_count=1,
                student_answer=(
                    "therapy that changes negative thought patterns"
                ),
                explanation=(
                    "CBT targets unhelpful patterns of thought and behaviour."
                ),
            )
        ]
    )


def make_case(**overrides):
    values = {
        "question_index": 0,
        "question": "What is a reliable transport protocol?",
        "correct_answer": "TCP provides reliable ordered delivery.",
        "accepted_answers": ["TCP"],
        "answer_groups": [["reliable delivery", "ordered delivery"]],
        "required_group_count": 1,
        "student_answer": "a reliable transport protocol",
        "explanation": "TCP is reliable and ordered.",
    }
    values.update(overrides)
    return AnswerReviewCase(**values)


def make_request_at_payload_size(target_size):
    groups = []
    alias_slots = []
    for question_index in range(9):
        group_aliases = [""] * 30
        groups.append(group_aliases)
        alias_slots.extend(
            (group_aliases, index)
            for index in range(len(group_aliases))
        )
    cases = [
        make_case(
            question_index=question_index,
            answer_groups=[group_aliases],
        )
        for question_index, group_aliases in enumerate(groups)
    ]

    current_size = len(
        (
            ANSWER_REVIEW_USER_PREFIX
            + serialize_review_cases(cases)
        ).encode("utf-8")
    )
    remaining = target_size - current_size
    for group_aliases, index in alias_slots:
        if remaining <= 0:
            break
        group_aliases[index] = "x" * remaining
        remaining = 0

    assert remaining == 0
    return [
        make_case(
            question_index=question_index,
            answer_groups=[group_aliases],
        )
        for question_index, group_aliases in enumerate(groups)
    ]


def test_high_confidence_correct_is_preserved():
    request = make_request()
    response = AnswerReviewModelResponse(
        decisions=[
            AnswerReviewDecision(
                question_index=2,
                verdict="correct",
                confidence=0.93,
                reason=(
                    "The answer clearly paraphrases the required concept."
                ),
            )
        ]
    )

    normalized = normalize_review_response(
        request,
        response,
    )

    assert normalized.decisions[0].verdict == "correct"
    assert normalized.decisions[0].confidence == 0.93


def test_low_confidence_correct_becomes_uncertain():
    request = make_request()
    response = AnswerReviewModelResponse(
        decisions=[
            AnswerReviewDecision(
                question_index=2,
                verdict="correct",
                confidence=0.72,
                reason="Possibly equivalent.",
            )
        ]
    )

    normalized = normalize_review_response(
        request,
        response,
    )

    assert normalized.decisions[0].verdict == "uncertain"


def test_missing_decision_is_rejected():
    request = make_request()
    response = AnswerReviewModelResponse(
        decisions=[]
    )

    with pytest.raises(ValueError):
        normalize_review_response(
            request,
            response,
        )


def test_unknown_question_index_is_rejected():
    request = make_request()
    response = AnswerReviewModelResponse(
        decisions=[
            AnswerReviewDecision(
                question_index=99,
                verdict="incorrect",
                confidence=0.99,
                reason="Wrong concept.",
            )
        ]
    )

    with pytest.raises(ValueError):
        normalize_review_response(
            request,
            response,
        )


def test_duplicate_request_indexes_are_rejected():
    item = make_request().cases[0]
    request = AnswerReviewRequest(
        cases=[item, item]
    )
    response = AnswerReviewModelResponse(
        decisions=[
            AnswerReviewDecision(
                question_index=2,
                verdict="incorrect",
                confidence=0.95,
                reason="Incomplete.",
            )
        ]
    )

    with pytest.raises(ValueError):
        normalize_review_response(
            request,
            response,
        )


def test_supported_multi_concept_and_alias_variants_remain_valid():
    cases = [
        make_case(
            question_index=0,
            answer_groups=[
                ["reliable", "reliability"],
                ["ordered delivery", "in-order delivery"],
            ],
            required_group_count=2,
        ),
        make_case(
            question_index=1,
            correct_answer="3.14 metres",
            accepted_answers=["3.14 metres", "3.14 meters", "3.14 m"],
            answer_groups=[
                ["3.14 metres", "3.14 meters", "3.14 m"]
            ],
            student_answer="3.14 m",
        ),
        make_case(
            question_index=2,
            correct_answer="Cognitive behavioural therapy",
            accepted_answers=["CBT"],
            answer_groups=[
                [
                    "cognitive behavioural therapy",
                    "cognitive behavioral therapy",
                    "CBT",
                ]
            ],
            student_answer="CBT",
        ),
    ]

    request = AnswerReviewRequest(cases=cases)

    assert len(request.cases) == 3
    assert request.cases[0].required_group_count == 2


def test_long_aliases_remain_compatible_with_prior_unbounded_schema():
    long_alias = "cognitive " + ("behavioural " * 200) + "therapy"
    case = make_case(
        accepted_answers=[long_alias],
        answer_groups=[[long_alias]],
    )

    assert len(case.accepted_answers[0]) > 2000
    assert len(case.answer_groups[0][0]) > 2000


def test_more_than_30_aliases_remain_compatible_with_prior_schema():
    aliases = [f"TCP wording {index}" for index in range(31)]
    case = make_case(answer_groups=[aliases])

    assert len(case.answer_groups[0]) == 31


def test_exact_semantic_payload_reaches_handler_without_model_call(monkeypatch):
    handler_called = False

    async def model_call(request, _user_id):
        nonlocal handler_called
        handler_called = True
        return AnswerReviewModelResponse(
            decisions=[
                AnswerReviewDecision(
                    question_index=case.question_index,
                    verdict="uncertain",
                    confidence=0.5,
                    reason="Synthetic boundary verification.",
                )
                for case in request.cases
            ]
        )

    monkeypatch.setattr(
        app_shared,
        "review_borderline_answers_with_ai",
        model_call,
    )
    exact_cases = make_request_at_payload_size(
        MAX_ANSWER_REVIEW_PAYLOAD_BYTES
    )
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(
        id="test-user",
        email="test@example.com",
    )

    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/answers/review",
                json={"cases": [case.model_dump() for case in exact_cases]},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert handler_called is True


def test_aggregate_payload_limit_accepts_exact_limit_and_rejects_one_more():
    exact_cases = make_request_at_payload_size(
        MAX_ANSWER_REVIEW_PAYLOAD_BYTES
    )
    exact_request = AnswerReviewRequest(cases=exact_cases)
    exact_size = len(
        (
            ANSWER_REVIEW_USER_PREFIX
            + serialize_review_cases(exact_request.cases)
        ).encode("utf-8")
    )
    assert exact_size == MAX_ANSWER_REVIEW_PAYLOAD_BYTES

    oversized_cases = make_request_at_payload_size(
        MAX_ANSWER_REVIEW_PAYLOAD_BYTES + 1
    )
    with pytest.raises(ValidationError):
        AnswerReviewRequest(cases=oversized_cases)


def test_oversized_payload_is_rejected_before_model_client_invocation(
    monkeypatch,
):
    model_client_called = False

    async def model_call(_payload, _user_id):
        nonlocal model_client_called
        model_client_called = True
        raise AssertionError("Oversized request reached model handler")

    monkeypatch.setattr(
        app_shared,
        "review_borderline_answers_with_ai",
        model_call,
    )

    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(
        id="test-user",
        email="test@example.com",
    )
    payload = {
        "cases": [
            case.model_dump()
            for case in make_request_at_payload_size(
                MAX_ANSWER_REVIEW_PAYLOAD_BYTES + 1
            )
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

    assert response.status_code == 422
    assert model_client_called is False


def test_lone_surrogate_returns_safe_422_before_model_call(monkeypatch):
    model_client_called = False

    async def model_call(_payload, _user_id):
        nonlocal model_client_called
        model_client_called = True
        raise AssertionError("Invalid Unicode reached model handler")

    monkeypatch.setattr(
        app_shared,
        "review_borderline_answers_with_ai",
        model_call,
    )
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: AuthenticatedUser(
        id="test-user",
        email="test@example.com",
    )
    body = (
        b'{"cases":[{"question_index":0,"question":"q",'
        b'"correct_answer":"a","accepted_answers":[],"answer_groups":[], '
        b'"required_group_count":1,"student_answer":"\\ud800",'
        b'"explanation":""}]}'
    )

    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/answers/review",
                content=body,
                headers={"Content-Type": "application/json"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    assert b"\\ud800" not in response.content
    assert b"input" not in response.content
    assert model_client_called is False
