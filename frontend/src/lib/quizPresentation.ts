import type {
  QuestionMode,
  QuizQuestion,
} from '../types/quiz'

export function getDisplayFilename(
  name: string | null,
) {
  if (!name) {
    return 'Uploaded PDF'
  }

  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function getQuestionTypeLabel(
  type: QuestionMode,
) {
  if (type === 'multiple_choice') {
    return 'Multiple Choice'
  }

  if (type === 'true_false') {
    return 'True / False'
  }

  if (type === 'short_answer') {
    return 'Short Answer'
  }

  return 'Mixed'
}

export function isQuestionAnswered(
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
    return (
      typeof answer === 'string' &&
      answer.trim().length > 0
    )
  }

  return typeof answer === 'number'
}

export function getScoreMessage(
  percentage: number,
) {
  if (percentage >= 90) {
    return 'Excellent work!'
  }

  if (percentage >= 75) {
    return 'Strong result!'
  }

  if (percentage >= 60) {
    return 'Good start — keep practicing.'
  }

  return 'Keep practicing — you are making progress.'
}

export function getMasteryMessage(
  delta: number,
  baselineQuestionCount: number,
) {
  if (baselineQuestionCount < 3) {
    return 'Preliminary comparison only — the baseline has too few questions to show a strong mastery trend yet.'
  }

  if (delta >= 20) {
    return 'Strong improvement — your targeted practice is paying off.'
  }

  if (delta > 0) {
    return 'You improved on your recent weak-area baseline.'
  }

  if (delta === 0) {
    return 'You matched your recent baseline. Another focused round can help.'
  }

  return 'This area still needs practice. Review the explanations and try again.'
}
