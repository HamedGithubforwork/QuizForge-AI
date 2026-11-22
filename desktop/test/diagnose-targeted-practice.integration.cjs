'use strict'

// Credentialless callback/inspector integration test. This is run only after
// the workflow verifies both checked-out commits and before any model download.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  createDiagnosticCallbacks,
  inspectDiagnosticResponse,
  safeCandidateDiagnostics,
  safeExecutionConditions,
  safeMemoryBytes,
  safeSourceBranch,
  summarize,
} = require('../scripts/diagnose-targeted-practice.cjs')

const appRootInput = process.argv[2]
assert.ok(appRootInput, 'Usage: node diagnose-targeted-practice.integration.cjs <verified-app-root>')
const appRoot = path.resolve(appRootInput)
const { inspectModelResponse } = require(path.join(appRoot, 'desktop/scripts/inspect-synthetic-quiz.cjs'))
const { createLocalQuizService } = require(path.join(appRoot, 'desktop/src/local-quiz-service.cjs'))
const { MODEL_DOWNLOAD_TIMEOUT_MS } = require(path.join(appRoot, 'desktop/src/local-model-store.cjs'))
const { FIXTURES } = require(path.join(appRoot, 'desktop/scripts/verify-local-product-acceptance.cjs'))
const fixture = FIXTURES.find(item => item.id === 'selected_pages')
assert.ok(fixture, 'The verified app source must include the pinned selected_pages fixture')
const stackSource = fs.readFileSync(
  path.join(appRoot, 'desktop/src/windows-local-ai-stack.cjs'), 'utf8',
)
const supportsCandidateDiagnostics =
  /onCandidateDiagnostics\s*=\s*null/.test(stackSource) &&
  /createLocalQuizService\(\{[\s\S]*?onCandidateDiagnostics/.test(stackSource)
if (supportsCandidateDiagnostics) {
  assert.match(stackSource, /onCandidateDiagnostics\s*=\s*null/,
    'The Windows stack exposes an opt-in candidate diagnostics callback')
  assert.match(stackSource, /createLocalQuizService\(\{[\s\S]*?onCandidateDiagnostics/,
    'The Windows stack forwards candidate diagnostics to the local quiz service')
}
assert.equal(MODEL_DOWNLOAD_TIMEOUT_MS, 20 * 60 * 1000,
  'Diagnostic-specific preparation must not change the desktop default timeout')
assert.equal(safeSourceBranch('codex/qwen-targeted-practice-backup-batch-20261120'),
  'codex/qwen-targeted-practice-backup-batch-20261120')
assert.equal(safeSourceBranch('untrusted/arbitrary-branch'), 'unknown')
const executionConditions = safeExecutionConditions({
  QFN_MODEL_SHA256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  QFN_MODEL_BYTES: '2497280256',
  QFN_MODEL_CACHE_STATE: 'hit',
  QFN_RUNTIME_ID: 'llama.cpp-b11317-windows-x64-vulkan',
  QFN_RUNTIME_SHA256: 'b0cb46635aa4a028c272b74dc1966178b57157b4be199985e4d5e62cc6664338',
  QFN_RUNTIME_CACHE_STATE: 'miss',
  QFN_DIAGNOSTIC_RUNNER_IMAGE: 'windows-2025',
}, 'pass')
assert.deepEqual(executionConditions, {
  modelSha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  modelBytes: 2497280256,
  runtimeId: 'llama.cpp-b11317-windows-x64-vulkan',
  runtimeSha256: 'b0cb46635aa4a028c272b74dc1966178b57157b4be199985e4d5e62cc6664338',
  runnerImage: 'windows-2025',
  modelCacheState: 'hit',
  runtimeCacheState: 'miss',
  preparationClass: 'warm',
})
const untrustedConditions = safeExecutionConditions({
  QFN_MODEL_SHA256: 'f'.repeat(64),
  QFN_MODEL_BYTES: '2497280256',
  QFN_MODEL_CACHE_STATE: 'hit',
  QFN_RUNTIME_ID: 'llama.cpp-b11317-windows-x64-vulkan',
  QFN_RUNTIME_SHA256: 'b0cb46635aa4a028c272b74dc1966178b57157b4be199985e4d5e62cc6664338',
  QFN_RUNTIME_CACHE_STATE: 'miss',
  QFN_DIAGNOSTIC_RUNNER_IMAGE: 'untrusted-runner',
}, 'fail')
assert.equal(untrustedConditions.modelSha256, null,
  'unexpected model metadata is omitted rather than forwarded')
assert.equal(untrustedConditions.runnerImage, null,
  'unknown runner labels are omitted rather than forwarded')
assert.equal(untrustedConditions.preparationClass, null,
  'failed warmup is not reported as a prepared targeted run')
assert.equal(safeMemoryBytes(17_174_360_064), 17_174_360_064)
assert.equal(safeMemoryBytes(0), null)
assert.equal(safeMemoryBytes(1_099_511_627_777), null)

const report = {
  setupFailures: [],
  stages: [
    { id: 'warmup', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
    { id: 'targeted', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
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
async function runCandidateDiagnosticsIntegration() {
if (!supportsCandidateDiagnostics) {
  // The normal PR CI regression checks use the older pinned application SHA.
  // Exercise the tools sanitizer there; the manually dispatched workflow runs
  // this same test against the exact candidate app SHA before any model work.
  state.stage = 'targeted'
  state.stageStarted = performance.now() - 10
  callbacks.onCandidateDiagnostics({
    requested: 6,
    accepted: 5,
    rejectedByReason: {
      avoided_question: 1,
      duplicate_question: 0,
      unexpected_output_script: 0,
      unsupported_source_fact: 0,
      unsupported_answer: 0,
      duplicate_source_fact: 0,
      other: 0,
    },
    backupCandidatePathExercised: true,
    prompt: 'PRIVATE_PROMPT',
  })
  assert.deepEqual(summarize(report).candidateDiagnostics, {
    requested: 6,
    accepted: 5,
    rejectedByReason: {
      avoided_question: 1,
      duplicate_question: 0,
      unexpected_output_script: 0,
      unsupported_source_fact: 0,
      unsupported_answer: 0,
      duplicate_source_fact: 0,
      other: 0,
    },
    backupCandidatePathExercised: true,
  })
  assert.equal(JSON.stringify(report).includes('PRIVATE_PROMPT'), false,
    'candidate callback data is projected before entering the report')
  console.log('Synthetic diagnostic sanitizer integration passed; app revision predates candidate callback')
  return
}

state.stage = 'targeted'
state.stageStarted = performance.now() - 50

// Exercise the real application service with a synthetic provider, and pass
// its opt-in candidate callback through the diagnostic sanitizer and summary.
const candidateQuestions = [
  { question: 'What is Aster casing material?', answer: 'cobalt', fact: 'Aster casing material is cobalt.', page: 2 },
  { question: 'What is Aster capacity?', answer: '17 samples', fact: 'Aster capacity is 17 samples.', page: 2 },
  { question: 'When does Aster sample?', answer: 'five hours', fact: 'Aster sampling interval is five hours.', page: 2 },
  { question: 'What is Boreal casing material?', answer: 'glass', fact: 'Boreal casing material is glass.', page: 4 },
  { question: 'What is Boreal capacity?', answer: '23 samples', fact: 'Boreal capacity is 23 samples.', page: 4 },
  { question: 'When does Boreal sample?', answer: 'seven hours', fact: 'Boreal sampling interval is seven hours.', page: 4 },
].map((candidate, index) => ({
  question: candidate.question,
  choices: [candidate.answer, 'synthetic distractor alpha', 'synthetic distractor beta', 'synthetic distractor gamma'],
  correct_index: 0,
  explanation: candidate.fact,
  source_pages: [candidate.page],
  source_fact: candidate.fact,
}))
candidateQuestions[0].question = 'Previously asked?'
const candidateService = createLocalQuizService({
  provider: {
    async generate(request) {
      if (request.generationProfile === 'answer-review-v1') {
        return { finishReason: 'stop', text: '{"duplicates":[]}', usage: null }
      }
      return {
        finishReason: 'stop',
        text: JSON.stringify({ title: 'Synthetic candidates', questions: candidateQuestions }),
        usage: null,
      }
    },
  },
  onCandidateDiagnostics: callbacks.onCandidateDiagnostics,
})
const candidateQuiz = await candidateService.generate({
  pages: fixture.selectedPages,
  practice: { avoidQuestions: ['Previously asked?'] },
  questionCount: 5,
  difficulty: 'medium',
  questionType: 'multiple_choice',
})
assert.equal(candidateQuiz.questions.length, 5)
assert.deepEqual(summarize(report).candidateDiagnostics, {
  requested: 6,
  accepted: 5,
  rejectedByReason: {
    avoided_question: 1,
    duplicate_question: 0,
    unexpected_output_script: 0,
    unsupported_source_fact: 0,
    unsupported_answer: 0,
    duplicate_source_fact: 0,
    other: 0,
  },
  backupCandidatePathExercised: false,
})

// Exercise the optimized strict-recovery replacement loop, then carry its true
// backup-path flag through the same sanitized callback and artifact-summary path.
const replacementReport = {
  setupFailures: [],
  stages: [
    { id: 'warmup', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
    { id: 'targeted', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
  ],
}
const replacementCallbacks = createDiagnosticCallbacks({
  report: replacementReport,
  getActiveStage: () => 'targeted',
  getStageStarted: () => performance.now() - 50,
  getCurrent: () => replacementReport.stages[1],
  started: performance.now() - 100,
  inspectResponse: text => inspectDiagnosticResponse(text, fixture, inspectModelResponse),
})
const recoveryFacts = [
  { page: 2, source: 'Aster casing material is cobalt.', answer: 'cobalt', question: 'What is the Aster casing material?' },
  { page: 2, source: 'Aster capacity is 17 samples.', answer: '17 samples', question: 'What is the Aster capacity?' },
  { page: 2, source: 'Aster sampling interval is five hours.', answer: 'five hours', question: 'What is the Aster sampling interval?' },
  { page: 2, source: 'Aster battery type is lithium.', answer: 'lithium', question: 'What is the Aster battery type?' },
  { page: 2, source: 'Aster lens shape is circular.', answer: 'circular', question: 'What is the Aster lens shape?' },
  { page: 4, source: 'Boreal casing material is glass.', answer: 'glass', question: 'What is the Boreal casing material?' },
  { page: 4, source: 'Boreal capacity is 23 samples.', answer: '23 samples', question: 'What is the Boreal capacity?' },
  { page: 4, source: 'Boreal sampling interval is seven hours.', answer: 'seven hours', question: 'What is the Boreal sampling interval?' },
  { page: 4, source: 'Boreal battery type is nickel.', answer: 'nickel', question: 'What is the Boreal battery type?' },
  { page: 4, source: 'Boreal lens shape is square.', answer: 'square', question: 'What is the Boreal lens shape?' },
]
const recoveryPages = [2, 4].map(pageNumber => ({
  pageNumber,
  text: recoveryFacts.filter(fact => fact.page === pageNumber)
    .map(fact => fact.source).join(' '),
}))
const recoveryCandidates = recoveryFacts.map(fact => ({
  question: fact.question,
  choices: [fact.answer, 'synthetic distractor alpha', 'synthetic distractor beta', 'synthetic distractor gamma'],
  correct_index: 0,
  explanation: fact.source,
  source_pages: [fact.page],
  source_fact: fact.source,
}))
recoveryCandidates[0].question = 'Previously asked?'
recoveryCandidates[1].question = 'Previously asked capacity?'
const recoveryPool = recoveryCandidates.slice(0, 5)
const replacementPool = [recoveryCandidates[0], recoveryCandidates[5], recoveryCandidates[6]]
let replacementCalls = 0
const replacementService = createLocalQuizService({
  provider: {
    async generate(request) {
      replacementCalls++
      if (replacementCalls === 1) {
        assert.equal(request.generationProfile, 'quiz-mcq-v1')
        return {
          finishReason: 'stop',
          text: JSON.stringify({ title: 'Synthetic recovery candidates', questions: recoveryPool }),
          usage: null,
        }
      }
      assert.equal(request.generationProfile, 'quiz-mcq-targeted-retry-v1')
      assert.equal(request.jsonSchema.properties.questions.maxItems, 3)
      return {
        finishReason: 'stop',
        text: JSON.stringify({ title: 'Synthetic replacement candidates', questions: replacementPool }),
        usage: null,
      }
    },
  },
  onCandidateDiagnostics: replacementCallbacks.onCandidateDiagnostics,
})
const replacementQuiz = await replacementService.generate({
  pages: recoveryPages,
  practice: { avoidQuestions: ['Previously asked?', 'Previously asked capacity?'] },
  questionCount: 5,
  difficulty: 'medium',
  questionType: 'multiple_choice',
})
assert.equal(replacementCalls, 2, 'the synthetic case enters one replacement batch')
assert.equal(replacementQuiz.questions.length, 5)
assert.deepEqual(summarize(replacementReport).candidateDiagnostics, {
  requested: 8,
  accepted: 5,
  rejectedByReason: {
    avoided_question: 2,
    duplicate_question: 1,
    unexpected_output_script: 0,
    unsupported_source_fact: 0,
    unsupported_answer: 0,
    duplicate_source_fact: 0,
    other: 0,
  },
  backupCandidatePathExercised: true,
})
assert.equal(summarize(replacementReport).candidateDiagnostics.backupCandidatePathExercised, true,
  'the replacement candidate fills the fifth accepted slot in the sanitized summary')
assert.doesNotMatch(JSON.stringify(replacementReport), /Aster|Boreal|cobalt|PRIVATE/)

const sanitizedCandidate = safeCandidateDiagnostics({
  requested: 6,
  accepted: 5,
  rejectedByReason: {
    avoided_question: 1,
    duplicate_question: 0,
    unexpected_output_script: 0,
    unsupported_source_fact: 0,
    unsupported_answer: 0,
    duplicate_source_fact: 0,
    other: 0,
    private_reason: 1,
  },
  backupCandidatePathExercised: true,
  prompt: 'PRIVATE_PROMPT',
})
assert.equal(sanitizedCandidate, null, 'Unknown rejection categories are not silently discarded')

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
for (const sensitive of [
  'Previously asked?', 'Aster casing material is cobalt.',
  'What is Aster casing material?', 'PRIVATE_PROMPT',
]) assert.equal(serialized.includes(sensitive), false, `candidate diagnostics leaked ${sensitive}`)

console.log('Synthetic diagnostic callback/inspector integration passed')
}

runCandidateDiagnosticsIntegration().catch(error => {
  console.error('Synthetic diagnostic callback/inspector integration failed')
  console.error(error)
  process.exitCode = 1
})
