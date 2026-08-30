import {
  getCurrentDocumentSha256,
} from './documentIdentity'

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

  const sourceFile =
    init.body.get('file')

  if (
    typeof File !== 'undefined' &&
    sourceFile instanceof File
  ) {
    const documentSha256 =
      getCurrentDocumentSha256(
        sourceFile.name,
      )

    if (documentSha256) {
      init.body.delete('file')
      init.body.set(
        'document_sha256',
        documentSha256,
      )
    }
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
