import type {
  Quiz as ApiQuiz,
  QuizQuestion as ApiQuizQuestion,
  UploadPageSummary as ApiUploadPageSummary,
  UploadResponse as ApiUploadResponse,
} from './api.generated.ts'
import type {
  ShortAnswerGradingSpec,
} from '../lib/shortAnswerGrader'

export type PageResult =
  ApiUploadPageSummary

export type UploadResult =
  ApiUploadResponse

export type QuestionType =
  ApiQuizQuestion['question_type']

export type QuestionMode =
  | QuestionType
  | 'mixed'

export type QuizQuestion =
  Omit<ApiQuizQuestion, 'grading'> & {
    // History can contain older questions created before grading v2.
    grading?: ShortAnswerGradingSpec
    ai_accepted_answers?: string[]
  }

export type QuizResult =
  Omit<ApiQuiz, 'questions'> & {
    questions: QuizQuestion[]
  }

export type GeneratedSettings = {
  questionCount: number
  difficulty: string
  questionType: QuestionMode
}

export type PracticeFocus = {
  pages: number[]
  questionType: QuestionType
}

export type MasteryContext = {
  baselinePercent: number
  baselineQuestionCount: number
  source:
    | 'current_quiz'
    | 'history'
  pages: number[]
  questionType: QuestionType
}

export type AnswerValue =
  | number
  | string

export type QuestionTypeScore = {
  correct: number
  total: number
}
