import unittest
from types import SimpleNamespace

from quiz_validation import get_quiz_validation_errors


def make_concept_question(
    *,
    answer_groups=None,
    accepted_answers=None,
    correct_answer=(
        "Cognitive behavioural therapy, "
        "interpersonal therapy, and "
        "behavioural activation"
    ),
):
    if answer_groups is None:
        answer_groups = [
            ["cognitive behavioural therapy", "CBT"],
            ["interpersonal therapy", "IPT"],
            ["behavioural activation", "BA"],
        ]
    if accepted_answers is None:
        accepted_answers = [
            correct_answer,
            "CBT, IPT, and BA",
        ]

    grading = SimpleNamespace(
        grading_mode="concepts",
        answer_groups=answer_groups,
        required_group_count=3,
        numeric_value=0,
        numeric_tolerance=0,
        numeric_unit="",
    )
    return SimpleNamespace(
        question_type="short_answer",
        question="Name the three first-line psychological treatments?",
        choices=[],
        correct_index=-1,
        correct_answer=correct_answer,
        accepted_answers=accepted_answers,
        grading=grading,
        explanation="The source identifies all three treatments.",
        source_pages=[1],
    )


def validate(question):
    quiz = SimpleNamespace(
        title="Concept validation test",
        questions=[question],
    )
    return get_quiz_validation_errors(
        quiz,
        question_count=1,
        requested_question_type="short_answer",
        page_count=1,
    )


class ConceptAnswerNormalizationTests(unittest.TestCase):
    def test_valid_multi_group_answers_pass(self):
        self.assertEqual(
            validate(make_concept_question()),
            [],
        )

    def test_partial_accepted_answer_is_rejected(self):
        question = make_concept_question(
            accepted_answers=[
                "Cognitive behavioural therapy, "
                "interpersonal therapy, and "
                "behavioural activation",
                "CBT",
            ]
        )

        errors = validate(question)

        self.assertTrue(
            any(
                "partially correct accepted answer" in error
                for error in errors
            )
        )

    def test_normalized_alias_reused_across_groups_is_rejected(self):
        question = make_concept_question(
            answer_groups=[
                ["cognitive behavioural therapy", "CBT"],
                ["interpersonal therapy", "IPT", "cbt"],
                ["behavioural activation", "BA"],
            ]
        )

        errors = validate(question)

        self.assertTrue(
            any(
                "reuses the same alias across different concept groups" in error
                for error in errors
            )
        )

    def test_unicode_and_spelling_normalization_are_preserved(self):
        answer = "Cafe\u0301 and behaviour"
        question = make_concept_question(
            answer_groups=[
                ["CAFÉ"],
                ["behavior"],
                ["cafe\u0301 behaviour"],
            ],
            accepted_answers=[answer],
            correct_answer=answer,
        )
        question.grading.required_group_count = 2

        self.assertEqual(
            validate(question),
            [],
        )


if __name__ == "__main__":
    unittest.main()
