import type {
  ShortAnswerGradingSpec,
} from '../lib/shortAnswerGrader'

export type PageResult = {
  page_number: number
  character_count: number
  preview: string
  text: string
}

export type UploadResult = {
  filename: string
  page_count: number
  character_count: number
  extractable_page_count: number
  scanned_likely: boolean
  warning: string | null
  pages: PageResult[]
}

export type QuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type QuestionMode =
  | QuestionType
  | 'mixed'

export type QuizQuestion = {
  question_type: QuestionType
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
  ai_accepted_answers?: string[]
  explanation: string
  source_pages: number[]
}

export type QuizResult = {
  title: string
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
