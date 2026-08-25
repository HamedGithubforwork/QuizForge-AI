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

  const shouldGenerateNewQuizInsteadOfUsingCache =
    quizGenerationRequestCount > 0

  quizGenerationRequestCount += 1

  init.body.set(
    'generate_new_quiz_instead_of_using_cache',
    shouldGenerateNewQuizInsteadOfUsingCache
      ? 'true'
      : 'false',
  )

  return init
}

export function resetQuizGenerationRequestTracking() {
  quizGenerationRequestCount = 0
}
