'use strict'

// Credentialless callback/inspector integration test. This is run only after
// the workflow verifies both checked-out commits and before any model download.
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createDiagnosticCallbacks,
  summarize,
} = require('../scripts/diagnose-targeted-practice.cjs')

const appRoot = process.argv[2]
assert.ok(appRoot, 'Usage: node diagnose-targeted-practice.integration.cjs <verified-app-root>')
const { inspectModelResponse } = require(path.join(appRoot, 'desktop/scripts/inspect-synthetic-quiz.cjs'))
const { FIXTURES } = require(path.join(appRoot, 'desktop/scripts/verify-local-product-acceptance.cjs'))
const fixture = FIXTURES.find(item => item.id === 'selected_pages')
assert.ok(fixture, 'The verified app source must include the pinned selected_pages fixture')

const report = {
  setupFailures: [],
  stages: [
    { id: 'warmup', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
    { id: 'targeted', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
  ],
}
const state = { stage: 'targeted', stageStarted: performance.now() - 100 }
const callbacks = createDiagnosticCallbacks({
  report,
  getActiveStage: () => state.stage,
  getStageStarted: () => state.stageStarted,
  getCurrent: () => report.stages.find(stage => stage.id === state.stage),
  started: performance.now() - 500,
  inspectResponse: text => inspectModelResponse(text, fixture),
})

const validQuiz = JSON.stringify({
  title: 'Synthetic diagnostic quiz',
  questions: [
    { question: 'What material makes up the Aster casing?', correct_answer: 'cobalt',
      explanation: 'Aster casing material is cobalt.', source_pages: [2], source_fact: 'Aster casing material is cobalt.' },
    { question: 'What is Aster capacity?', correct_answer: '17 samples',
      explanation: 'Aster capacity is 17 samples.', source_pages: [2], source_fact: 'Aster capacity is 17 samples.' },
    { question: 'What is Aster sampling interval?', correct_answer: 'five hours',
      explanation: 'Aster sampling interval is five hours.', source_pages: [2], source_fact: 'Aster sampling interval is five hours.' },
    { question: 'What material makes up the Boreal casing?', correct_answer: 'glass',
      explanation: 'Boreal casing material is glass.', source_pages: [4], source_fact: 'Boreal casing material is glass.' },
    { question: 'What is Boreal capacity?', correct_answer: '23 samples',
      explanation: 'Boreal capacity is 23 samples.', source_pages: [4], source_fact: 'Boreal capacity is 23 samples.' },
  ],
})

callbacks.onDiagnostic('inference_completed', {
  elapsedMs: 400, prefillMs: 120, decodeMs: 250,
  promptTokens: 300, completionTokens: 64, acceleration: 'cpu',
})
callbacks.onQuizGeneratedResponse({
  profile: 'stop', phase: 'generation', generationProfile: 'quiz-mcq-v1', text: validQuiz,
})
callbacks.onQuizGeneratedResponse({
  profile: 'length', phase: 'generation',
  generationProfile: 'quiz-mcq-v1', text: '{"questions":["PRIVATE_TRUNCATED_OUTPUT',
})
callbacks.onQuizValidationIssue({ attempt: 'primary', reason: 'truncated_output' })
callbacks.onQuizGeneratedResponse({
  profile: 'stop', phase: 'generation', generationProfile: 'quiz-mcq-retry-v1',
  text: '{PRIVATE_MALFORMED_OUTPUT',
})
callbacks.onQuizValidationIssue({ attempt: 'retry', reason: 'json' })
// The #665 recovery callback omits finishReason/profile. Capture unknown rather
// than inferring it from the fact that validation accepted the response.
callbacks.onQuizGeneratedResponse({
  phase: 'weak-area-recovery', generationProfile: 'quiz-mcq-v1', text: validQuiz,
})
callbacks.onDiagnostic('question_rejected', {
  reason: 'unsupported_answer', questionNumber: 4, questionType: 'multiple_choice',
  sourcePages: [2], sourceText: 'PRIVATE_STUDY_NOTES', question: 'PRIVATE_QUESTION',
})
callbacks.onQuizValidationIssue({
  attempt: 'recovery', reason: 'candidate_pool_exhausted',
  details: { survivors: 0, notes: 'PRIVATE_NOTES', prompt: 'PRIVATE_PROMPT' },
})
callbacks.onDiagnostic('runtime_failed', {
  reason: 'timed_out', stage: 'inference', message: 'PRIVATE_ERROR C:\\private\\path',
  credentials: 'PRIVATE_CREDENTIAL',
})

state.stage = null
state.stageStarted = null
callbacks.onDiagnostic('runtime_failed', {
  reason: 'runtime_unavailable', stage: 'startup', message: 'PRIVATE_SETUP_ERROR C:\\private\\model',
})

const serialized = JSON.stringify(report)
const target = report.stages.find(stage => stage.id === 'targeted')
assert.equal(target.responses[0].finishReason, 'stop')
assert.equal(target.responses[0].quality.strictPass, true)
assert.equal(target.responses[0].quality.oracleMatchedQuestions, 5)
assert.equal(target.responses[1].finishReason, 'length')
assert.equal(target.responses[1].quality.status, 'invalid_json')
assert.equal(target.responses[2].quality.status, 'invalid_json')
assert.equal(target.responses[3].finishReason, 'unknown')
assert.deepEqual(target.validationIssues.map(item => item.reason), [
  'truncated_output', 'json', 'candidate_pool_exhausted',
])
assert.deepEqual(target.rejections.map(item => item.reason), ['unsupported_answer'])
assert.equal(target.failures[0].reason, 'timed_out')
assert.equal(report.setupFailures[0].runtimeStage, 'startup')
assert.deepEqual(summarize(report).rejectionCategoryCounts, { unsupported_answer: 1 })
for (const sensitive of [
  'Aster', 'Boreal', 'cobalt', 'PRIVATE_TRUNCATED_OUTPUT', 'PRIVATE_STUDY_NOTES',
  'PRIVATE_QUESTION', 'PRIVATE_NOTES', 'PRIVATE_PROMPT', 'PRIVATE_ERROR',
  'PRIVATE_CREDENTIAL', 'PRIVATE_SETUP_ERROR', 'C:\\private',
]) assert.equal(serialized.includes(sensitive), false, `report leaked ${sensitive}`)

console.log('Synthetic diagnostic callback/inspector integration passed')
