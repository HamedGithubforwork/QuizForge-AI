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

  const shouldRequestFreshQuiz =
    quizGenerationRequestCount > 0

  quizGenerationRequestCount += 1

  if (!shouldRequestFreshQuiz) {
    return init
  }

  init.body.set(
    'fresh_quiz',
    'true',
  )

  return init
}

export function resetQuizGenerationRequestTracking() {
  quizGenerationRequestCount = 0
}
