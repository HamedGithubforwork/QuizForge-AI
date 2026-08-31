import {
  buildAiAnswerReviewCase,
  buildAiAnswerReviewKey,
  shouldRequestAiAnswerReview,
  type AiAnswerReviewCase,
  type AiAnswerReviewDecision,
} from './answerFallback.ts'
import {
  gradeShortAnswer,
} from './shortAnswerGrader.ts'
import type {
  AnswerValue,
  QuestionType,
  QuestionTypeScore,
  QuizQuestion,
  QuizResult,
} from '../types/quiz.ts'

export type AiGradeReviewMap =
  Record<string, AiAnswerReviewDecision>

export function isAttemptQuestionCorrect(
  question: QuizQuestion,
  answer: AnswerValue | undefined,
  aiGradeReviews: AiGradeReviewMap,
) {
  if (
    question.question_type ===
    'short_answer'
  ) {
    if (typeof answer !== 'string') {
      return false
    }

    if (
      gradeShortAnswer(
        question,
        answer,
      ).correct
    ) {
      return true
    }

    return (
      aiGradeReviews[
        buildAiAnswerReviewKey(
          question,
          answer,
        )
      ]?.verdict === 'correct'
    )
  }

  return (
    typeof answer === 'number' &&
    answer === question.correct_index
  )
}

export function getIncorrectQuestionIndexes(
  quiz: QuizResult,
  selectedAnswers: Record<number, AnswerValue>,
  aiGradeReviews: AiGradeReviewMap,
) {
  return quiz.questions
    .map((_, index) => index)
    .filter(
      (index) =>
        !isAttemptQuestionCorrect(
          quiz.questions[index],
          selectedAnswers[index],
          aiGradeReviews,
        ),
    )
}

export function calculateAttemptScore(
  quiz: QuizResult | null,
  selectedAnswers: Record<number, AnswerValue>,
  aiGradeReviews: AiGradeReviewMap,
) {
  if (!quiz) {
    return 0
  }

  return quiz.questions.reduce(
    (score, question, index) =>
      score +
      (
        isAttemptQuestionCorrect(
          question,
          selectedAnswers[index],
          aiGradeReviews,
        )
          ? 1
          : 0
      ),
    0,
  )
}

export function getAttemptTypeScore(
  quiz: QuizResult | null,
  type: QuestionType,
  selectedAnswers: Record<number, AnswerValue>,
  aiGradeReviews: AiGradeReviewMap,
): QuestionTypeScore {
  if (!quiz) {
    return {
      correct: 0,
      total: 0,
    }
  }

  return quiz.questions.reduce<QuestionTypeScore>(
    (score, question, index) => {
      if (question.question_type !== type) {
        return score
      }

      return {
        correct:
          score.correct +
          (
            isAttemptQuestionCorrect(
              question,
              selectedAnswers[index],
              aiGradeReviews,
            )
              ? 1
              : 0
          ),
        total: score.total + 1,
      }
    },
    {
      correct: 0,
      total: 0,
    },
  )
}

export function buildAttemptReviewCases(
  quiz: QuizResult,
  selectedAnswers: Record<number, AnswerValue>,
  questionIndexes: number[],
) {
  return questionIndexes.flatMap(
    (questionIndex): AiAnswerReviewCase[] => {
      const question =
        quiz.questions[questionIndex]
      const answer =
        selectedAnswers[questionIndex]

      if (
        !question ||
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
}

export function mergeAttemptReviewDecisions(
  previous: AiGradeReviewMap,
  quiz: QuizResult,
  reviewCases: AiAnswerReviewCase[],
  decisions: AiAnswerReviewDecision[],
) {
  const next = {
    ...previous,
  }
  const casesByIndex = new Map(
    reviewCases.map((item) => [
      item.question_index,
      item,
    ]),
  )

  decisions.forEach((decision) => {
    const reviewCase =
      casesByIndex.get(
        decision.question_index,
      )
    const question =
      quiz.questions[
        decision.question_index
      ]

    if (!reviewCase || !question) {
      return
    }

    next[
      buildAiAnswerReviewKey(
        question,
        reviewCase.student_answer,
      )
    ] = decision
  })

  return next
}

export function buildQuizForHistory(
  quiz: QuizResult,
  selectedAnswers: Record<number, AnswerValue>,
  aiGradeReviews: AiGradeReviewMap,
): QuizResult {
  return {
    ...quiz,
    questions: quiz.questions.map(
      (question, questionIndex) => {
        const answer =
          selectedAnswers[questionIndex]

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

        if (review?.verdict !== 'correct') {
          return question
        }

        return {
          ...question,
          ai_accepted_answers:
            Array.from(
              new Set([
                ...(
                  question.ai_accepted_answers ??
                  []
                ),
                answer,
              ]),
            ),
        }
      },
    ),
  }
}
