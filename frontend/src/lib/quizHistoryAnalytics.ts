import type {
  QuizHistoryRow,
} from './quizHistory.ts'
import {
  isHistoryQuestionCorrect,
} from './historyQuestionGrader.ts'
import {
  analyzeWeakAreas,
  type WeakAreaAttempt,
} from './weakAreaAnalytics.ts'
import type {
  ShortAnswerGradingSpec,
} from './shortAnswerGrader.ts'

export type HistoryQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type HistoryPracticeFocus = {
  pages: number[]
  questionType: HistoryQuestionType
  avoidQuestions: string[]
  baselinePercent: number
  baselineQuestionCount: number
}

type StoredQuestion = {
  question_type: HistoryQuestionType
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
  explanation: string
  source_pages: number[]
}

type StoredQuiz = {
  title: string
  questions: StoredQuestion[]
}

type StoredAnswers =
  Record<string, number | string>

export type TypeScore = {
  correct: number
  total: number
}

export type TypePerformance = {
  multiple_choice: TypeScore
  true_false: TypeScore
  short_answer: TypeScore
}

export type DocumentWeakness = {
  questionType: HistoryQuestionType
  pages: number[]
  avoidQuestions: string[]
  missedQuestions: number
  baselinePercent: number
  baselineQuestionCount: number
  baselineAttemptCount: number
  baselineReliable: boolean
}

export type CurrentDocumentSummary = {
  attemptCount: number
  weakness: DocumentWeakness | null
}

export type HistoryAnalytics = {
  loadedQuizCount: number
  quizzesCompleted: number
  totalQuestions: number
  averageScore: number
  bestScore: number
  latestScore: number
  typePerformance: TypePerformance
}

export function getDisplayFilename(name: string) {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function getQuestionTypeLabel(type: string) {
  if (type === 'multiple_choice') {
    return 'Multiple Choice'
  }

  if (type === 'true_false') {
    return 'True / False'
  }

  if (type === 'short_answer') {
    return 'Short Answer'
  }

  if (type === 'mixed') {
    return 'Mixed'
  }

  return type
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
    typeof question.question === 'string' &&
    Array.isArray(question.choices) &&
    typeof question.correct_index === 'number' &&
    typeof question.correct_answer === 'string' &&
    Array.isArray(question.accepted_answers) &&
    typeof question.explanation === 'string' &&
    Array.isArray(question.source_pages)
  )
}

function isStoredQuiz(
  value: unknown,
): value is StoredQuiz {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false
  }

  const possibleQuiz = value as {
    title?: unknown
    questions?: unknown
  }

  return (
    typeof possibleQuiz.title === 'string' &&
    Array.isArray(possibleQuiz.questions) &&
    possibleQuiz.questions.every(
      isStoredQuestion,
    )
  )
}

function isStoredAnswers(
  value: unknown,
): value is StoredAnswers {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function createTypePerformance(): TypePerformance {
  return {
    multiple_choice: {
      correct: 0,
      total: 0,
    },
    true_false: {
      correct: 0,
      total: 0,
    },
    short_answer: {
      correct: 0,
      total: 0,
    },
  }
}

export function getTypePercentage(score: TypeScore) {
  if (score.total === 0) {
    return 0
  }

  return Math.round(
    (score.correct / score.total) * 100,
  )
}

export function buildHistoryAnalytics(
  history: QuizHistoryRow[],
  totalHistoryCount: number,
): HistoryAnalytics {
  const loadedQuizCount = history.length
  const totalQuestions = history.reduce(
    (total, item) =>
      total + item.question_count,
    0,
  )
  const averageScore =
    loadedQuizCount > 0
      ? Math.round(
          history.reduce(
            (total, item) =>
              total + item.percentage,
            0,
          ) / loadedQuizCount,
        )
      : 0
  const bestScore =
    loadedQuizCount > 0
      ? Math.max(
          ...history.map(
            (item) => item.percentage,
          ),
        )
      : 0
  const latestScore =
    loadedQuizCount > 0
      ? history[0].percentage
      : 0
  const typePerformance =
    createTypePerformance()

  history.forEach((item) => {
    if (
      !isStoredQuiz(item.quiz_data) ||
      !isStoredAnswers(
        item.selected_answers,
      )
    ) {
      return
    }

    item.quiz_data.questions.forEach(
      (question, questionIndex) => {
        const type =
          question.question_type
        typePerformance[type].total += 1
        const answer =
          item.selected_answers[
            String(questionIndex)
          ]

        if (
          isHistoryQuestionCorrect(
            question,
            answer,
          )
        ) {
          typePerformance[type].correct += 1
        }
      },
    )
  })

  return {
    loadedQuizCount,
    quizzesCompleted: totalHistoryCount,
    totalQuestions,
    averageScore,
    bestScore,
    latestScore,
    typePerformance,
  }
}

export function buildCurrentDocumentSummary(
  currentFilename: string | null,
  documentHistory: QuizHistoryRow[],
): CurrentDocumentSummary | null {
  if (!currentFilename) {
    return null
  }

  const attempts: WeakAreaAttempt[] =
    documentHistory.flatMap((item) => {
      if (
        !isStoredQuiz(item.quiz_data) ||
        !isStoredAnswers(
          item.selected_answers,
        )
      ) {
        return []
      }

      return [
        {
          questions:
            item.quiz_data.questions.map(
              (question, questionIndex) => ({
                questionType:
                  question.question_type,
                question:
                  question.question,
                sourcePages:
                  question.source_pages,
                correct:
                  isHistoryQuestionCorrect(
                    question,
                    item.selected_answers[
                      String(questionIndex)
                    ],
                  ),
              }),
            ),
        },
      ]
    })

  const weakness =
    analyzeWeakAreas(attempts)

  return {
    attemptCount:
      documentHistory.length,
    weakness: weakness
      ? {
          questionType:
            weakness.questionType,
          pages: weakness.pages,
          avoidQuestions:
            weakness.avoidQuestions,
          missedQuestions:
            weakness.missedQuestions,
          baselinePercent:
            weakness.baselinePercent,
          baselineQuestionCount:
            weakness.baselineQuestionCount,
          baselineAttemptCount:
            weakness.baselineAttemptCount,
          baselineReliable:
            weakness.baselineReliable,
        }
      : null,
  }
}
