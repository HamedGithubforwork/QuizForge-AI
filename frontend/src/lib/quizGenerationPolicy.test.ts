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
  firstForm.get('fresh_quiz'),
  null,
  'the first quiz generation request in a page session may use the Redis quiz cache',
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
  secondForm.get('fresh_quiz'),
  'true',
  'a follow-up generation request should explicitly request a fresh quiz',
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
  uploadForm.get('fresh_quiz'),
  null,
  'non-generation requests should not be modified',
)

console.log('Quiz generation policy tests passed.')
