// @ts-nocheck
import assert from 'node:assert/strict'

import {
  prepareQuizGenerationRequest,
  resetQuizGenerationRequestTracking,
} from './quizGenerationPolicy.ts'

resetQuizGenerationRequestTracking()

const firstForm = new FormData()
firstForm.set('question_count', '5')

prepareQuizGenerationRequest(
  '/api/quizzes/generate',
  {
    method: 'POST',
    body: firstForm,
  },
)

assert.equal(
  firstForm.get(
    'generate_new_quiz_instead_of_using_cache',
  ),
  'false',
  'the first quiz generation request should explicitly allow the Redis quiz cache',
)

const secondForm = new FormData()
secondForm.set('question_count', '5')

prepareQuizGenerationRequest(
  '/api/quizzes/generate',
  {
    method: 'POST',
    body: secondForm,
  },
)

assert.equal(
  secondForm.get(
    'generate_new_quiz_instead_of_using_cache',
  ),
  'true',
  'a follow-up generation request should explicitly generate a new quiz instead of using the cached quiz',
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
