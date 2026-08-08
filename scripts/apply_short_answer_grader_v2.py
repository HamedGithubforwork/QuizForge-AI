from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "frontend" / "src" / "App.tsx"
BACKEND = ROOT / "backend" / "main.py"
TESTS = ROOT / "backend" / "tests" / "test_main.py"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected exactly one {label} marker, found {count}."
        )
    return text.replace(old, new, 1)


def patch_app() -> None:
    text = APP.read_text(encoding="utf-8")

    text = replace_once(
        text,
        "import {\n  apiFetch,\n} from './lib/api'\n",
        "import {\n  apiFetch,\n} from './lib/api'\n"
        "import {\n"
        "  gradeShortAnswer,\n"
        "  type ShortAnswerGradingSpec,\n"
        "} from './lib/shortAnswerGrader'\n",
        "App grader import",
    )

    text = replace_once(
        text,
        "  accepted_answers: string[]\n  explanation: string\n",
        "  accepted_answers: string[]\n"
        "  grading?: ShortAnswerGradingSpec\n"
        "  explanation: string\n",
        "QuizQuestion grading type",
    )

    start = text.find("  function normalizeAnswer(\n")
    end = text.find("  function isQuestionCorrect(\n", start)

    if start == -1 or end == -1 or end <= start:
        raise RuntimeError("Could not locate the old short-answer grader block.")

    replacement = """  function isShortAnswerCorrect(
    question: QuizQuestion,
    answer: string,
  ) {
    return gradeShortAnswer(
      question,
      answer,
    ).correct
  }

"""

    text = text[:start] + replacement + text[end:]

    score_marker = """                      const isCorrect =
                        isQuestionCorrect(
                          question,
                          selectedAnswer,
                        )

                      const needsAttention =
"""

    score_replacement = """                      const isCorrect =
                        isQuestionCorrect(
                          question,
                          selectedAnswer,
                        )

                      const shortAnswerGrade =
                        question.question_type ===
                          'short_answer' &&
                        typeof selectedAnswer ===
                          'string'
                          ? gradeShortAnswer(
                              question,
                              selectedAnswer,
                            )
                          : null

                      const needsAttention =
"""

    text = replace_once(
        text,
        score_marker,
        score_replacement,
        "short-answer feedback calculation",
    )

    feedback_marker = """                              {!isCorrect && (
                                <p>
                                  <strong>
                                    Correct
                                    answer:
                                  </strong>{' '}
                                  {
                                    question
                                      .correct_answer
                                  }
                                </p>
                              )}
"""

    feedback_replacement = """                              {question.question_type ===
                                'short_answer' &&
                                shortAnswerGrade &&
                                !shortAnswerGrade.correct &&
                                shortAnswerGrade.totalGroups >
                                  1 && (
                                  <p>
                                    <strong>
                                      Concepts
                                      matched:
                                    </strong>{' '}
                                    {
                                      shortAnswerGrade
                                        .matchedGroups
                                    }{' '}
                                    /{' '}
                                    {
                                      shortAnswerGrade
                                        .requiredGroups
                                    }{' '}
                                    required
                                  </p>
                                )}

                              {question.question_type ===
                                'short_answer' &&
                                shortAnswerGrade
                                  ?.borderline && (
                                  <p>
                                    The wording includes
                                    negation, so the answer
                                    could not be graded
                                    confidently as correct.
                                  </p>
                                )}

                              {!isCorrect && (
                                <p>
                                  <strong>
                                    Correct
                                    answer:
                                  </strong>{' '}
                                  {
                                    question
                                      .correct_answer
                                  }
                                </p>
                              )}
"""

    text = replace_once(
        text,
        feedback_marker,
        feedback_replacement,
        "short-answer feedback UI",
    )

    APP.write_text(text, encoding="utf-8")


def patch_backend() -> None:
    text = BACKEND.read_text(encoding="utf-8")

    text = text.replace(
        'version="0.6.0",',
        'version="0.7.0",',
        1,
    )

    model_marker = """class QuizQuestion(BaseModel):
"""

    model_replacement = """class ShortAnswerGradingSpec(BaseModel):
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
"""

    text = replace_once(
        text,
        model_marker,
        model_replacement,
        "grading model",
    )

    text = replace_once(
        text,
        "    accepted_answers: list[str]\n\n    explanation: str\n",
        "    accepted_answers: list[str]\n\n"
        "    grading: ShortAnswerGradingSpec\n\n"
        "    explanation: str\n",
        "grading field",
    )

    mc_marker = """- accepted_answers should contain the correct answer.
- Incorrect answers should be plausible but clearly wrong.
"""

    mc_replacement = """- accepted_answers should contain the correct answer.
- grading must use grading_version 2 and grading_mode "none".
- grading.answer_groups must be an empty list.
- grading.required_group_count must be 0.
- grading.numeric_value and grading.numeric_tolerance must be 0.
- grading.numeric_unit must be an empty string.
- Incorrect answers should be plausible but clearly wrong.
"""

    text = replace_once(
        text,
        mc_marker,
        mc_replacement,
        "multiple-choice grading prompt",
    )

    tf_marker = """- accepted_answers should contain the correct answer.
- Avoid ambiguous statements.

SHORT ANSWER RULES:
"""

    tf_replacement = """- accepted_answers should contain the correct answer.
- grading must use grading_version 2 and grading_mode "none".
- grading.answer_groups must be an empty list.
- grading.required_group_count must be 0.
- grading.numeric_value and grading.numeric_tolerance must be 0.
- grading.numeric_unit must be an empty string.
- Avoid ambiguous statements.

SHORT ANSWER RULES:
"""

    text = replace_once(
        text,
        tf_marker,
        tf_replacement,
        "true-false grading prompt",
    )

    sa_marker = """- Do not include answers that are only partially correct.
- Do not include unrelated synonyms.
- Keep expected answers short enough to grade automatically.
- Prefer objectively gradable factual answers.
- Do not ask broad essay questions.

REQUESTED MODE:
"""

    sa_replacement = """- Do not include answers that are only partially correct.
- Do not include unrelated synonyms.
- Keep expected answers short enough to grade automatically.
- Prefer objectively gradable factual answers.
- Do not ask broad essay questions.

SHORT ANSWER GRADING RUBRIC:

- grading_version must be 2.
- Choose grading_mode from "concepts", "exact", or "numeric".
- Prefer "concepts" for ordinary factual short answers.
- For "concepts", create one answer_group for every distinct acceptable concept the student may provide.
- Each answer_group contains aliases that mean the SAME concept, such as a full term, a standard abbreviation, spelling variants, or an equivalent wording clearly supported by the PDF.
- Never place two different required concepts in the same answer_group.
- Set required_group_count to the number of distinct concepts the question requires for full credit.
- If the question asks for all listed items, required_group_count should equal the number of required groups.
- If the question asks for any N items from a larger valid set, include groups for the valid options and set required_group_count to N.
- Order must not matter for concept answers.
- A student may mix abbreviations and expanded terms across different concepts.
- Use "exact" only when the whole answer truly needs to match one accepted wording or code-like value. For exact mode, answer_groups must be empty and required_group_count must be 0.
- Use "numeric" when the answer is fundamentally a number. Set numeric_value to the expected value, numeric_tolerance to an appropriate non-negative tolerance supported by the question, and numeric_unit to the unit or an empty string.
- For non-numeric modes, numeric_value and numeric_tolerance must be 0 and numeric_unit must be an empty string.
- For concept mode, numeric_value and numeric_tolerance must be 0 and numeric_unit must be an empty string.
- For numeric mode, answer_groups must be empty and required_group_count must be 0.
- Keep accepted_answers for backward compatibility and include complete fully-correct answer variants there; do not put partially correct fragments in accepted_answers.

REQUESTED MODE:
"""

    text = replace_once(
        text,
        sa_marker,
        sa_replacement,
        "short-answer grading prompt",
    )

    validation_marker = """        types_found.add(
            question.question_type
        )

        if not set(
"""

    validation_replacement = """        types_found.add(
            question.question_type
        )

        grading = question.grading

        if question.question_type != "short_answer":
            if (
                grading.grading_mode != "none"
                or grading.answer_groups
                or grading.required_group_count != 0
            ):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "A non-short-answer question "
                        "returned invalid grading data."
                    ),
                )

        else:
            if grading.grading_mode == "none":
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "A short-answer question "
                        "returned no grading mode."
                    ),
                )

            if grading.grading_mode == "concepts":
                clean_groups = [
                    [
                        alias.strip()
                        for alias in group
                        if alias.strip()
                    ]
                    for group in grading.answer_groups
                ]
                clean_groups = [
                    group
                    for group in clean_groups
                    if group
                ]

                if (
                    not clean_groups
                    or grading.required_group_count < 1
                    or grading.required_group_count
                    > len(clean_groups)
                ):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "A concept-graded short answer "
                            "returned an invalid rubric."
                        ),
                    )

            elif grading.grading_mode in {
                "exact",
                "numeric",
            }:
                if (
                    grading.answer_groups
                    or grading.required_group_count != 0
                ):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "A short-answer question "
                            "returned inconsistent grading data."
                        ),
                    )

        if not set(
"""

    text = replace_once(
        text,
        validation_marker,
        validation_replacement,
        "grading validation",
    )

    BACKEND.write_text(text, encoding="utf-8")


def patch_tests() -> None:
    text = TESTS.read_text(encoding="utf-8")

    if "test_short_answer_grading_schema" in text:
        return

    import_marker = """    AuthenticatedUser,
    analyze_extracted_text,
"""

    import_replacement = """    AuthenticatedUser,
    QuizQuestion,
    ShortAnswerGradingSpec,
    analyze_extracted_text,
"""

    text = replace_once(
        text,
        import_marker,
        import_replacement,
        "test imports",
    )

    tests = r'''


def test_short_answer_grading_schema_accepts_concept_groups():
    question = QuizQuestion(
        question_type="short_answer",
        question="Name the treatments.",
        choices=[],
        correct_index=-1,
        correct_answer=(
            "Cognitive behavioural therapy, interpersonal "
            "therapy, and behavioural activation"
        ),
        accepted_answers=[
            "CBT, IPT, and BA",
        ],
        grading=ShortAnswerGradingSpec(
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
        ),
        explanation="Test explanation",
        source_pages=[1],
    )

    assert question.grading.grading_version == 2
    assert question.grading.required_group_count == 3
    assert len(question.grading.answer_groups) == 3


def test_short_answer_numeric_grading_schema_accepts_tolerance():
    grading = ShortAnswerGradingSpec(
        grading_version=2,
        grading_mode="numeric",
        answer_groups=[],
        required_group_count=0,
        numeric_value=84.2,
        numeric_tolerance=0.1,
        numeric_unit="%",
    )

    assert grading.numeric_value == 84.2
    assert grading.numeric_tolerance == 0.1
    assert grading.numeric_unit == "%"
'''

    TESTS.write_text(
        text.rstrip() + tests + "\n",
        encoding="utf-8",
    )


def main() -> None:
    patch_app()
    patch_backend()
    patch_tests()
    print("Short-answer grader v2 integration applied.")


if __name__ == "__main__":
    main()
