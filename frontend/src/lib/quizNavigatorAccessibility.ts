export type QuestionNavigationAccessibilityState = {
  isAnswered: boolean
  showResults: boolean
  isCorrect: boolean
}

export function formatQuestionNavigationAccessibleName(
  questionNumber: number,
  state: QuestionNavigationAccessibilityState,
) {
  const status = state.showResults
    ? state.isCorrect
      ? 'correct'
      : 'incorrect'
    : state.isAnswered
      ? 'answered'
      : 'unanswered'

  return `Question ${questionNumber}, ${status}`
}
