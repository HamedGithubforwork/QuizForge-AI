'use strict'

// One bounded, synthetic-only diagnostic for targeted-practice recovery.
// The report intentionally excludes every prompt, response, question, and note.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const COUNTERS = Object.freeze([
  'inputCandidates', 'avoidedQuestions', 'duplicateQuestions',
  'unsupportedSourceFacts', 'unsupportedAnswers', 'unexpectedOutputScripts',
  'duplicateSourceFacts', 'sourcePageRepairs', 'survivors',
])
const SAFE_REASONS = new Set([
  'insufficient_source', 'quiz_validation_failed', 'unsupported_answer',
  'unsupported_source_fact', 'candidate_pool_exhausted', 'duplicate_source_fact',
  'avoided_question', 'repaired', 'truncated_output', 'generation_failed',
  'runtime_unavailable', 'timed_out',
])
const SAFE_ATTEMPTS = new Set(['primary', 'retry', 'recovery', 'fast_recovery', 'single_question_repair'])
const SAFE_PHASES = new Set(['generation', 'weak-area-recovery', 'weak-area-grounding-repair'])
const SAFE_PROFILES = new Set([
  'quiz-mcq-v1', 'quiz-mcq-retry-v1', 'quiz-mcq-targeted-primary-v1',
  'quiz-mcq-targeted-retry-v1',
])
const SAFE_RESPONSE_REASONS = new Set([
  'oracle_ambiguous', 'duplicate_fact', 'matched', 'oracle_wording_mismatch_candidate',
  'citation_or_answer_context_mismatch', 'answer_not_in_fixture_aliases',
])
const SAFE_SOURCE_BRANCHES = new Set([
  'diagnostic/targeted-practice-stage-timing-20261103',
  'perf/local-practice-minimal-replacement-batch-20261103',
])
const round = value => Math.round(value * 1000) / 1000
const MAX_DIAGNOSTIC_SECONDS = 1500
const MAX_DIAGNOSTIC_TOKENS = 1_000_000
const elapsed = (start, now = performance.now()) =>
  Math.min(MAX_DIAGNOSTIC_SECONDS, round(Math.max(0, now - start) / 1000))

function numericCounters(details) {
  if (!details || typeof details !== 'object') return null
  const counters = Object.fromEntries(COUNTERS
    .filter(key => Number.isSafeInteger(details[key]) && details[key] >= 0 &&
      details[key] <= MAX_DIAGNOSTIC_TOKENS)
    .map(key => [key, details[key]]))
  return Object.keys(counters).length ? counters : null
}

function safeIssue(issue, stage) {
  return {
    stage: stage === 'targeted' ? 'targeted' : 'warmup',
    attempt: SAFE_ATTEMPTS.has(issue?.attempt) ? issue.attempt : 'other',
    reason: SAFE_REASONS.has(issue?.reason) ? issue.reason : 'other',
    ...(numericCounters(issue?.details) ? { counters: numericCounters(issue.details) } : {}),
  }
}

function safeMetric(fields, stage, since) {
  const bounded = key => Number.isFinite(fields?.[key]) && fields[key] >= 0 &&
    fields[key] <= MAX_DIAGNOSTIC_SECONDS * 1000
    ? round(fields[key]) : null
  const integer = key => Number.isSafeInteger(fields?.[key]) && fields[key] >= 0 &&
    fields[key] <= MAX_DIAGNOSTIC_TOKENS
    ? fields[key] : null
  return {
    stage: stage === 'targeted' ? 'targeted' : 'warmup',
    atSeconds: elapsed(since),
    elapsedMs: bounded('elapsedMs'),
    prefillMs: bounded('prefillMs'),
    decodeMs: bounded('decodeMs'),
    promptTokens: integer('promptTokens'),
    completionTokens: integer('completionTokens'),
    acceleration: ['cpu', 'gpu'].includes(fields?.acceleration) ? fields.acceleration : 'unknown',
    responsePhase: 'unmatched',
    generationProfile: 'other',
  }
}

function safeResponseDiagnostics(diagnostics) {
  const reasonCounts = {}
  for (const question of Array.isArray(diagnostics?.questions) ? diagnostics.questions : []) {
    const reason = SAFE_RESPONSE_REASONS.has(question?.reason) ? question.reason : 'other'
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
  }
  return {
    status: ['invalid_text', 'invalid_json', 'invalid_shape', 'abstained', 'has_questions']
      .includes(diagnostics?.status) ? diagnostics.status : 'unknown',
    questionCount: Number.isSafeInteger(diagnostics?.questionCount) && diagnostics.questionCount >= 0
      ? Math.min(diagnostics.questionCount, 20) : 0,
    oracleMatchedQuestions: Number.isSafeInteger(diagnostics?.oracleMatchedQuestions) && diagnostics.oracleMatchedQuestions >= 0
      ? Math.min(diagnostics.oracleMatchedQuestions, 20) : 0,
    distinctOracleFacts: Number.isSafeInteger(diagnostics?.distinctOracleFacts) && diagnostics.distinctOracleFacts >= 0
      ? Math.min(diagnostics.distinctOracleFacts, 20) : 0,
    exactQuotedCandidates: Number.isSafeInteger(diagnostics?.exactQuotedCandidates) && diagnostics.exactQuotedCandidates >= 0
      ? Math.min(diagnostics.exactQuotedCandidates, 20) : 0,
    strictPass: diagnostics?.strictPass === true,
    reasonCounts,
  }
}

function summarize(report) {
  const target = report.stages.find(stage => stage.id === 'targeted')
  const metrics = target?.inferenceCalls ?? []
  const responses = target?.responses ?? []
  const callIntervals = responses.map((response, index) => ({
    responsePhase: response.phase,
    generationProfile: response.generationProfile,
    elapsedSeconds: index === 0
      ? response.atSeconds
      : round(Math.max(0, response.atSeconds - responses[index - 1].atSeconds), 3),
  }))
  const categoryCounts = {}
  for (const issue of target?.validationIssues ?? []) {
    categoryCounts[issue.reason] = (categoryCounts[issue.reason] ?? 0) + 1
  }
  return {
    fixtureId: 'selected_pages_targeted_practice',
    targetElapsedSeconds: target?.elapsedSeconds ?? null,
    targetOutcome: target?.outcome ?? 'not_run',
    questionCount: target?.questionCount ?? 0,
    distinctQuestionCount: target?.distinctQuestionCount ?? 0,
    semanticOracle: target?.semanticOracle ?? 'not_run',
    avoidsPriorQuestions: target?.avoidsPriorQuestions ?? 'not_run',
    callIntervals,
    inferenceCalls: metrics,
    validationCategoryCounts: categoryCounts,
    responseCategoryCounts: (target?.responses ?? []).reduce((total, response) => {
      for (const [reason, count] of Object.entries(response.quality?.reasonCounts ?? {})) {
        total[reason] = (total[reason] ?? 0) + count
      }
      return total
    }, {}),
    validationIssues: target?.validationIssues ?? [],
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Diagnostic requires Windows')
  assert.equal(process.arch, 'x64', 'Diagnostic requires x64 Windows')
  assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
    'Usage: node diagnose-targeted-practice.cjs <runtime-dir> <model-dir> <report.json> [app-root]')

  const runtimeDirectory = path.resolve(process.argv[2])
  const modelDirectory = path.resolve(process.argv[3])
  const output = path.resolve(process.argv[4])
  const appRoot = path.resolve(process.argv[5] ?? path.resolve(__dirname, '../..'))
  const { createWindowsLocalAiStack } = require(path.join(appRoot, 'desktop/src/windows-local-ai-stack.cjs'))
  const { FIXTURES, validateSemanticQuiz } = require(path.join(appRoot, 'desktop/scripts/verify-local-product-acceptance.cjs'))
  const { inspectModelResponse } = require(path.join(appRoot, 'desktop/scripts/inspect-synthetic-quiz.cjs'))
  const fixture = FIXTURES.find(item => item.id === 'selected_pages')
  assert.ok(fixture, 'Missing pinned selected_pages fixture')

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-target-diagnostic-'))
  const started = performance.now()
  const report = {
    schema: 1,
    syntheticOnly: true,
    diagnostic: 'targeted-practice-recovery',
    platform: process.platform,
    architecture: process.arch,
    sourceBranch: SAFE_SOURCE_BRANCHES.has(process.env.QFN_DIAGNOSTIC_SOURCE_REF)
      ? process.env.QFN_DIAGNOSTIC_SOURCE_REF : 'unknown',
    sourceSha: /^[a-f0-9]{40}$/.test(process.env.QFN_DIAGNOSTIC_SOURCE_SHA ?? '')
      ? process.env.QFN_DIAGNOSTIC_SOURCE_SHA : 'unknown',
    modelId: null,
    acceleration: null,
    logicalCpuCount: null,
    totalMemoryBytes: null,
    stages: [
      { id: 'warmup', elapsedSeconds: null, outcome: 'not_run', inferenceCalls: [], responses: [], validationIssues: [] },
      { id: 'targeted', elapsedSeconds: null, outcome: 'not_run', inferenceCalls: [], responses: [], validationIssues: [] },
    ],
    summary: null,
  }
  let activeStage = null
  let stageStarted = null
  let stack = null
  const current = () => report.stages.find(stage => stage.id === activeStage)
  const persist = async () => {
    report.summary = summarize(report)
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }

  try {
    stack = createWindowsLocalAiStack({
      userDataDirectory: profile,
      modelDirectory,
      runtimeDirectory,
      onDiagnostic(event, fields) {
        if (event !== 'inference_completed' || !current() || stageStarted === null) return
        current().inferenceCalls.push(safeMetric(fields, activeStage, stageStarted))
      },
      onQuizGeneratedResponse(response) {
        if (!current() || stageStarted === null) return
        const phase = SAFE_PHASES.has(response?.phase) ? response.phase : 'generation'
        const generationProfile = SAFE_PROFILES.has(response?.generationProfile)
          ? response.generationProfile : 'other'
        current().responses.push({
          atSeconds: elapsed(stageStarted),
          phase,
          generationProfile,
          quality: safeResponseDiagnostics(inspectModelResponse(response?.text, fixture)),
        })
        const unmatched = current().inferenceCalls.findLast(item => item.responsePhase === 'unmatched')
        if (unmatched) {
          unmatched.responsePhase = phase
          unmatched.generationProfile = generationProfile
        }
      },
      onQuizValidationIssue(issue) {
        if (current()) current().validationIssues.push({
          ...safeIssue(issue, activeStage),
          atSeconds: stageStarted === null ? null : elapsed(stageStarted),
        })
      },
    })

    const manager = await stack.load()
    const status = await stack.quizStatus()
    assert.equal(status.available, true, 'Verified model and runtime must be ready')
    assert.equal(status.modelId, 'qwen3-4b-q4-k-m', 'Diagnostic requires the pinned Qwen model')
    assert.equal(manager.capability.acceleration, 'cpu', 'Diagnostic expects CPU inference')
    report.modelId = status.modelId === 'qwen3-4b-q4-k-m' ? status.modelId : 'other'
    report.acceleration = manager.capability.acceleration
  report.logicalCpuCount = Number.isSafeInteger(manager.capability.hardware?.logicalCpuCount) &&
    manager.capability.hardware.logicalCpuCount > 0 && manager.capability.hardware.logicalCpuCount <= 256
    ? manager.capability.hardware.logicalCpuCount : null
  report.totalMemoryBytes = Number.isSafeInteger(manager.capability.hardware?.totalMemoryBytes) &&
    manager.capability.hardware.totalMemoryBytes > 0 &&
    manager.capability.hardware.totalMemoryBytes <= 1_099_511_627_776
    ? manager.capability.hardware.totalMemoryBytes : null

    activeStage = 'warmup'
    stageStarted = performance.now()
    let warmup
    try {
      warmup = await stack.generateQuiz({
        pages: fixture.selectedPages,
        questionCount: 5,
        difficulty: fixture.difficulty,
        questionType: 'multiple_choice',
      })
      validateSemanticQuiz(warmup, fixture)
      report.stages[0].outcome = 'pass'
      report.stages[0].questionCount = warmup.questions.length
      report.stages[0].semanticOracle = 'pass'
    } catch (error) {
      report.stages[0].outcome = 'fail'
      report.stages[0].failureCode = error?.code === 'quiz_validation_failed'
        ? 'quiz_validation_failed' : error?.name === 'AssertionError'
          ? 'semantic_oracle_failed' : 'generation_failed'
      report.stages[0].elapsedSeconds = elapsed(stageStarted)
      report.diagnosticElapsedSeconds = elapsed(started)
      await persist()
      process.exitCode = 1
      return
    }
    report.stages[0].elapsedSeconds = elapsed(stageStarted)

    const avoidQuestions = warmup.questions.slice(0, 2).map(item => item.question)
    const avoided = new Set(avoidQuestions.map(value => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase()))
    activeStage = 'targeted'
    stageStarted = performance.now()
    const target = report.stages[1]
    try {
      const quiz = await stack.generateQuiz({
        pages: fixture.selectedPages,
        questionCount: 5,
        difficulty: 'medium',
        questionType: 'multiple_choice',
        practice: { avoidQuestions },
      })
      target.questionCount = quiz.questions.length
      target.distinctQuestionCount = new Set(quiz.questions
        .map(item => String(item.question).trim().replace(/\s+/g, ' ').toLocaleLowerCase())).size
      validateSemanticQuiz(quiz, fixture)
      target.semanticOracle = 'pass'
      target.avoidsPriorQuestions = quiz.questions.some(item =>
        avoided.has(String(item.question).trim().replace(/\s+/g, ' ').toLocaleLowerCase()))
        ? 'fail' : 'pass'
      assert.equal(target.distinctQuestionCount, quiz.questions.length,
        'Targeted practice must contain unique question wording')
      assert.equal(target.avoidsPriorQuestions, 'pass',
        'Targeted practice must avoid prior questions')
      target.outcome = 'pass'
    } catch (error) {
      target.outcome = 'fail'
      target.failureCode = error?.code === 'quiz_validation_failed'
        ? 'quiz_validation_failed' : error?.name === 'AssertionError'
          ? 'semantic_oracle_failed' : 'generation_failed'
    }
    target.elapsedSeconds = elapsed(stageStarted)
    report.diagnosticElapsedSeconds = elapsed(started)
    await persist()
    console.log('TARGETED PRACTICE DIAGNOSTIC ' + JSON.stringify(report.summary))
    if (target.outcome !== 'pass') process.exitCode = 1
  } catch (error) {
    const safeCode = ['runtime_unavailable', 'model_missing', 'invalid_model', 'runtime_invalid'].includes(error?.code)
      ? error.code : 'diagnostic_setup_failed'
    report.setupOutcome = 'fail'
    report.setupFailureCode = safeCode
    report.diagnosticElapsedSeconds = elapsed(started)
    await persist()
    console.error('Targeted practice diagnostic failed:', safeCode)
    process.exitCode = 1
  } finally {
    await stack?.dispose().catch(() => {})
    await fs.rm(profile, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Targeted practice diagnostic failed: unexpected_error')
    process.exitCode = 1
  })
}

module.exports = {
  numericCounters, safeIssue, safeMetric, safeResponseDiagnostics, summarize,
}
