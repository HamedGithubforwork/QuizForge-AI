from quiz_service import (
    Quiz,
    QuizQuestion,
    ShortAnswerGradingSpec,
)
from quiz_validation import (
    get_quiz_validation_errors,
)


def grading_none():
    return ShortAnswerGradingSpec(
        grading_version=2,
        grading_mode="none",
        answer_groups=[],
        required_group_count=0,
        numeric_value=0,
        numeric_tolerance=0,
        numeric_unit="",
    )


def concept_grading():
    return ShortAnswerGradingSpec(
        grading_version=2,
        grading_mode="concepts",
        answer_groups=[
            [
                "cognitive behavioural therapy",
                "CBT",
            ],
            [
                "interpersonal therapy",
                "IPT",
            ],
            [
                "behavioural activation",
                "behavioral activation",
                "BA",
            ],
        ],
        required_group_count=3,
        numeric_value=0,
        numeric_tolerance=0,
        numeric_unit="",
    )


def make_mc_question(
    question="Which protocol is reliable?",
):
    return QuizQuestion(
        question_type="multiple_choice",
        question=question,
        choices=[
            "TCP",
            "UDP",
            "ARP",
            "ICMP",
        ],
        correct_index=0,
        correct_answer="TCP",
        accepted_answers=["TCP"],
        grading=grading_none(),
        explanation="The source identifies TCP as reliable.",
        source_pages=[1],
    )


def make_concept_question():
    correct_answer = (
        "Cognitive behavioural therapy, "
        "interpersonal therapy, and "
        "behavioural activation"
    )

    return QuizQuestion(
        question_type="short_answer",
        question=(
            "Name the three first-line "
            "psychological treatments."
        ),
        choices=[],
        correct_index=-1,
        correct_answer=correct_answer,
        accepted_answers=[
            correct_answer,
            "CBT, IPT, and BA",
        ],
        grading=concept_grading(),
        explanation=(
            "The source lists all three treatments."
        ),
        source_pages=[1],
    )


def validate(
    questions,
    *,
    requested_type="mixed",
    page_count=2,
):
    return get_quiz_validation_errors(
        Quiz(
            title="Validation Test",
            questions=questions,
        ),
        question_count=len(questions),
        requested_question_type=requested_type,
        page_count=page_count,
    )


def test_valid_concept_rubric_passes():
    errors = validate(
        [make_concept_question()],
        requested_type="short_answer",
    )

    assert errors == []


def test_concept_rubric_rejects_partial_accepted_answer():
    question = make_concept_question()
    question.accepted_answers.append("CBT")

    errors = validate(
        [question],
        requested_type="short_answer",
    )

    assert any(
        "partially correct accepted answer"
        in error
        for error in errors
    )


def test_concept_rubric_rejects_duplicate_alias_across_groups():
    question = make_concept_question()
    question.grading.answer_groups[1].append(
        "CBT"
    )

    errors = validate(
        [question],
        requested_type="short_answer",
    )

    assert any(
        "reuses the same alias"
        in error
        for error in errors
    )


def test_rejects_correct_answer_missing_from_accepted_answers():
    question = make_concept_question()
    question.accepted_answers = [
        "CBT, IPT, and BA"
    ]

    errors = validate(
        [question],
        requested_type="short_answer",
    )

    assert any(
        "accepted_answers does not include correct_answer"
        in error
        for error in errors
    )


def test_numeric_rubric_accepts_compatible_unit_conversions():
    question = QuizQuestion(
        question_type="short_answer",
        question="What mass is required?",
        choices=[],
        correct_index=-1,
        correct_answer="1 g",
        accepted_answers=[
            "1 g",
            "1000 mg",
        ],
        grading=ShortAnswerGradingSpec(
            grading_version=2,
            grading_mode="numeric",
            answer_groups=[],
            required_group_count=0,
            numeric_value=1,
            numeric_tolerance=0,
            numeric_unit="g",
        ),
        explanation="The source gives a mass of 1 g.",
        source_pages=[1],
    )

    errors = validate(
        [question],
        requested_type="short_answer",
    )

    assert errors == []


def test_numeric_rubric_rejects_wrong_unit_or_target():
    question = QuizQuestion(
        question_type="short_answer",
        question="How long does it take?",
        choices=[],
        correct_index=-1,
        correct_answer="1 kg",
        accepted_answers=["1 kg"],
        grading=ShortAnswerGradingSpec(
            grading_version=2,
            grading_mode="numeric",
            answer_groups=[],
            required_group_count=0,
            numeric_value=60,
            numeric_tolerance=0,
            numeric_unit="s",
        ),
        explanation="The source gives a duration.",
        source_pages=[1],
    )

    errors = validate(
        [question],
        requested_type="short_answer",
    )

    assert any(
        "correct_answer does not satisfy its numeric rubric"
        in error
        for error in errors
    )


def test_non_short_answer_rejects_stray_numeric_grading_data():
    question = make_mc_question()
    question.grading.numeric_unit = "s"
    question.grading.numeric_value = 10

    errors = validate(
        [question],
        requested_type="multiple_choice",
    )

    assert any(
        "numeric rubric data"
        in error
        for error in errors
    )


def test_rejects_duplicate_questions_and_choices():
    first = make_mc_question()
    second = make_mc_question()
    second.choices = [
        "TCP",
        "TCP",
        "ARP",
        "ICMP",
    ]

    errors = validate(
        [first, second],
        requested_type="multiple_choice",
    )

    assert any(
        "duplicates another question"
        in error
        for error in errors
    )
    assert any(
        "duplicate multiple-choice options"
        in error
        for error in errors
    )


def test_rejects_invalid_source_pages():
    question = make_concept_question()
    question.source_pages = [3]

    errors = validate(
        [question],
        requested_type="short_answer",
        page_count=2,
    )

    assert any(
        "invalid source pages"
        in error
        for error in errors
    )
