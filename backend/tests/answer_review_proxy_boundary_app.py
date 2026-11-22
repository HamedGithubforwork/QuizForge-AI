"""Isolated CI app for exercising answer-review limits through Caddy.

This app uses the production request model but deliberately has no production
authentication, Redis, or model client. It is only wired into the disposable
Lightsail runtime rehearsal, never into the shipped application.
"""
import json

from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError

from answer_review import (
    ANSWER_REVIEW_USER_PREFIX,
    AnswerReviewCase,
    AnswerReviewRequest,
    serialize_review_cases,
)
from app_shared import answer_review_validation_error_handler


app = FastAPI()
app.add_exception_handler(
    RequestValidationError,
    answer_review_validation_error_handler,
)


def make_case(alias: str) -> AnswerReviewCase:
    return AnswerReviewCase(
        question_index=0,
        question="Which protocol provides reliable delivery?",
        correct_answer="TCP provides reliable delivery.",
        accepted_answers=["TCP"],
        answer_groups=[[alias]],
        required_group_count=1,
        student_answer="reliable transport protocol",
        explanation="TCP provides reliable delivery.",
    )


def make_cases_at_semantic_size(
    target_bytes: int,
    alias_character: str = "é",
) -> list[AnswerReviewCase]:
    case = make_case("")
    base_size = len(
        (
            ANSWER_REVIEW_USER_PREFIX
            + serialize_review_cases([case])
        ).encode("utf-8")
    )
    remaining = target_bytes - base_size
    if remaining < 0:
        raise ValueError("Target is smaller than the minimum request")

    character_width = len(alias_character.encode("utf-8"))
    alias = alias_character * (remaining // character_width)
    if remaining % character_width:
        alias += "x"
    case = make_case(alias)
    semantic_size = len(
        (
            ANSWER_REVIEW_USER_PREFIX
            + serialize_review_cases([case])
        ).encode("utf-8")
    )
    if semantic_size != target_bytes:
        raise AssertionError("Boundary fixture is not exact")
    return [case]


@app.get("/api/health")
def health():
    return {"message": "Synthetic answer-review boundary app"}


@app.get("/api/__test/answer-review-payload")
def answer_review_payload(target_bytes: int, encoding: str = "unicode"):
    if encoding not in {"unicode", "escaped-ascii"}:
        return Response(status_code=400)
    alias_character = "A" if encoding == "escaped-ascii" else "é"
    cases = make_cases_at_semantic_size(target_bytes, alias_character)
    body = json.dumps(
        {"cases": [case.model_dump() for case in cases]},
        ensure_ascii=True,
    )
    if encoding == "escaped-ascii":
        alias = cases[0].answer_groups[0][0]
        escaped_alias = "".join(f"\\u{ord(character):04x}" for character in alias)
        body = body.replace(alias, escaped_alias)
    body = body.encode("utf-8")
    return Response(body, media_type="application/json")


@app.get("/api/__test/answer-review-invalid-unicode")
def answer_review_invalid_unicode_payload():
    # A JSON escape can represent a lone surrogate even though the decoded
    # value cannot be encoded as valid UTF-8. This fixture exercises the real
    # request validator without placing invalid UTF-8 bytes on the wire.
    return Response(
        b'{"cases":[{"question_index":0,"question":"q",'
        b'"correct_answer":"a","accepted_answers":[],"answer_groups":[], '
        b'"required_group_count":1,"student_answer":"\\ud800",'
        b'"explanation":""}]}',
        media_type="application/json",
    )


@app.post("/api/answers/review")
@app.post("/api/answers/review/")
def answer_review(payload: AnswerReviewRequest):
    semantic_bytes = len(
        (
            ANSWER_REVIEW_USER_PREFIX
            + serialize_review_cases(payload.cases)
        ).encode("utf-8")
    )
    return {"accepted": True, "semantic_bytes": semantic_bytes}
