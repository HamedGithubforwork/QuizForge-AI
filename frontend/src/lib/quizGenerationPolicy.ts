let quizGenerationRequestCount = 0

export function prepareQuizGenerationRequest(
  path: string,
  init: RequestInit,
) {
  if (
    path !== '/api/quizzes/generate' ||
    !(init.body instanceof FormData)
  ) {
    return init
  }

  const shouldForceNewQuiz =
    quizGenerationRequestCount > 0

  quizGenerationRequestCount += 1

  init.body.set(
    'force_new_quiz',
    shouldForceNewQuiz
      ? 'true'
      : 'false',
  )

  return init
}

export function resetQuizGenerationRequestTracking() {
  quizGenerationRequestCount = 0
}
