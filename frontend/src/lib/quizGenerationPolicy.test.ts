// @ts-nocheck
import assert from 'node:assert/strict'

import {
  clearCurrentDocumentIdentity,
  rememberCurrentDocumentIdentity,
} from './documentIdentity.ts'
import {
  prepareQuizGenerationRequest,
  resetQuizGenerationRequestTracking,
} from './quizGenerationPolicy.ts'

const documentHash = 'a'.repeat(64)

clearCurrentDocumentIdentity()
resetQuizGenerationRequestTracking()
rememberCurrentDocumentIdentity({
  filename: 'notes.pdf',
  pdf_sha256: documentHash,
})

const firstForm = new FormData()
firstForm.set(
  'file',
  new File(
    ['pdf bytes'],
    'notes.pdf',
    {
      type: 'application/pdf',
    },
  ),
)
firstForm.set('question_count', '5')

prepareQuizGenerationRequest(
  '/api/quizzes/generate',
  {
    method: 'POST',
    body: firstForm,
  },
)

assert.equal(
  firstForm.get('file'),
  null,
  'quiz generation should not retransmit the processed PDF bytes',
)
assert.equal(
  firstForm.get('document_sha256'),
  documentHash,
  'quiz generation should reference the processed document by SHA-256',
)
assert.equal(
  firstForm.get(
    'generate_new_quiz_instead_of_using_cache',
  ),
  'false',
  'the first quiz generation request should explicitly allow the Redis quiz cache',
)

const secondForm = new FormData()
secondForm.set(
  'file',
  new File(
    ['same pdf bytes'],
    'notes.pdf',
    {
      type: 'application/pdf',
    },
  ),
)
secondForm.set('question_count', '5')

prepareQuizGenerationRequest(
  '/api/quizzes/generate',
  {
    method: 'POST',
    body: secondForm,
  },
)

assert.equal(
  secondForm.get('file'),
  null,
  'follow-up generation should also avoid retransmitting the PDF',
)
assert.equal(
  secondForm.get('document_sha256'),
  documentHash,
)
assert.equal(
  secondForm.get(
    'generate_new_quiz_instead_of_using_cache',
  ),
  'true',
  'a follow-up generation request should explicitly generate a new quiz instead of using the cached quiz',
)

clearCurrentDocumentIdentity()
const fallbackForm = new FormData()
fallbackForm.set(
  'file',
  new File(
    ['fallback pdf bytes'],
    'different.pdf',
    {
      type: 'application/pdf',
    },
  ),
)

prepareQuizGenerationRequest(
  '/api/quizzes/generate',
  {
    method: 'POST',
    body: fallbackForm,
  },
)

assert.ok(
  fallbackForm.get('file') instanceof File,
  'the compatibility file path should remain when no processed identity is available',
)
assert.equal(
  fallbackForm.get('document_sha256'),
  null,
)

const uploadForm = new FormData()

prepareQuizGenerationRequest(
  '/api/documents/upload',
  {
    method: 'POST',
    body: uploadForm,
  },
)

assert.equal(
  uploadForm.get(
    'generate_new_quiz_instead_of_using_cache',
  ),
  null,
  'non-generation requests should not be modified',
)

console.log('Quiz generation policy tests passed.')
