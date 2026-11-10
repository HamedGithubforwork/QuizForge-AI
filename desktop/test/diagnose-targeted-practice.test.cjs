'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  numericCounters,
  safeResponseDiagnostics,
  safeIssue,
  safeMetric,
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

test('diagnostic summary derives per-response intervals from cumulative event offsets', () => {
  const result = summarize({
    stages: [
      { id: 'warmup', elapsedSeconds: 30, outcome: 'pass', inferenceCalls: [], responses: [], validationIssues: [] },
      {
        id: 'targeted', elapsedSeconds: 84, outcome: 'fail', questionCount: 0,
        distinctQuestionCount: 0, semanticOracle: 'not_run',
        avoidsPriorQuestions: 'not_run',
        responses: [
          { atSeconds: 20, phase: 'generation', generationProfile: 'quiz-mcq-v1' },
          { atSeconds: 52, phase: 'weak-area-recovery', generationProfile: 'quiz-mcq-v1' },
          { atSeconds: 84, phase: 'generation', generationProfile: 'quiz-mcq-retry-v1' },
        ],
        inferenceCalls: [],
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
  assert.equal(result.fixtureId, 'selected_pages_targeted_practice')
  assert.equal(result.targetOutcome, 'fail')
})
