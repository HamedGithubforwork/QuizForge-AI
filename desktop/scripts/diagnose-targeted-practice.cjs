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
  'runtime_unavailable', 'timed_out', 'cancelled', 'invalid_response',
  'invalid_request', 'request_failed', 'response_too_large', 'runtime_invalid',
  'model_missing', 'invalid_model', 'capability_failed', 'busy', 'source_too_large',
  'shutdown_failed', 'invalid_provider', 'invalid_capability', 'invalid_model_store',
  'invalid_model_status', 'invalid_model_progress', 'insufficient_disk',
  'invalid_download', 'unapproved_download', 'unsafe_model', 'model_store_failed',
  'unsupported_platform', 'unsupported_quiz_mode', 'review_context_missing',
  'json', 'top_level_shape', 'invalid_abstention',
  'question_count', 'question_shape', 'unexpected_output_script',
  'true_false_shape', 'multiple_choice_shape', 'short_answer_format',
  'short_answer_unsupported_answer', 'source_fact_shape', 'duplicate_choices',
  'duplicate_question', 'insufficient_source_facts', 'mixed_type_coverage',
  'requested_type_mismatch',
])
const SAFE_ATTEMPTS = new Set([
  'primary', 'retry', 'recovery', 'fast_recovery', 'single_question_repair', 'batch',
])
const SAFE_PHASES = new Set([
  'generation', 'weak-area-recovery', 'weak-area-grounding-repair', 'weak-area-quote-selection',
])
const SAFE_PROFILES = new Set([
  'quiz-mcq-v1', 'quiz-mcq-retry-v1', 'quiz-mcq-targeted-primary-v1',
  'quiz-mcq-targeted-retry-v1',
])
const SAFE_RESPONSE_REASONS = new Set([
  'oracle_ambiguous', 'duplicate_fact', 'matched', 'oracle_wording_mismatch_candidate',
  'citation_or_answer_context_mismatch', 'answer_not_in_fixture_aliases', 'question_shape',
])
const SAFE_FINISH_REASONS = new Set(['stop', 'length'])
const SAFE_CANDIDATE_REASONS = Object.freeze([
  'avoided_question',
  'duplicate_question',
  'unexpected_output_script',
  'unsupported_source_fact',
  'unsupported_answer',
  'duplicate_source_fact',
  'other',
])
const MAX_CANDIDATE_COUNT = 12
const SAFE_FAILURE_EVENTS = new Set(['operation_failed', 'runtime_failed'])
const SAFE_RUNTIME_STAGES = new Set(['verification', 'startup', 'inference', 'cleanup'])
const SAFE_SOURCE_BRANCHES = new Set([
  'diagnostic/targeted-practice-stage-timing-20261103',
  'perf/local-practice-minimal-replacement-batch-20261103',
  'codex/qwen-targeted-practice-backup-batch-20261120',
])
const round = value => Math.round(value * 1000) / 1000
const MAX_DIAGNOSTIC_SECONDS = 1500
const MAX_DIAGNOSTIC_TOKENS = 1_000_000
const MAX_RESPONSE_TEXT_CHARS = 80_000
const MAX_REPORT_MEMORY_BYTES = 1_099_511_627_776
const MODEL_METADATA = Object.freeze({
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  bytes: 2_497_280_256,
})
const RUNTIME_METADATA = Object.freeze({
  id: 'llama.cpp-b11317-windows-x64-vulkan',
  archiveSha256: 'b0cb46635aa4a028c272b74dc1966178b57157b4be199985e4d5e62cc6664338',
})
const SAFE_RUNNER_IMAGES = new Set(['windows-2025'])
const elapsed = (start, now = performance.now()) =>
  Math.min(MAX_DIAGNOSTIC_SECONDS, round(Math.max(0, now - start) / 1000))

function safeMemoryBytes(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_REPORT_MEMORY_BYTES
    ? value : null
}

function safeExecutionConditions(env, warmupOutcome) {
  const modelCacheState = ['hit', 'miss'].includes(env?.QFN_MODEL_CACHE_STATE)
    ? env.QFN_MODEL_CACHE_STATE : null
  const runnerImage = SAFE_RUNNER_IMAGES.has(env?.QFN_DIAGNOSTIC_RUNNER_IMAGE)
    ? env.QFN_DIAGNOSTIC_RUNNER_IMAGE : null
  const runtimeCacheState = env?.QFN_RUNTIME_CACHE_STATE === 'miss' ? 'miss' : null
  const validModel = env?.QFN_MODEL_SHA256 === MODEL_METADATA.sha256 &&
    String(env?.QFN_MODEL_BYTES) === String(MODEL_METADATA.bytes)
  const validRuntime = env?.QFN_RUNTIME_ID === RUNTIME_METADATA.id &&
    env?.QFN_RUNTIME_SHA256 === RUNTIME_METADATA.archiveSha256

  return Object.freeze({
    modelSha256: validModel ? MODEL_METADATA.sha256 : null,
    modelBytes: validModel ? MODEL_METADATA.bytes : null,
    runtimeId: validRuntime ? RUNTIME_METADATA.id : null,
    runtimeSha256: validRuntime ? RUNTIME_METADATA.archiveSha256 : null,
    runnerImage,
    modelCacheState,
    runtimeCacheState,
    preparationClass: warmupOutcome === 'pass' ? 'warm' : null,
  })
}

function numericCounters(details) {
  if (!details || typeof details !== 'object') return null
  const counters = Object.fromEntries(COUNTERS
    .filter(key => Number.isSafeInteger(details[key]) && details[key] >= 0 &&
      details[key] <= MAX_DIAGNOSTIC_TOKENS)
    .map(key => [key, details[key]]))
  return Object.keys(counters).length ? counters : null
}

function safeCandidateDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const boundedCount = item => Number.isSafeInteger(item) && item >= 0 &&
    item <= MAX_CANDIDATE_COUNT ? item : null
  const requested = boundedCount(value.requested)
  const accepted = boundedCount(value.accepted)
  if (requested === null || accepted === null ||
      typeof value.backupCandidatePathExercised !== 'boolean' ||
      !value.rejectedByReason || typeof value.rejectedByReason !== 'object' ||
      Array.isArray(value.rejectedByReason)) return null

  const rejectedKeys = Object.keys(value.rejectedByReason)
  if (rejectedKeys.length !== SAFE_CANDIDATE_REASONS.length ||
      rejectedKeys.some(key => !SAFE_CANDIDATE_REASONS.includes(key))) return null
  const rejectedByReason = {}
  for (const reason of SAFE_CANDIDATE_REASONS) {
    const count = boundedCount(value.rejectedByReason[reason])
    if (count === null) return null
    rejectedByReason[reason] = count
  }

  return Object.freeze({
    requested,
    accepted,
    rejectedByReason: Object.freeze(rejectedByReason),
    backupCandidatePathExercised: value.backupCandidatePathExercised,
  })
}

function safeIssue(issue, stage) {
  return {
    stage: stage === 'targeted' ? 'targeted' : 'warmup',
    attempt: SAFE_ATTEMPTS.has(issue?.attempt) ? issue.attempt : 'other',
    reason: SAFE_REASONS.has(issue?.reason) ? issue.reason : 'other',
    ...(numericCounters(issue?.details) ? { counters: numericCounters(issue.details) } : {}),
  }
}

function safeFinishReason(response) {
  if (SAFE_FINISH_REASONS.has(response?.finishReason)) return response.finishReason
  // PR #665 currently places the provider finish reason in `profile`. Accept
  // only the two documented values; arbitrary profile strings stay unknown.
  if (response?.finishReason === undefined && SAFE_FINISH_REASONS.has(response?.profile)) {
    return response.profile
  }
  return 'unknown'
}

function safeSha(value) {
  return /^[a-f0-9]{40}$/.test(value ?? '') ? value : 'unknown'
}

function safeSourceBranch(value) {
  return SAFE_SOURCE_BRANCHES.has(value) ? value : 'unknown'
}

function safeFailure(event, fields, stage, since) {
  if (!SAFE_FAILURE_EVENTS.has(event)) return null
  const reason = SAFE_REASONS.has(fields?.reason) ? fields.reason : 'other'
  return {
    stage: ['setup', 'warmup', 'targeted'].includes(stage) ? stage : 'warmup',
    event,
    reason,
    ...(event === 'runtime_failed' && SAFE_RUNTIME_STAGES.has(fields?.stage)
      ? { runtimeStage: fields.stage } : {}),
    atSeconds: elapsed(since),
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
    responsePhase: 'auxiliary_or_unmatched',
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

// The pinned application inspector predates the supported MCQ representation
// with `choices` and `correct_index`. Normalize only a transient copy for this
// diagnostic inspection; never change production validation or persist text.
function normalizeResponseForInspector(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_TEXT_CHARS) return text
  let parsed
  try { parsed = JSON.parse(text) } catch { return text }
  if (!parsed || !Array.isArray(parsed.questions)) return text

  let changed = false
  const questions = parsed.questions.map(question => {
    if (!question || typeof question !== 'object' || Array.isArray(question) ||
        Object.hasOwn(question, 'correct_answer') ||
        !Array.isArray(question.choices) ||
        !Number.isSafeInteger(question.correct_index) ||
        question.correct_index < 0 || question.correct_index >= question.choices.length ||
        typeof question.choices[question.correct_index] !== 'string') return question
    changed = true
    return { ...question, correct_answer: question.choices[question.correct_index] }
  })
  return changed ? JSON.stringify({ ...parsed, questions }) : text
}

function inspectDiagnosticResponse(text, fixture, inspectModelResponse) {
  return inspectModelResponse(normalizeResponseForInspector(text), fixture)
}

function createDiagnosticCallbacks({ report, getActiveStage, getStageStarted, getCurrent, started, inspectResponse }) {
  const lastAssociatedCallCount = new WeakMap()
  return {
    onDiagnostic(event, fields) {
      if (event === 'question_rejected') {
        const current = getCurrent()
        const stageStarted = getStageStarted()
        if (!current) return
        current.rejections.push({
          stage: getActiveStage() === 'targeted' ? 'targeted' : 'warmup',
          reason: SAFE_REASONS.has(fields?.reason) ? fields.reason : 'other',
          atSeconds: stageStarted === null ? null : elapsed(stageStarted),
        })
        return
      }
      if (event === 'inference_completed') {
        const current = getCurrent()
        const stageStarted = getStageStarted()
        if (!current || stageStarted === null) return
        const metric = safeMetric(fields, getActiveStage(), stageStarted)
        metric.callNumber = current.inferenceCalls.length + 1
        current.inferenceCalls.push(metric)
        return
      }
      const current = getCurrent()
      const stageStarted = getStageStarted()
      const failure = safeFailure(event, fields, getActiveStage() ?? 'setup', stageStarted ?? started)
      if (!failure) return
      if (current && stageStarted !== null) current.failures.push(failure)
      else report.setupFailures.push(failure)
    },
    onQuizGeneratedResponse(response) {
      const current = getCurrent()
      const stageStarted = getStageStarted()
      if (!current || stageStarted === null) return
      const phase = SAFE_PHASES.has(response?.phase) ? response.phase : 'generation'
      const generationProfile = SAFE_PROFILES.has(response?.generationProfile)
        ? response.generationProfile : 'other'
      current.responses.push({
        atSeconds: elapsed(stageStarted),
        phase,
        generationProfile,
        finishReason: safeFinishReason(response),
        quality: safeResponseDiagnostics(inspectResponse(response?.text)),
      })
      const associationStart = lastAssociatedCallCount.get(current) ?? 0
      const pending = current.inferenceCalls.slice(associationStart)
        .filter(item => item.responsePhase === 'auxiliary_or_unmatched')
      // The runtime callback has no inference-call ID. Associate only an
      // unambiguous one-to-one observation; when several calls are pending,
      // retain them as auxiliary_or_unmatched instead of guessing.
      if (pending.length === 1) {
        pending[0].responsePhase = phase
        pending[0].generationProfile = generationProfile
      }
      if (pending.length > 0) {
        lastAssociatedCallCount.set(current, current.inferenceCalls.length)
      }
    },
    onQuizValidationIssue(issue) {
      const current = getCurrent()
      if (!current) return
      const stageStarted = getStageStarted()
      current.validationIssues.push({
        ...safeIssue(issue, getActiveStage()),
        atSeconds: stageStarted === null ? null : elapsed(stageStarted),
      })
    },
    onCandidateDiagnostics(summary) {
      const current = getCurrent()
      if (!current || getActiveStage() !== 'targeted') return
      current.candidateDiagnostics = safeCandidateDiagnostics(summary)
    },
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
  const failureCategoryCounts = {}
  for (const failure of target?.failures ?? []) {
    failureCategoryCounts[`${failure.event}:${failure.reason}`] =
      (failureCategoryCounts[`${failure.event}:${failure.reason}`] ?? 0) + 1
  }
  const setupFailureCategoryCounts = {}
  for (const failure of report.setupFailures ?? []) {
    setupFailureCategoryCounts[`${failure.event}:${failure.reason}`] =
      (setupFailureCategoryCounts[`${failure.event}:${failure.reason}`] ?? 0) + 1
  }
  const rejectionCategoryCounts = {}
  for (const rejection of target?.rejections ?? []) {
    rejectionCategoryCounts[rejection.reason] = (rejectionCategoryCounts[rejection.reason] ?? 0) + 1
  }
  return {
    fixtureId: 'selected_pages_targeted_practice',
    targetElapsedSeconds: target?.elapsedSeconds ?? null,
    targetOutcome: target?.outcome ?? 'not_run',
    questionCount: target?.questionCount ?? 0,
    distinctQuestionCount: target?.distinctQuestionCount ?? 0,
    candidateDiagnostics: target?.candidateDiagnostics ?? null,
    semanticOracle: target?.semanticOracle ?? 'not_run',
    avoidsPriorQuestions: target?.avoidsPriorQuestions ?? 'not_run',
    callIntervals,
    inferenceCalls: metrics,
    validationCategoryCounts: categoryCounts,
    finishReasonCounts: (target?.responses ?? []).reduce((total, response) => {
      const reason = safeFinishReason(response)
      total[reason] = (total[reason] ?? 0) + 1
      return total
    }, {}),
    failureCategoryCounts,
    setupFailureCategoryCounts,
    rejectionCategoryCounts,
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
    schema: 3,
    syntheticOnly: true,
    diagnostic: 'targeted-practice-recovery',
    platform: process.platform,
    architecture: process.arch,
    sourceBranch: safeSourceBranch(process.env.QFN_DIAGNOSTIC_SOURCE_REF),
    sourceSha: safeSha(process.env.QFN_DIAGNOSTIC_SOURCE_SHA),
    diagnosticToolSha: safeSha(process.env.QFN_DIAGNOSTIC_TOOL_SHA),
    modelId: null,
    acceleration: null,
    logicalCpuCount: null,
    totalMemoryBytes: null,
    conditions: safeExecutionConditions(process.env, null),
    setupFailures: [],
    stages: [
      { id: 'warmup', elapsedSeconds: null, outcome: 'not_run', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
      { id: 'targeted', elapsedSeconds: null, outcome: 'not_run', inferenceCalls: [], responses: [], validationIssues: [], failures: [], rejections: [], candidateDiagnostics: null },
    ],
    summary: null,
  }
  let activeStage = null
  let stageStarted = null
  let stack = null
  const current = () => report.stages.find(stage => stage.id === activeStage)
  const diagnosticCallbacks = createDiagnosticCallbacks({
    report,
    getActiveStage: () => activeStage,
    getStageStarted: () => stageStarted,
    getCurrent: current,
    started,
    inspectResponse: text => inspectDiagnosticResponse(text, fixture, inspectModelResponse),
  })
  const persist = async () => {
    report.summary = summarize(report)
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }

  try {
    stack = createWindowsLocalAiStack({
      userDataDirectory: profile,
      modelDirectory,
      runtimeDirectory,
      ...diagnosticCallbacks,
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
    // publicCapability intentionally omits totalMemoryBytes; collect only the
    // bounded OS memory total needed for synthetic-run comparability.
    report.totalMemoryBytes = safeMemoryBytes(os.totalmem())

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
    report.conditions = safeExecutionConditions(process.env, report.stages[0].outcome)

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
  numericCounters, safeCandidateDiagnostics, safeExecutionConditions, safeMemoryBytes,
  safeIssue, safeMetric, safeResponseDiagnostics, safeFinishReason,
  safeSha, safeSourceBranch, safeFailure, normalizeResponseForInspector, inspectDiagnosticResponse,
  createDiagnosticCallbacks, summarize,
}
