import {
  gradeShortAnswer,
  normalizeShortAnswer,
  type ShortAnswerGradingSpec,
} from './shortAnswerGrader.ts'

export type HistoryQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type HistoryGradingQuestion = {
  question_type: HistoryQuestionType
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
  ai_accepted_answers?: string[]
}

export function isHistoryQuestionCorrect(
  question: HistoryGradingQuestion,
  answer:
    | number
    | string
    | undefined,
) {
  if (
    question.question_type ===
    'short_answer'
  ) {
    if (typeof answer !== 'string') {
      return false
    }

    const normalizedAnswer =
      normalizeShortAnswer(answer)

    const aiAccepted =
      question.ai_accepted_answers
        ?.some(
          (acceptedAnswer) =>
            normalizeShortAnswer(
              acceptedAnswer,
            ) === normalizedAnswer,
        ) ?? false

    if (aiAccepted) {
      return true
    }

    return gradeShortAnswer(
      question,
      answer,
    ).correct
  }

  return (
    typeof answer === 'number' &&
    answer === question.correct_index
  )
}
