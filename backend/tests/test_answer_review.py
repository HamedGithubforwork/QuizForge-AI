import pytest

from answer_review import (
    AnswerReviewCase,
    AnswerReviewDecision,
    AnswerReviewModelResponse,
    AnswerReviewRequest,
    normalize_review_response,
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
