import {
  isHistoryQuestionCorrect,
  type HistoryGradingQuestion,
} from './historyQuestionGrader.ts'
import type {
  QuizHistoryRow,
} from './quizHistory.ts'
import type {
  ShortAnswerGradingSpec,
} from './shortAnswerGrader.ts'

export const MISSED_QUESTIONS_LIMIT =
  20

export type MissedStudyQuestion = {
  id: string
  question_type:
    | 'multiple_choice'
    | 'true_false'
    | 'short_answer'
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  explanation: string
  source_pages: number[]
  source_filename: string
  missed_at: string
  student_answer:
    | number
    | string
    | null
}

type StoredQuestion =
  HistoryGradingQuestion & {
    question: string
    choices: string[]
    explanation: string
    source_pages: number[]
    grading?: ShortAnswerGradingSpec
    ai_accepted_answers?: string[]
  }

type StoredQuiz = {
  title: string
  questions: StoredQuestion[]
}

function isStringArray(
  value: unknown,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string',
    )
  )
}

function isPageArray(
  value: unknown,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Number.isInteger(item) &&
        item > 0,
    )
  )
}

function isStoredQuestion(
  value: unknown,
): value is StoredQuestion {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false
  }

  const question =
    value as Partial<StoredQuestion>

  return (
    (
      question.question_type ===
        'multiple_choice' ||
      question.question_type ===
        'true_false' ||
      question.question_type ===
        'short_answer'
    ) &&
    typeof question.question ===
      'string' &&
    isStringArray(
      question.choices,
    ) &&
    typeof question.correct_index ===
      'number' &&
    Number.isInteger(
      question.correct_index,
    ) &&
    typeof question.correct_answer ===
      'string' &&
    isStringArray(
      question.accepted_answers,
    ) &&
    typeof question.explanation ===
      'string' &&
    isPageArray(
      question.source_pages,
    )
  )
}

function storedQuiz(
  value: unknown,
): StoredQuiz | null {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return null
  }

  const possible =
    value as {
      title?: unknown
      questions?: unknown
    }

  if (
    typeof possible.title !==
      'string' ||
    !Array.isArray(
      possible.questions,
    ) ||
    !possible.questions.every(
      isStoredQuestion,
    )
  ) {
    return null
  }

  return {
    title:
      possible.title,
    questions:
      possible.questions,
  }
}

function evidenceKey(
  item: QuizHistoryRow,
  question: StoredQuestion,
) {
  const document =
    item.document_sha256 ??
    item.source_filename
      .trim()
      .toLocaleLowerCase()

  return [
    document,
    question.question_type,
    question.question
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase(),
  ].join('\u0000')
}

function sortedHistory(
  history: QuizHistoryRow[],
) {
  return [...history].sort(
    (left, right) => {
      const timeDifference =
        Date.parse(
          right.created_at,
        ) -
        Date.parse(
          left.created_at,
        )

      if (
        Number.isFinite(
          timeDifference,
        ) &&
        timeDifference !== 0
      ) {
        return timeDifference
      }

      return right.id.localeCompare(
        left.id,
      )
    },
  )
}

export function missedStudyQuestions(
  history: QuizHistoryRow[],
  limit =
    MISSED_QUESTIONS_LIMIT,
): MissedStudyQuestion[] {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new RangeError(
      'Missed Questions limit must be between 1 and 50.',
    )
  }

  const seen =
    new Set<string>()
  const result:
    MissedStudyQuestion[] = []

  for (
    const item
    of sortedHistory(history)
  ) {
    const quiz =
      storedQuiz(
        item.quiz_data,
      )

    if (!quiz) {
      continue
    }

    for (
      let index = 0;
      index <
      quiz.questions.length;
      index += 1
    ) {
      const question =
        quiz.questions[index]
      const key =
        evidenceKey(
          item,
          question,
        )

      if (
        seen.has(key)
      ) {
        continue
      }

      seen.add(key)

      const answer =
        item.selected_answers[
          String(index)
        ]

      if (
        isHistoryQuestionCorrect(
          question,
          answer,
        )
      ) {
        continue
      }

      result.push({
        id:
          `${item.id}:${index}`,
        question_type:
          question.question_type,
        question:
          question.question,
        choices:
          question.choices,
        correct_index:
          question.correct_index,
        correct_answer:
          question.correct_answer,
        explanation:
          question.explanation,
        source_pages:
          question.source_pages,
        source_filename:
          item.source_filename,
        missed_at:
          item.created_at,
        student_answer:
          answer ?? null,
      })

      if (
        result.length >= limit
      ) {
        return result
      }
    }
  }

  return result
}

export function missedAnswerLabel(
  item: MissedStudyQuestion,
): string {
  if (
    item.student_answer === null
  ) {
    return 'No answer saved'
  }

  if (
    typeof item.student_answer ===
      'number'
  ) {
    return (
      item.choices[
        item.student_answer
      ] ??
      `Choice ${
        item.student_answer + 1
      }`
    )
  }

  const clean =
    item.student_answer.trim()

  return (
    clean ||
    'Blank answer'
  )
}
