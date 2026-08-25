from pathlib import Path


BACKEND = Path("backend/main.py")
APP = Path("frontend/src/App.tsx")


def insert_before(text: str, marker: str, addition: str, label: str) -> str:
    if addition in text:
        return text
    index = text.find(marker)
    if index < 0:
        raise SystemExit(f"{label} marker not found")
    return text[:index] + addition + text[index:]


def replace_between(
    text: str,
    start_marker: str,
    end_marker: str,
    replacement: str,
    label: str,
) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"{label} start marker not found")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"{label} end marker not found")
    return text[:start] + replacement + text[end:]


# Backend: import semantic review service and expose authenticated endpoint.
text = BACKEND.read_text()
import_anchor = "from quiz_validation import get_quiz_validation_errors\n"
review_import = """from answer_review import (
    AnswerReviewRequest,
    AnswerReviewResponse,
    review_borderline_answers_with_ai,
)
"""
if review_import not in text:
    if import_anchor not in text:
        raise SystemExit("backend import anchor not found")
    text = text.replace(
        import_anchor,
        import_anchor + review_import,
        1,
    )

review_route = """@app.post(
    "/api/answers/review",
    response_model=AnswerReviewResponse,
)
async def review_borderline_answers(
    payload: AnswerReviewRequest,
    current_user: AuthenticatedUser = Depends(
        get_current_user
    ),
):
    return await review_borderline_answers_with_ai(
        payload,
        current_user.id,
    )


"""
text = insert_before(
    text,
    '@app.post("/api/documents/upload")',
    review_route,
    "answer review route",
)
BACKEND.write_text(text)


# Frontend: imports and types.
text = APP.read_text()
review_import = """import {
  buildAiAnswerReviewCase,
  buildAiAnswerReviewKey,
  shouldRequestAiAnswerReview,
  type AiAnswerReviewDecision,
} from './lib/answerFallback'
"""
text = insert_before(
    text,
    "\ntype PageResult = {",
    review_import + "\n",
    "answer fallback import",
)

if "  ai_accepted_answers?: string[]\n" not in text:
    old = "  grading?: ShortAnswerGradingSpec\n  explanation: string\n"
    new = (
        "  grading?: ShortAnswerGradingSpec\n"
        "  ai_accepted_answers?: string[]\n"
        "  explanation: string\n"
    )
    if old not in text:
        raise SystemExit("quiz question type anchor not found")
    text = text.replace(old, new, 1)

state_block = """  const [
    aiGradeReviews,
    setAiGradeReviews,
  ] = useState<
    Record<string, AiAnswerReviewDecision>
  >({})

  const [
    isReviewingAnswers,
    setIsReviewingAnswers,
  ] = useState(false)

"""
if state_block not in text:
    state_anchor = "  const [saveMessage, setSaveMessage] =\n    useState('')\n\n"
    if state_anchor not in text:
        raise SystemExit("answer review state anchor not found")
    text = text.replace(
        state_anchor,
        state_anchor + state_block,
        1,
    )


# Make all scoring consumers honor a high-confidence semantic approval.
is_question_correct = """  function isQuestionCorrect(
    question: QuizQuestion,
    answer:
      | number
      | string
      | undefined,
  ) {
    if (
      question.question_type ===
      'short_answer'
    ) {
      if (
        typeof answer !== 'string'
      ) {
        return false
      }

      if (
        isShortAnswerCorrect(
          question,
          answer,
        )
      ) {
        return true
      }

      const review =
        aiGradeReviews[
          buildAiAnswerReviewKey(
            question,
            answer,
          )
        ]

      return (
        review?.verdict === 'correct'
      )
    }

    return (
      typeof answer === 'number' &&
      answer ===
        question.correct_index
    )
  }

"""
text = replace_between(
    text,
    "  function isQuestionCorrect(",
    "  function isQuestionAnswered(",
    is_question_correct,
    "isQuestionCorrect",
)


# Check Answers stays deterministic for clear answers and batches only
# plausible concept-mode misses for one semantic second review request.
handle_check = """  async function handleCheckAnswers() {
    if (!quiz || isReviewingAnswers) {
      return
    }

    const indexesToCheck =
      retryQuestionIndexes ??
      quiz.questions.map(
        (_, index) => index,
      )

    const firstUnansweredIndex =
      indexesToCheck.find(
        (questionIndex) =>
          !isQuestionAnswered(
            quiz.questions[
              questionIndex
            ],
            selectedAnswers[
              questionIndex
            ],
          ),
      )

    if (
      firstUnansweredIndex !==
      undefined
    ) {
      setAttentionQuestionIndex(
        firstUnansweredIndex,
      )

      setError(
        `Question ${
          firstUnansweredIndex + 1
        } still needs an answer.`,
      )

      scrollToQuestion(
        firstUnansweredIndex,
        true,
      )
      return
    }

    setAttentionQuestionIndex(null)
    setOpenSourceQuestionIndex(null)
    setError('')
    setSaveMessage('')

    const reviewCases =
      indexesToCheck.flatMap(
        (questionIndex) => {
          const question =
            quiz.questions[
              questionIndex
            ]
          const answer =
            selectedAnswers[
              questionIndex
            ]

          if (
            question.question_type !==
              'short_answer' ||
            typeof answer !== 'string'
          ) {
            return []
          }

          const deterministicGrade =
            gradeShortAnswer(
              question,
              answer,
            )

          if (
            !shouldRequestAiAnswerReview(
              question,
              answer,
              deterministicGrade,
            )
          ) {
            return []
          }

          const reviewCase =
            buildAiAnswerReviewCase(
              questionIndex,
              question,
              answer,
            )

          return reviewCase
            ? [reviewCase]
            : []
        },
      )

    if (reviewCases.length > 0) {
      setIsReviewingAnswers(true)

      try {
        const response = await apiFetch(
          '/api/answers/review',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              cases: reviewCases,
            }),
          },
        )

        const data =
          await response.json() as {
            detail?: string
            decisions?:
              AiAnswerReviewDecision[]
          }

        if (!response.ok) {
          throw new Error(
            data.detail ||
              'Semantic answer review failed.',
          )
        }

        const decisions =
          data.decisions ?? []

        const casesByIndex =
          new Map(
            reviewCases.map(
              (item) => [
                item.question_index,
                item,
              ],
            ),
          )

        setAiGradeReviews(
          (previous) => {
            const next = {
              ...previous,
            }

            decisions.forEach(
              (decision) => {
                const reviewCase =
                  casesByIndex.get(
                    decision.question_index,
                  )

                const question =
                  quiz.questions[
                    decision.question_index
                  ]

                if (
                  !reviewCase ||
                  !question
                ) {
                  return
                }

                next[
                  buildAiAnswerReviewKey(
                    question,
                    reviewCase.student_answer,
                  )
                ] = decision
              },
            )

            return next
          },
        )

        setSaveMessage(
          `${decisions.length} borderline short ${
            decisions.length === 1
              ? 'answer received'
              : 'answers received'
          } a semantic second review.`,
        )
      } catch {
        setSaveMessage(
          'Semantic second review was unavailable; deterministic grading was used.',
        )
      } finally {
        setIsReviewingAnswers(false)
      }
    }

    setShowResults(true)
    setResultSaved(false)

    setTimeout(() => {
      document
        .getElementById(
          'quiz-results',
        )
        ?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
    }, 100)
  }

"""
text = replace_between(
    text,
    "  function handleCheckAnswers() {",
    "  function handleTryAgain() {",
    handle_check,
    "handleCheckAnswers",
)


# Persist only AI-approved wording into that saved question so history and
# weak-area analytics reproduce the score without another API call.
handle_save = """  async function handleSaveResult() {
    if (
      !quiz ||
      !documentResult ||
      !generatedSettings ||
      !showResults
    ) {
      return
    }

    setIsSavingHistory(true)
    setSaveMessage('')

    const quizDataForHistory = {
      ...quiz,
      questions:
        quiz.questions.map(
          (
            question,
            questionIndex,
          ) => {
            const answer =
              selectedAnswers[
                questionIndex
              ]

            if (
              question.question_type !==
                'short_answer' ||
              typeof answer !== 'string'
            ) {
              return question
            }

            const review =
              aiGradeReviews[
                buildAiAnswerReviewKey(
                  question,
                  answer,
                )
              ]

            if (
              review?.verdict !==
              'correct'
            ) {
              return question
            }

            return {
              ...question,
              ai_accepted_answers:
                Array.from(
                  new Set([
                    ...(
                      question
                        .ai_accepted_answers ??
                      []
                    ),
                    answer,
                  ]),
                ),
            }
          },
        ),
    }

    try {
      await saveQuizHistory({
        quizTitle:
          quiz.title,

        sourceFilename:
          documentResult.filename,

        difficulty:
          generatedSettings.difficulty,

        questionType:
          generatedSettings.questionType,

        questionCount:
          quiz.questions.length,

        score,

        percentage,

        quizData:
          quizDataForHistory,

        selectedAnswers,
      })

      setResultSaved(true)

      setSaveMessage(
        'Quiz result saved to your history.',
      )

      setHistoryRefreshKey(
        (previous) =>
          previous + 1,
      )
    } catch (err) {
      setSaveMessage(
        err instanceof Error
          ? err.message
          : 'Could not save quiz result.',
      )
    } finally {
      setIsSavingHistory(false)
    }
  }

"""
text = replace_between(
    text,
    "  async function handleSaveResult() {",
    "  return (\n",
    handle_save,
    "handleSaveResult",
)


# Avoid contradictory deterministic-only warnings after an AI approval.
text = text.replace(
    "                                !shortAnswerGrade.correct &&\n",
    "                                !isCorrect &&\n",
    1,
)
text = text.replace(
    "                                shortAnswerGrade\n                                  ?.borderline && (\n",
    "                                shortAnswerGrade\n                                  ?.borderline &&\n                                !isCorrect && (\n",
    1,
)

# Show activity while a semantic review is in flight.
old_button = """                  <button
                    className="button primary-button check-button"
                    type="button"
                    onClick={
                      handleCheckAnswers
                    }
                  >
                    Check Answers
                  </button>
"""
new_button = """                  <button
                    className="button primary-button check-button"
                    type="button"
                    onClick={
                      handleCheckAnswers
                    }
                    disabled={
                      isReviewingAnswers
                    }
                  >
                    {isReviewingAnswers
                      ? 'Reviewing Answers...'
                      : 'Check Answers'}
                  </button>
"""
if new_button not in text:
    if old_button not in text:
        raise SystemExit("check answers button anchor not found")
    text = text.replace(
        old_button,
        new_button,
        1,
    )

APP.write_text(text)
