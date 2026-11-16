'use strict'

// Credentialless callback/inspector integration test. This is run only after
// the workflow verifies both checked-out commits and before any model download.
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createDiagnosticCallbacks,
  inspectDiagnosticResponse,
  summarize,
} = require('../scripts/diagnose-targeted-practice.cjs')

const appRootInput = process.argv[2]
assert.ok(appRootInput, 'Usage: node diagnose-targeted-practice.integration.cjs <verified-app-root>')
const appRoot = path.resolve(appRootInput)
const { inspectModelResponse } = require(path.join(appRoot, 'desktop/scripts/inspect-synthetic-quiz.cjs'))
const { MODEL_DOWNLOAD_TIMEOUT_MS } = require(path.join(appRoot, 'desktop/src/local-model-store.cjs'))
const { FIXTURES } = require(path.join(appRoot, 'desktop/scripts/verify-local-product-acceptance.cjs'))
const fixture = FIXTURES.find(item => item.id === 'selected_pages')
assert.ok(fixture, 'The verified app source must include the pinned selected_pages fixture')
assert.equal(MODEL_DOWNLOAD_TIMEOUT_MS, 20 * 60 * 1000,
  'Diagnostic-specific preparation must not change the desktop default timeout')

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
  inspectResponse: text => inspectDiagnosticResponse(text, fixture, inspectModelResponse),
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

const legacyInspection = inspectDiagnosticResponse(validQuiz, fixture, inspectModelResponse)
assert.equal(legacyInspection.strictPass, true, 'Legacy correct_answer responses stay supported')

const choicesQuiz = JSON.parse(validQuiz)
for (const question of choicesQuiz.questions) {
  question.choices = [
    'synthetic distractor alpha',
    'synthetic distractor beta',
    question.correct_answer,
    'synthetic distractor gamma',
  ]
  question.correct_index = 2
  delete question.correct_answer
}
const choicesInspection = inspectDiagnosticResponse(JSON.stringify(choicesQuiz), fixture, inspectModelResponse)
assert.equal(choicesInspection.strictPass, true,
  'Valid choices/correct_index responses pass the pinned semantic inspector')
assert.equal(choicesInspection.oracleMatchedQuestions, 5)

const invalidIndexQuiz = structuredClone(choicesQuiz)
invalidIndexQuiz.questions[0].correct_index = 9
const invalidIndexInspection = inspectDiagnosticResponse(JSON.stringify(invalidIndexQuiz), fixture, inspectModelResponse)
assert.equal(invalidIndexInspection.questions[0].reason, 'question_shape')
assert.equal(invalidIndexInspection.strictPass, false)

const missingAnswerQuiz = structuredClone(choicesQuiz)
delete missingAnswerQuiz.questions[0].choices
delete missingAnswerQuiz.questions[0].correct_index
const missingAnswerInspection = inspectDiagnosticResponse(JSON.stringify(missingAnswerQuiz), fixture, inspectModelResponse)
assert.equal(missingAnswerInspection.questions[0].reason, 'question_shape')
assert.equal(missingAnswerInspection.strictPass, false)

const malformedAnswerQuiz = structuredClone(choicesQuiz)
malformedAnswerQuiz.questions[0].correct_answer = null
const malformedAnswerInspection = inspectDiagnosticResponse(JSON.stringify(malformedAnswerQuiz), fixture, inspectModelResponse)
assert.equal(malformedAnswerInspection.questions[0].reason, 'question_shape',
  'An explicitly malformed answer cannot be replaced by diagnostic normalization')
assert.equal(malformedAnswerInspection.strictPass, false)

assert.equal(inspectDiagnosticResponse('{malformed response', fixture, inspectModelResponse).status,
  'invalid_json')

const unsupportedAnswerQuiz = JSON.parse(validQuiz)
unsupportedAnswerQuiz.questions[0].correct_answer = 'unobtanium'
const unsupportedInspection = inspectDiagnosticResponse(JSON.stringify(unsupportedAnswerQuiz), fixture, inspectModelResponse)
assert.equal(unsupportedInspection.questions[0].reason, 'answer_not_in_fixture_aliases')
assert.equal(unsupportedInspection.strictPass, false)

const badCitationQuiz = JSON.parse(validQuiz)
badCitationQuiz.questions[0].source_pages = [4]
const citationInspection = inspectDiagnosticResponse(JSON.stringify(badCitationQuiz), fixture, inspectModelResponse)
assert.equal(citationInspection.questions[0].reason, 'citation_or_answer_context_mismatch')
assert.equal(citationInspection.strictPass, false)

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

// The app exposes no request ID on inference-completed events. Keep ambiguous
// auxiliary calls in a neutral category, consume associations only once, and
// preserve the known quote-selection phase when the response callback supplies it.
const auxiliaryReport = {
  setupFailures: [],
  stages: [
    { id: 'warmup', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
    { id: 'targeted', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
  ],
}
const auxiliaryCallbacks = createDiagnosticCallbacks({
  report: auxiliaryReport,
  getActiveStage: () => 'targeted',
  getStageStarted: () => performance.now() - 25,
  getCurrent: () => auxiliaryReport.stages[1],
  started: performance.now() - 50,
  inspectResponse: text => inspectDiagnosticResponse(text, fixture, inspectModelResponse),
})
const metric = () => ({ elapsedMs: 10, promptTokens: 2, completionTokens: 1, acceleration: 'cpu' })
auxiliaryCallbacks.onDiagnostic('inference_completed', metric())
auxiliaryCallbacks.onDiagnostic('inference_completed', metric())
auxiliaryCallbacks.onQuizGeneratedResponse({
  phase: 'generation', generationProfile: 'quiz-mcq-v1', text: validQuiz,
})
auxiliaryCallbacks.onDiagnostic('inference_completed', metric())
auxiliaryCallbacks.onQuizGeneratedResponse({
  phase: 'weak-area-quote-selection', generationProfile: 'quiz-mcq-v1', text: validQuiz,
})
auxiliaryCallbacks.onQuizGeneratedResponse({
  phase: 'generation', generationProfile: 'quiz-mcq-v1', text: validQuiz,
})
const auxiliaryTarget = auxiliaryReport.stages[1]
assert.deepEqual(auxiliaryTarget.inferenceCalls.map(call => call.callNumber), [1, 2, 3])
assert.deepEqual(auxiliaryTarget.inferenceCalls.map(call => call.responsePhase), [
  'auxiliary_or_unmatched', 'auxiliary_or_unmatched', 'weak-area-quote-selection',
])
assert.equal(auxiliaryTarget.responses.length, 3)
assert.deepEqual(auxiliaryTarget.failures, [], 'Unmatched auxiliary calls are not quiz failures')
assert.equal(summarize(auxiliaryReport).targetOutcome, 'not_run')

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
