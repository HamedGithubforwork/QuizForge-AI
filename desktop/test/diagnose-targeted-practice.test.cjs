'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  numericCounters,
  safeResponseDiagnostics,
  safeFinishReason,
  safeFailure,
  safeIssue,
  safeMetric,
  safeSha,
  createDiagnosticCallbacks,
  summarize,
} = require('../scripts/diagnose-targeted-practice.cjs')

test('diagnostic validation capture keeps only allowlisted numeric counters', () => {
  const issue = safeIssue({
    attempt: 'recovery',
    reason: 'candidate_pool_exhausted',
    details: {
      inputCandidates: 12,
      unsupportedAnswers: 3,
      survivors: 2,
      rejectedEvidence: [{ question: 'private question', sourceFact: 'private source' }],
      sourceText: 'private notes',
    },
  }, 'targeted')

  assert.deepEqual(issue, {
    stage: 'targeted',
    attempt: 'recovery',
    reason: 'candidate_pool_exhausted',
    counters: { inputCandidates: 12, unsupportedAnswers: 3, survivors: 2 },
  })
  assert.equal(JSON.stringify(issue).includes('private'), false)
  assert.equal(numericCounters({ unsupportedAnswers: -1, prompt: 'secret' }), null)
  assert.equal(numericCounters({ unsupportedAnswers: 1_000_001 }), null)
})

test('diagnostic inference capture contains only numeric timings and bounded labels', () => {
  const metric = safeMetric({
    elapsedMs: 1200.25,
    prefillMs: 300,
    decodeMs: 800,
    promptTokens: 500,
    completionTokens: 100,
    acceleration: 'cpu',
    prompt: 'private prompt',
    response: 'private response',
  }, 'targeted', performance.now() - 2500)

  assert.equal(metric.stage, 'targeted')
  assert.equal(metric.elapsedMs, 1200.25)
  assert.equal(metric.prefillMs, 300)
  assert.equal(metric.decodeMs, 800)
  assert.equal(metric.promptTokens, 500)
  assert.equal(metric.completionTokens, 100)
  assert.equal(metric.acceleration, 'cpu')
  assert.equal(JSON.stringify(metric).includes('private'), false)

  const overLimit = safeMetric({
    elapsedMs: 1_500_001,
    prefillMs: 1_500_001,
    decodeMs: 1_500_001,
    promptTokens: 1_000_001,
    completionTokens: 1_000_001,
  }, 'targeted', performance.now() - 1_800_000)
  assert.equal(overLimit.elapsedMs, null)
  assert.equal(overLimit.prefillMs, null)
  assert.equal(overLimit.decodeMs, null)
  assert.equal(overLimit.promptTokens, null)
  assert.equal(overLimit.completionTokens, null)
})

test('diagnostic source identities accept only lowercase full Git commit SHAs', () => {
  assert.equal(safeSha('a'.repeat(40)), 'a'.repeat(40))
  for (const value of [undefined, '', 'a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) {
    assert.equal(safeSha(value), 'unknown')
  }
})

test('model-response analysis is reduced to fixture quality counts without question text or fact IDs', () => {
  const safe = safeResponseDiagnostics({
    status: 'has_questions',
    questionCount: 2,
    oracleMatchedQuestions: 1,
    distinctOracleFacts: 1,
    exactQuotedCandidates: 2,
    strictPass: false,
    questions: [
      { reason: 'matched', factId: 'aster_material', question: 'private question' },
      { reason: 'answer_not_in_fixture_aliases', factId: null, question: 'private question' },
    ],
    rawResponse: 'private output',
  })

  assert.deepEqual(safe.reasonCounts, {
    matched: 1,
    answer_not_in_fixture_aliases: 1,
  })
  assert.equal(safe.questionCount, 2)
  assert.equal(JSON.stringify(safe).includes('private'), false)
  assert.equal(JSON.stringify(safe).includes('aster_material'), false)
})

test('short abstention and finish reasons are captured without retaining model text', () => {
  const safe = safeResponseDiagnostics({
    status: 'abstained', questionCount: 0, rawResponse: 'private short output',
    notes: 'private study notes', prompt: 'private prompt',
  })
  assert.equal(safe.status, 'abstained')
  assert.equal(safe.questionCount, 0)
  assert.equal(safeFinishReason({ finishReason: 'stop' }), 'stop')
  assert.equal(safeFinishReason({ profile: 'length' }), 'length')
  assert.equal(safeFinishReason({ finishReason: 'provider-private-path' }), 'unknown')
  assert.equal(safeFinishReason({ profile: 'private prompt' }), 'unknown')
  assert.equal(JSON.stringify(safe).includes('private'), false)
})

test('known parser and oracle failures remain distinct while unknown labels stay other', () => {
  assert.equal(safeIssue({ attempt: 'primary', reason: 'json' }, 'targeted').reason, 'json')
  assert.equal(safeIssue({ attempt: 'retry', reason: 'question_shape' }, 'targeted').reason, 'question_shape')
  assert.equal(safeIssue({ attempt: 'primary', reason: 'truncated_output' }, 'targeted').reason,
    'truncated_output')
  assert.equal(safeIssue({ attempt: 'recovery', reason: 'candidate_pool_exhausted' }, 'targeted').reason,
    'candidate_pool_exhausted')
  assert.equal(safeIssue({ attempt: 'mystery', reason: 'private source text' }, 'targeted').reason, 'other')

  const response = safeResponseDiagnostics({
    status: 'invalid_shape', questions: [
      { reason: 'question_shape', question: 'private question', sourceFactId: 'secret-fact' },
      { reason: 'private parser details', question: 'private question' },
    ],
  })
  assert.deepEqual(response.reasonCounts, { question_shape: 1, other: 1 })
  assert.equal(JSON.stringify(response).includes('private'), false)
  assert.equal(JSON.stringify(response).includes('secret-fact'), false)
})

test('runtime failures keep only allowlisted event and reason codes', () => {
  const timeout = safeFailure('runtime_failed', {
    reason: 'timed_out', stage: 'inference', message: 'private path and token',
  }, 'targeted', performance.now() - 500)
  assert.equal(timeout.event, 'runtime_failed')
  assert.equal(timeout.reason, 'timed_out')
  assert.equal(timeout.stage, 'targeted')
  assert.equal(timeout.runtimeStage, 'inference')

  const invalidResponse = safeFailure('operation_failed', {
    reason: 'invalid_response', error: 'private response body',
  }, 'warmup', performance.now() - 100)
  assert.equal(invalidResponse.reason, 'invalid_response')
  assert.equal(invalidResponse.stage, 'warmup')

  const unknown = safeFailure('operation_failed', { reason: 'private error text' }, 'targeted', performance.now())
  assert.equal(unknown.reason, 'other')
  assert.equal(Object.hasOwn(unknown, 'runtimeStage'), false)
  const untrustedStage = safeFailure('runtime_failed', {
    reason: 'runtime_unavailable', stage: 'private path and credentials',
  }, 'targeted', performance.now())
  assert.equal(Object.hasOwn(untrustedStage, 'runtimeStage'), false)
  assert.equal(safeFailure('inference_completed', { reason: 'timed_out' }, 'targeted', performance.now()), null)
  assert.equal(JSON.stringify([timeout, invalidResponse, unknown, untrustedStage]).includes('private'), false)
})

test('setup failures emitted before a stage starts preserve bounded startup context only', () => {
  const setupFailure = safeFailure('runtime_failed', {
    reason: 'runtime_unavailable',
    stage: 'startup',
    message: 'C:\\private\\model path and token',
    notes: 'private study notes',
  }, 'setup', performance.now() - 250)

  assert.deepEqual(Object.keys(setupFailure).sort(), [
    'atSeconds', 'event', 'reason', 'runtimeStage', 'stage',
  ])
  assert.equal(setupFailure.stage, 'setup')
  assert.equal(setupFailure.event, 'runtime_failed')
  assert.equal(setupFailure.reason, 'runtime_unavailable')
  assert.equal(setupFailure.runtimeStage, 'startup')
  assert.equal(JSON.stringify(setupFailure).includes('private'), false)
  assert.equal(JSON.stringify(setupFailure).includes('token'), false)

  const summary = summarize({ stages: [], setupFailures: [setupFailure] })
  assert.deepEqual(summary.setupFailureCategoryCounts, {
    'runtime_failed:runtime_unavailable': 1,
  })
})

test('wired diagnostic callbacks capture generation, parsing, rejection, recovery and runtime failures safely', () => {
  const report = {
    setupFailures: [],
    stages: [
      { id: 'warmup', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
      { id: 'targeted', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [] },
    ],
  }
  const state = { stage: 'targeted', stageStarted: performance.now() - 1000 }
  const callbacks = createDiagnosticCallbacks({
    report,
    getActiveStage: () => state.stage,
    getStageStarted: () => state.stageStarted,
    getCurrent: () => report.stages.find(stage => stage.id === state.stage),
    started: performance.now() - 2000,
    inspectResponse(text) {
      if (text.includes('PRIVATE_BAD')) {
        return { status: 'invalid_json', questionCount: 0, questions: [{ reason: 'json', raw: text }] }
      }
      return { status: 'has_questions', questionCount: 1, questions: [{ reason: 'matched', question: text }] }
    },
  })

  callbacks.onDiagnostic('inference_completed', {
    elapsedMs: 900, prefillMs: 300, decodeMs: 600,
    promptTokens: 420, completionTokens: 18, acceleration: 'cpu',
    prompt: 'PRIVATE_PROMPT', response: 'PRIVATE_OUTPUT',
  })
  callbacks.onQuizGeneratedResponse({
    profile: 'stop', phase: 'generation', generationProfile: 'quiz-mcq-v1',
    text: 'PRIVATE_QUESTION study note and output path C:\\private\\model',
  })
  callbacks.onDiagnostic('inference_completed', {
    elapsedMs: 1200, promptTokens: 400, completionTokens: 8, acceleration: 'cpu',
  })
  callbacks.onQuizGeneratedResponse({
    finishReason: 'length', phase: 'weak-area-recovery',
    generationProfile: 'quiz-mcq-v1', text: 'PRIVATE_TRUNCATED_OUTPUT',
  })
  callbacks.onQuizGeneratedResponse({
    text: 'PRIVATE_BAD_MODEL_OUTPUT', phase: 'generation', generationProfile: 'unknown-profile',
  })
  callbacks.onQuizValidationIssue({
    attempt: 'primary', reason: 'json', error: 'PRIVATE_ERROR C:\\private\\file',
  })
  callbacks.onDiagnostic('question_rejected', {
    reason: 'unsupported_answer', questionNumber: 4, questionType: 'multiple_choice',
    sourcePages: [1], question: 'PRIVATE_QUESTION', sourceText: 'PRIVATE_NOTES',
  })
  callbacks.onQuizValidationIssue({
    attempt: 'recovery', reason: 'candidate_pool_exhausted', details: {
      survivors: 0, questions: ['PRIVATE_QUESTION'], notes: 'PRIVATE_NOTES',
    },
  })
  callbacks.onDiagnostic('runtime_failed', {
    reason: 'timed_out', stage: 'inference', error: 'PRIVATE_ERROR', token: 'PRIVATE_CREDENTIAL',
  })
  callbacks.onDiagnostic('operation_failed', { reason: 'secret model detail', message: 'PRIVATE_ERROR' })

  state.stage = null
  state.stageStarted = null
  callbacks.onDiagnostic('runtime_failed', {
    reason: 'runtime_unavailable', stage: 'startup', message: 'PRIVATE_SETUP_ERROR C:\\private\\models',
  })

  const serialized = JSON.stringify(report)
  assert.deepEqual(report.stages[1].inferenceCalls.map(item => item.completionTokens), [18, 8])
  assert.deepEqual(report.stages[1].responses.map(item => item.finishReason), ['stop', 'length', 'unknown'])
  assert.equal(report.stages[1].responses[2].quality.status, 'invalid_json')
  assert.deepEqual(report.stages[1].validationIssues.map(item => item.reason), [
    'json', 'candidate_pool_exhausted',
  ])
  assert.deepEqual(report.stages[1].rejections.map(item => item.reason), ['unsupported_answer'])
  assert.deepEqual(report.stages[1].failures.map(item => `${item.event}:${item.reason}`), [
    'runtime_failed:timed_out', 'operation_failed:other',
  ])
  assert.deepEqual(summarize(report).rejectionCategoryCounts, { unsupported_answer: 1 })
  assert.equal(report.setupFailures[0].runtimeStage, 'startup')
  for (const secret of [
    'PRIVATE_PROMPT', 'PRIVATE_OUTPUT', 'PRIVATE_QUESTION', 'PRIVATE_TRUNCATED_OUTPUT',
    'PRIVATE_BAD_MODEL_OUTPUT', 'PRIVATE_NOTES', 'PRIVATE_ERROR', 'PRIVATE_CREDENTIAL',
    'PRIVATE_SETUP_ERROR', 'C:\\private', 'secret model detail',
  ]) assert.equal(serialized.includes(secret), false, `leaked ${secret}`)
})

test('successful recovery remains distinguishable from failed candidate validation', () => {
  const result = summarize({
    stages: [
      { id: 'warmup', elapsedSeconds: 20, outcome: 'pass', inferenceCalls: [], responses: [], validationIssues: [], failures: [] },
      {
        id: 'targeted', elapsedSeconds: 55, outcome: 'pass', questionCount: 5,
        distinctQuestionCount: 5, semanticOracle: 'pass', avoidsPriorQuestions: 'pass',
        responses: [{ atSeconds: 50, phase: 'weak-area-recovery', generationProfile: 'quiz-mcq-v1',
          finishReason: 'stop', quality: { reasonCounts: { matched: 5 } } }],
        inferenceCalls: [],
        validationIssues: [{ attempt: 'recovery', reason: 'repaired' }],
        failures: [],
      },
    ],
  })
  assert.equal(result.targetOutcome, 'pass')
  assert.deepEqual(result.finishReasonCounts, { stop: 1 })
  assert.deepEqual(result.validationCategoryCounts, { repaired: 1 })
  assert.deepEqual(result.responseCategoryCounts, { matched: 5 })
})

test('diagnostic summary derives per-response intervals from cumulative event offsets', () => {
  const result = summarize({
    stages: [
      { id: 'warmup', elapsedSeconds: 30, outcome: 'pass', inferenceCalls: [], responses: [], validationIssues: [] },
      {
        id: 'targeted', elapsedSeconds: 84, outcome: 'fail', questionCount: 0,
        distinctQuestionCount: 0, semanticOracle: 'not_run',
        avoidsPriorQuestions: 'not_run',
        responses: [
          { atSeconds: 20, phase: 'generation', generationProfile: 'quiz-mcq-v1', finishReason: 'stop' },
          { atSeconds: 52, phase: 'weak-area-recovery', generationProfile: 'quiz-mcq-v1', finishReason: 'length' },
          { atSeconds: 84, phase: 'generation', generationProfile: 'quiz-mcq-retry-v1', finishReason: 'stop' },
        ],
        inferenceCalls: [],
        failures: [
          { event: 'runtime_failed', reason: 'timed_out' },
          { event: 'operation_failed', reason: 'quiz_validation_failed' },
        ],
        validationIssues: [
          { attempt: 'primary', reason: 'insufficient_source' },
          { attempt: 'recovery', reason: 'candidate_pool_exhausted', counters: { survivors: 4 } },
        ],
      },
    ],
  })

  assert.deepEqual(result.callIntervals.map(item => item.elapsedSeconds), [20, 32, 32])
  assert.deepEqual(result.validationCategoryCounts, {
    insufficient_source: 1,
    candidate_pool_exhausted: 1,
  })
  assert.deepEqual(result.finishReasonCounts, { stop: 2, length: 1 })
  assert.deepEqual(result.failureCategoryCounts, {
    'runtime_failed:timed_out': 1,
    'operation_failed:quiz_validation_failed': 1,
  })
  assert.equal(result.fixtureId, 'selected_pages_targeted_practice')
  assert.equal(result.targetOutcome, 'fail')
})
