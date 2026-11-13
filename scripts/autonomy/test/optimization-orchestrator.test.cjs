'use strict'

const test = require('node:test')

require('./review-cross-layer-limits.test.cjs')
require('./checkpoint-history.test.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
// Keep integration-continuation regressions in the normal autonomy test entrypoint.
require('./integration-coordinator.test.cjs')
const optimizationOrchestrator = require('../optimization-orchestrator.cjs')
const {
  AUDIT_DIMENSIONS, AUDIT_ROLES, addTask, beginRun, blockTask, createInitialState,
  recordApproval, recordAssessment, recordBaseline, recordBenchmark, recordImplementation,
  recordNewEvidence, recordOptimizationAudit, recordTests, releaseStopGate, resume, saveState, selectNextTask,
  startNewCycle, selectTask, validateState, validateTask, preparePilot, startPreparedPilot, loadState,
  recordRecoveryDiagnosis, recordRecoveryAttempt, createPreservationArchive, resolvePreservationDeferral,
  diagnosisCodeForFailureClassification, FAILURE_CLASSIFICATION_DIAGNOSIS_CODES,
} = require('../optimization-orchestrator.cjs')

function task(id, { domain = 'backend', impact = 3, effort = 2, risk = 1, dependencies = [] } = {}) {
  return {
    id, domain, title: `Improve ${id.replace(/-/g, ' ')}`,
    impact, effort, risk, dependencies, evidenceRefs: ['docs/ai-cost-controls.md'],
    testRefs: ['scripts/production/test_runtime.py'], benchmarkRefs: [],
  }
}

// Tests seed an in-memory checkpoint directly so the production API cannot bypass
// preparation and scoped authorization. This helper is intentionally test-local.
function createPilot(state, { pilotId, maxCycles = 10 } = {}) {
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 10) {
    throw new Error('Pilot requires a safe id and maxCycles between 1 and 10')
  }
  state.checkpoint.pilotId = pilotId
  state.checkpoint.maxCycles = maxCycles
  state.checkpoint.cyclesStarted = 0
  state.checkpoint.cyclesValidated = 0
  state.checkpoint.events.push({
    at: new Date().toISOString(), type: 'pilot_started', pilotId, maxCycles,
  })
}

function approvalAttestation(approvalEvidenceRef = 'docs/ai-cost-controls.md') {
  return {
    approverIdentity: 'reviewer@example.com',
    approverRole: 'reviewer',
    approvalEvidenceRef,
    authorizedScopeRef: 'docs/autonomy/optimization-loop.md',
    scopeCommitSha: 'd'.repeat(40),
  }
}

function diagnose(state, id, payload) {
  const taskRecord = state.tasks.find(item => item.id === id)
  const caseNumber = (taskRecord?.recoveryHistory.length ?? 0) + 1
  return recordRecoveryDiagnosis(state, id, {
    ...payload,
    investigatorInvocationRef: `test/investigator/${id}/${caseNumber}`,
  })
}

function recover(state, id, payload) {
  const taskRecord = state.tasks.find(item => item.id === id)
  const caseNumber = taskRecord?.recoveryHistory.length ?? 1
  const attemptNumber = (taskRecord?.recoveryHistory.at(-1)?.attempts.length ?? 0) + 1
  return recordRecoveryAttempt(state, id, {
    ...payload,
    developerInvocationRef: `test/developer/${id}/${caseNumber}/${attemptNumber}`,
  })
}

test('production API has no direct pilot creation and begin refuses an unprepared pilot', () => {
  assert.equal(optimizationOrchestrator.createPilot, undefined)
  const state = createInitialState()
  assert.throws(() => beginRun(state), /prepare and explicitly authorize a pilot/)
  assert.throws(() => resume(state), /without an explicitly started pilot/)
  assert.throws(() => startNewCycle(state), /without an explicitly started pilot/)
  assert.throws(() => selectTask(state), /requires an explicitly started pilot/)
  const pending = preparePilot(state, { pilotId: 'first-explicit-pilot' })
  assert.equal(pending.maxCycles, 10)
  assert.throws(() => beginRun(state), /explicit start-pilot/)
  assert.equal(state.checkpoint.pilotId, null)
  assert.equal(state.checkpoint.selectedTaskId, null)
  assert.equal(state.checkpoint.cyclesStarted, 0)
})

function blockWithDiagnosis(state, id, blockerCode, evidenceRef = 'docs/ai-cost-controls.md') {
  return diagnose(state, id, {
    diagnosisCode: 'evidence_insufficient',
    investigatorEvidenceRef: evidenceRef,
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: false,
    blockerCode,
    nonRecoverableReasonCode: 'evidence_unavailable',
  })
}

test('selects highest-value actionable work and breaks ties deterministically', () => {
  const state = createInitialState()
  addTask(state, task('low-value', { impact: 2, effort: 4 }))
  addTask(state, task('high-value-b', { impact: 5, effort: 1 }))
  addTask(state, task('high-value-a', { impact: 5, effort: 1 }))

  assert.equal(selectNextTask(state).id, 'high-value-a')
})

test('blocker is persisted and immediately selects independent actionable work', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-fallback-test', maxCycles: 3 })
  addTask(state, task('blocked-local-ai', { domain: 'local_ai', impact: 5, effort: 1 }))
  addTask(state, task('dependent-backend', { dependencies: ['blocked-local-ai'], impact: 5 }))
  addTask(state, task('independent-ci', { domain: 'ci_efficiency', impact: 4, effort: 1 }))

  const selected = beginRun(state).task
  assert.equal(selected.id, 'blocked-local-ai')
  const outcome = blockWithDiagnosis(state, selected.id, 'existing_pr', 'https://github.com/example/repo/pull/665')

  assert.equal(outcome.blocked.status, 'blocked')
  assert.equal(outcome.blocked.blocker.code, 'existing_pr')
  assert.equal(outcome.next.id, 'independent-ci')
  assert.notEqual(outcome.next.id, selected.id)
  assert.equal(state.tasks.find(item => item.id === 'dependent-backend').status, 'ready')
  assert.equal(state.checkpoint.selectedTaskId, 'independent-ci')
})

test('resume loads the same active task and preserves blocker work across disk round trip', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-optimizer-'))
  const file = path.join(temp, 'state.json')
  try {
    const state = createInitialState()
    createPilot(state, { pilotId: 'pilot-resume-test', maxCycles: 2 })
    addTask(state, task('resume-task'))
    beginRun(state)
    const activeId = state.checkpoint.selectedTaskId
    await saveState(file, state)
    const reopened = JSON.parse(await fs.readFile(file, 'utf8'))

    assert.equal(resume(reopened).task.id, activeId)
    assert.equal(reopened.checkpoint.cyclesStarted, 1)
    assert.equal(reopened.checkpoint.pilotId, 'pilot-resume-test')
    assert.equal(validateState(reopened), reopened)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('prepare-pilot preserves stopped history and cannot select or start work implicitly', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-2026-11-06-01', maxCycles: 10 })
  assert.throws(() => preparePilot(state, { pilotId: 'pilot-too-early' }), /only after the current pilot reaches a terminal/)
  state.checkpoint.cyclesStarted = 3
  state.checkpoint.cyclesValidated = 3
  state.checkpoint.optimizationGate.status = 'STOPPED'
  state.checkpoint.optimizationGate.stopReason = 'budget'
  addTask(state, task('pending-pilot-task'))
  const before = JSON.stringify({
    pilotId: state.checkpoint.pilotId,
    cyclesStarted: state.checkpoint.cyclesStarted,
    cyclesValidated: state.checkpoint.cyclesValidated,
    gate: state.checkpoint.optimizationGate,
    selectedTaskId: state.checkpoint.selectedTaskId,
  })
  const pending = preparePilot(state, { pilotId: 'pilot-follow-up-2026-11-06' })
  assert.equal(pending.maxCycles, 10)
  assert.match(pending.pilotId, /^pilot-/)
  assert.equal(state.checkpoint.preparedPilot.pilotId, pending.pilotId)
  assert.equal(JSON.stringify({
    pilotId: state.checkpoint.pilotId,
    cyclesStarted: state.checkpoint.cyclesStarted,
    cyclesValidated: state.checkpoint.cyclesValidated,
    gate: state.checkpoint.optimizationGate,
    selectedTaskId: state.checkpoint.selectedTaskId,
  }), before)
  assert.throws(() => beginRun(state), /explicit start-pilot/)
  assert.equal(state.checkpoint.cyclesStarted, 3)
  assert.equal(state.checkpoint.selectedTaskId, null)
  assert.throws(() => preparePilot(state, { pilotId: pending.pilotId }), /already prepared/)
  assert.throws(() => startPreparedPilot(state), /authorization/)
  assert.throws(() => startPreparedPilot(state, {
    pilotId: 'wrong-pilot', maxCycles: 10, approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  }), /match the prepared pilot ID/)
  assert.throws(() => startPreparedPilot(state, {
    pilotId: pending.pilotId, maxCycles: 9, approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  }), /match the prepared pilot ID/)
  assert.equal(state.checkpoint.preparedPilot.pilotId, pending.pilotId)
  startPreparedPilot(state, {
    pilotId: pending.pilotId, maxCycles: 10, approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  })
  assert.equal(state.checkpoint.pilotId, pending.pilotId)
  assert.equal(state.checkpoint.cyclesStarted, 0)
  assert.equal(state.checkpoint.selectedTaskId, null)
  assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(state.checkpoint.optimizationGate.stopReason, null)
  assert.deepEqual(state.checkpoint.pilotHistory.map(item => item.pilotId), ['pilot-2026-11-06-01'])
  assert.equal(state.checkpoint.pilotHistory[0].cyclesStarted, 3)
  assert.deepEqual(state.checkpoint.events.at(-1).pilotStartAuthorization, {
    pilotId: pending.pilotId,
    maxCycles: 10,
    approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  })
  assert.equal(validateState(state), state)
  const forgedStart = structuredClone(state)
  delete forgedStart.checkpoint.events.at(-1).pilotStartAuthorization
  assert.throws(() => validateState(forgedStart), /preserve its scoped authorization attestation/)
})

test('recovery records reject free-text diagnosis and solution fields', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'recovery-code-only-pilot', maxCycles: 2 })
  addTask(state, task('recovery-code-only-task'))
  const active = beginRun(state).task
  assert.throws(() => recordRecoveryDiagnosis(state, active.id, {
    diagnosisCode: 'missing_dependency',
    rootCause: 'arbitrary text should not enter the checkpoint',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  }), /allowlisted diagnosis/)
  assert.throws(() => recordRecoveryDiagnosis(state, active.id, {
    diagnosisCode: 'missing_dependency',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: false,
    blockerCode: 'tooling_unavailable',
    rationale: 'free-text rationale is not permitted',
  }), /allowlisted diagnosis/)
  diagnose(state, active.id, {
    diagnosisCode: 'missing_dependency',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  })
  assert.throws(() => recordRecoveryAttempt(state, active.id, {
    strategy: 'dependency_repair',
    solutionSummary: 'free text must be rejected',
    evidenceRef: 'docs/autonomy/optimization-loop.md',
    verificationRef: 'https://github.com/example/repo/actions/runs/10005',
    result: 'failed',
  }), /allowlisted strategy/)
  assert.equal(state.tasks[0].recoveryHistory[0].diagnosis.diagnosisCode, 'missing_dependency')
  assert.equal(Object.hasOwn(state.tasks[0].recoveryHistory[0].diagnosis, 'rootCause'), false)
  assert.equal(validateState(state), state)
})

test('new recovery cases require unique actual Investigator and Developer invocation references', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'recovery-provenance-pilot', maxCycles: 3 })
  addTask(state, task('recovery-provenance-task'))
  const active = beginRun(state).task
  const diagnosis = {
    diagnosisCode: 'missing_dependency',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  }
  const beforeInvalidDiagnosis = JSON.stringify(state)
  assert.throws(() => recordRecoveryDiagnosis(state, active.id, diagnosis), /Invalid actual agent invocation reference/)
  assert.equal(JSON.stringify(state), beforeInvalidDiagnosis)
  assert.throws(() => recordRecoveryDiagnosis(state, active.id, {
    ...diagnosis, investigatorInvocationRef: '../invented-agent-run',
  }), /Invalid actual agent invocation reference/)
  assert.equal(JSON.stringify(state), beforeInvalidDiagnosis)

  diagnose(state, active.id, diagnosis)
  const attempt = {
    strategy: 'dependency_repair',
    evidenceRef: 'docs/autonomy/optimization-loop.md',
    verificationRef: 'https://github.com/example/repo/actions/runs/10006',
    result: 'failed',
  }
  const beforeInvalidAttempt = JSON.stringify(state)
  assert.throws(() => recordRecoveryAttempt(state, active.id, attempt), /Invalid actual agent invocation reference/)
  assert.equal(JSON.stringify(state), beforeInvalidAttempt)
  assert.throws(() => recordRecoveryAttempt(state, active.id, {
    ...attempt, developerInvocationRef: active.recoveryHistory[0].diagnosis.investigatorInvocationRef,
  }), /new Developer invocation reference/)
  assert.equal(JSON.stringify(state), beforeInvalidAttempt)

  recover(state, active.id, attempt)
  const afterAttempt = JSON.stringify(state)
  assert.throws(() => recordRecoveryAttempt(state, active.id, {
    ...attempt,
    strategy: 'alternative_tooling',
    evidenceRef: 'backend/performance_metrics.py',
    verificationRef: 'https://github.com/example/repo/actions/runs/10007',
    developerInvocationRef: active.recoveryHistory[0].attempts[0].developerInvocationRef,
  }), /new Developer invocation reference/)
  assert.equal(JSON.stringify(state), afterAttempt)

  const legacy = structuredClone(state)
  delete legacy.tasks[0].recoveryHistory[0].diagnosis.investigatorInvocationRef
  delete legacy.tasks[0].recoveryHistory[0].attempts[0].developerInvocationRef
  assert.equal(validateState(legacy), legacy,
    'historical cases without invocation provenance remain readable without fabricated references')
  assert.equal(active.recoveryHistory[0].diagnosis.investigatorInvocationRef, 'test/investigator/recovery-provenance-task/1')
  assert.equal(active.recoveryHistory[0].attempts[0].developerInvocationRef, 'test/developer/recovery-provenance-task/1/1')
  assert.equal(validateState(state), state)
})

test('failure classifications map only to existing diagnosis codes', () => {
  assert.deepEqual(FAILURE_CLASSIFICATION_DIAGNOSIS_CODES, {
    INTRODUCED_REGRESSION: 'other',
    PREEXISTING_ON_BASE: 'other',
    ENVIRONMENT_FAILURE: 'environment_incompatible',
    INFRASTRUCTURE_FAILURE: 'upstream_unavailable',
    INTERMITTENT_FAILURE: 'other',
    EXTERNAL_DEPENDENCY: 'upstream_unavailable',
    INSUFFICIENT_EVIDENCE: 'evidence_insufficient',
  })
  for (const [classification, diagnosisCode] of Object.entries(FAILURE_CLASSIFICATION_DIAGNOSIS_CODES)) {
    assert.equal(diagnosisCodeForFailureClassification(classification), diagnosisCode)
    assert.ok(['missing_dependency', 'environment_incompatible', 'configuration_invalid',
      'evidence_insufficient', 'upstream_unavailable', 'benchmark_over_budget',
      'existing_change_conflict', 'other'].includes(diagnosisCode))
  }
  assert.throws(() => diagnosisCodeForFailureClassification('UNKNOWN_FAILURE'), /not allowlisted/)
  assert.throws(() => diagnosisCodeForFailureClassification('toString'), /not allowlisted/)
})

test('external benchmark diagnosis requires an Investigator; automatic cost blocker does not fabricate one', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'benchmark-diagnosis-provenance', maxCycles: 2 })
  addTask(state, { ...task('external-expensive-diagnosis', { impact: 5, effort: 1 }), benchmarkCost: 'local' })
  const active = beginRun(state).task
  const before = JSON.stringify(state)
  assert.throws(() => recordRecoveryDiagnosis(state, active.id, {
    diagnosisCode: 'benchmark_over_budget',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: false,
    blockerCode: 'benchmark_expensive',
    nonRecoverableReasonCode: 'resource_unavailable',
  }), /Invalid actual agent invocation reference/)
  assert.equal(JSON.stringify(state), before)

  const automatic = createInitialState()
  createPilot(automatic, { pilotId: 'automatic-benchmark-cost', maxCycles: 2 })
  addTask(automatic, { ...task('automatic-expensive-task', { impact: 5, effort: 1 }), benchmarkCost: 'expensive' })
  addTask(automatic, task('automatic-affordable-task', { domain: 'frontend', impact: 4, effort: 1 }))
  assert.equal(beginRun(automatic).task.id, 'automatic-affordable-task')
  const blocked = automatic.tasks.find(item => item.id === 'automatic-expensive-task')
  assert.equal(blocked.recoveryHistory[0].diagnosis.diagnosisCode, 'benchmark_over_budget')
  assert.equal(blocked.recoveryHistory[0].diagnosis.investigatorInvocationRef, undefined)
  assert.equal(automatic.checkpoint.cyclesStarted, 2)
  assert.equal(validateState(automatic), automatic)
})

test('successful blocker recovery verifies the original allowlisted check and preserves active work', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'recovery-success-pilot', maxCycles: 2 })
  addTask(state, task('recoverable-task'))
  const active = beginRun(state).task
  recordBaseline(state, active.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(state, active.id, { branch: 'codex/recoverable-task', commitSha: 'a'.repeat(40) })
  recordTests(state, active.id, { passed: false, artifactRef: 'scripts/production/test_runtime.py' })
  diagnose(state, active.id, {
    diagnosisCode: 'missing_dependency',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  })
  const recovered = recover(state, active.id, {
    strategy: 'dependency_repair',
    evidenceRef: 'docs/autonomy/optimization-loop.md',
    verificationRef: 'https://github.com/example/repo/actions/runs/10001',
    result: 'passed',
  })
  assert.equal(recovered.recovered, true)
  assert.equal(state.checkpoint.selectedTaskId, active.id)
  assert.equal(active.status, 'tests_passed')
  assert.equal(active.testResult.passed, true)
  assert.equal(active.implementation.branch, 'codex/recoverable-task')
  assert.equal(active.baseline.metric, 10)
  assert.equal(active.recoveryHistory[0].attempts[0].checkRef, 'scripts/production/test_runtime.py')
  assert.equal(active.recoveryHistory[0].outcome, 'recovered')
  assert.equal(validateState(state), state)
})

test('two distinct failed recovery attempts persist, block, and select independent work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-recovery-'))
  const file = path.join(dir, 'state.json')
  try {
    const state = createInitialState()
    createPilot(state, { pilotId: 'recovery-fallback-pilot', maxCycles: 4 })
    addTask(state, task('recovery-blocked', { impact: 5 }))
    addTask(state, task('recovery-independent', { domain: 'frontend', impact: 4 }))
    const active = beginRun(state).task
    diagnose(state, active.id, {
      diagnosisCode: 'environment_incompatible',
      investigatorEvidenceRef: 'docs/ai-cost-controls.md',
      originalCheckRef: 'scripts/production/test_runtime.py',
      recoverable: true,
      blockerCode: 'tooling_unavailable',
    })
    const first = {
      strategy: 'dependency_repair',
      evidenceRef: 'docs/autonomy/optimization-loop.md',
      verificationRef: 'https://github.com/example/repo/actions/runs/10002', result: 'failed',
    }
    recover(state, active.id, first)
    assert.throws(() => recover(state, active.id, first), /Repeated recovery strategy/)
    assert.throws(() => recover(state, active.id, {
      ...first, strategy: 'alternative_tooling',
      evidenceRef: 'docs/autonomy/optimization-loop.md',
      verificationRef: 'https://github.com/example/repo/actions/runs/10003',
    }), /distinct evidence/)
    await saveState(file, state)
    const reopened = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(reopened.tasks[0].recoveryHistory[0].attempts.length, 1)
    assert.equal(reopened.checkpoint.selectedTaskId, active.id)
    const second = {
      strategy: 'alternative_tooling',
      evidenceRef: 'backend/performance_metrics.py',
      verificationRef: 'https://github.com/example/repo/actions/runs/10004', result: 'failed',
    }
    const outcome = recover(reopened, active.id, second)
    assert.equal(outcome.blocked.status, 'blocked')
    assert.equal(outcome.next.id, 'recovery-independent')
    assert.equal(reopened.tasks[0].recoveryHistory[0].attempts.length, 2)
    assert.equal(reopened.checkpoint.selectedTaskId, 'recovery-independent')
    for (const staleRef of [
      'docs/autonomy/optimization-loop.md',
      'https://github.com/example/repo/actions/runs/10002',
      'backend/performance_metrics.py',
    ]) {
      assert.throws(() => recordNewEvidence(reopened, active.id, staleRef), /distinct/)
    }
    assert.equal(reopened.tasks[0].evidenceRevision, 0)
    assert.equal(reopened.tasks[0].status, 'blocked')
    assert.equal(validateState(reopened), reopened)
    assert.throws(() => recover(reopened, active.id, second), /not the active checkpoint task/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('recovery evidence stays unique across cases while a strategy may recur with fresh evidence', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'recovery-history-pilot', maxCycles: 5 })
  addTask(state, task('recovery-history-task', { impact: 5 }))
  addTask(state, task('recovery-history-fallback', { domain: 'frontend', impact: 4 }))
  const firstTask = beginRun(state).task
  diagnose(state, firstTask.id, {
    diagnosisCode: 'environment_incompatible',
    investigatorEvidenceRef: 'docs/ai-cost-controls.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  })
  recover(state, firstTask.id, {
    strategy: 'dependency_repair', evidenceRef: 'docs/autonomy/optimization-loop.md',
    verificationRef: 'https://github.com/example/repo/actions/runs/11001', result: 'failed',
  })
  recover(state, firstTask.id, {
    strategy: 'alternative_tooling', evidenceRef: 'backend/performance_metrics.py',
    verificationRef: 'https://github.com/example/repo/actions/runs/11002', result: 'failed',
  })
  assert.equal(state.checkpoint.selectedTaskId, 'recovery-history-fallback')

  recordNewEvidence(state, firstTask.id, 'https://github.com/example/repo/actions/runs/11003')
  blockWithDiagnosis(state, 'recovery-history-fallback', 'unavailable_evidence')
  assert.equal(state.checkpoint.selectedTaskId, firstTask.id)
  diagnose(state, firstTask.id, {
    diagnosisCode: 'environment_incompatible',
    investigatorEvidenceRef: 'https://github.com/example/repo/actions/runs/11003',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  })

  assert.throws(() => recover(state, firstTask.id, {
    strategy: 'dependency_repair', evidenceRef: 'docs/autonomy/optimization-loop.md',
    verificationRef: 'https://github.com/example/repo/actions/runs/11004', result: 'failed',
  }), /distinct evidence/)
  recover(state, firstTask.id, {
    strategy: 'dependency_repair', evidenceRef: 'scripts/autonomy/optimization-orchestrator.test.cjs',
    verificationRef: 'https://github.com/example/repo/actions/runs/11005', result: 'failed',
  })
  assert.equal(firstTask.recoveryHistory[1].attempts[0].strategy, 'dependency_repair')
  assert.equal(validateState(state), state)
})

test('blocked selections consume the ten-cycle pilot budget', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'ten-blocked-cycles', maxCycles: 10 })
  for (let index = 1; index <= 10; index += 1) addTask(state, task(`budget-task-${index}`))
  for (let index = 1; index <= 10; index += 1) {
    const selected = state.checkpoint.selectedTaskId
      ? state.tasks.find(item => item.id === state.checkpoint.selectedTaskId)
      : beginRun(state).task
    assert.ok(selected)
    blockWithDiagnosis(state, selected.id, 'unavailable_evidence')
  }
  assert.equal(state.checkpoint.cyclesStarted, 10)
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(state.checkpoint.selectedTaskId, null)
  assert.equal(validateState(state), state)
})

test('blocked task requires distinct new evidence before it can be selected again', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-evidence-test', maxCycles: 4 })
  addTask(state, task('evidence-task', { impact: 5, effort: 1 }))
  addTask(state, task('fallback-task', { impact: 4, effort: 1 }))
  const first = beginRun(state).task
  blockWithDiagnosis(state, first.id, 'unavailable_evidence')

  assert.throws(() => recordNewEvidence(state, first.id, 'docs/ai-cost-controls.md'), /distinct/)
  assert.throws(() => addTask(state, {
    ...task('duplicate-investigation'), investigationKey: first.investigationKey,
  }), /investigation already exists/)
  recordNewEvidence(state, first.id, 'https://github.com/example/repo/actions/runs/123')
  assert.equal(state.tasks.find(item => item.id === first.id).status, 'ready')
  assert.equal(state.tasks.find(item => item.id === first.id).evidenceRevision, 1)
})

test('legacy reopened ready task preserves stale lifecycle and selects with a fresh active cycle', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-legacy-reopen-'))
  const file = path.join(directory, 'state.json')
  try {
    const state = createInitialState()
    createPilot(state, { pilotId: 'legacy-reopen-pilot', maxCycles: 3 })
    const existingSnapshot = {
      baseline: { metric: 3, evidenceRef: 'backend/performance_metrics.py' },
      implementation: { branch: 'codex/older-reopened-work', commitSha: 'b'.repeat(40) },
      testResult: { passed: true, evidenceRef: 'scripts/production/test_runtime.py' },
      assessments: {
        reviewer: null,
        qa: { passed: true, evidenceRef: 'scripts/production/test_runtime.py' },
        quality: null,
        security: null,
      },
      validation: { accepted: false, reasonCode: 'earlier_preserved_attempt', evidenceRef: 'backend/performance_metrics.py' },
    }
    addTask(state, {
      ...task('legacy-reopened-task', { impact: 5 }),
      baseline: { metric: 9, evidenceRef: 'docs/ai-cost-controls.md' },
      implementation: { branch: 'codex/legacy-reopened-task', commitSha: 'a'.repeat(40) },
      testResult: { passed: false, evidenceRef: 'scripts/production/test_runtime.py' },
      assessments: {
        reviewer: { passed: true, evidenceRef: 'docs/ai-cost-controls.md' },
        qa: null, quality: null, security: null,
      },
      validation: { accepted: false, reasonCode: 'prior_attempt_blocked', evidenceRef: 'docs/ai-cost-controls.md' },
      workPreserved: structuredClone(existingSnapshot),
    })
    // Old persisted ready tasks predate the recoveryHistory field and can retain
    // lifecycle evidence from a previous attempt.
    delete state.tasks[0].recoveryHistory
    validateState(state)
    const oldLifecycle = structuredClone({
      baseline: state.tasks[0].baseline,
      implementation: state.tasks[0].implementation,
      testResult: state.tasks[0].testResult,
      assessments: state.tasks[0].assessments,
      validation: state.tasks[0].validation,
    })

    const selected = beginRun(state).task
    assert.equal(selected.status, 'selected')
    assert.equal(state.checkpoint.cyclesStarted, 1)
    assert.deepEqual(selected.workPreserved, { ...oldLifecycle, priorSnapshots: [existingSnapshot] })
    assert.equal(selected.baseline, null)
    assert.equal(selected.implementation, null)
    assert.equal(selected.testResult, null)
    assert.deepEqual(selected.assessments, { reviewer: null, qa: null, quality: null, security: null })
    assert.equal(selected.validation, null)
    assert.equal(validateState(state), state)

    await saveState(file, state)
    const reopened = validateState(JSON.parse(await fs.readFile(file, 'utf8')))
    const persisted = reopened.tasks.find(item => item.id === selected.id)
    assert.equal(reopened.checkpoint.selectedTaskId, selected.id)
    assert.equal(reopened.checkpoint.cyclesStarted, 1)
    assert.deepEqual(persisted.workPreserved, { ...oldLifecycle, priorSnapshots: [existingSnapshot] })
    assert.equal(persisted.baseline, null)
    assert.equal(persisted.implementation, null)
    assert.equal(persisted.testResult, null)
    assert.equal(persisted.validation, null)
    assert.throws(() => recordImplementation(reopened, selected.id, {
      branch: 'codex/legacy-reopened-task', commitSha: 'b'.repeat(40),
    }), /baseline/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('full lifecycle history defers high-ranked task and selects independent work without extra cycle', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-full-preserved-history-'))
  const file = path.join(directory, 'state.json')
  try {
  const state = createInitialState()
  createPilot(state, { pilotId: 'full-preserved-history-pilot', maxCycles: 2 })
  const priorSnapshot = {
    baseline: { metric: 3, evidenceRef: 'backend/performance_metrics.py' },
    implementation: { branch: 'codex/preserved-work', commitSha: 'c'.repeat(40) },
    testResult: null,
    assessments: { reviewer: null, qa: null, quality: null, security: null },
    validation: null,
  }
  addTask(state, {
    ...task('full-preserved-history-task', { impact: 5 }),
    baseline: { metric: 9, evidenceRef: 'docs/ai-cost-controls.md' },
    implementation: { branch: 'codex/full-preserved-history-task', commitSha: 'd'.repeat(40) },
    workPreserved: { ...priorSnapshot, priorSnapshots: Array.from({ length: 10 }, () => structuredClone(priorSnapshot)) },
  })
  addTask(state, task('independent-after-deferral', { impact: 3, effort: 1 }))
  const selected = beginRun(state).task
  const deferred = state.tasks.find(item => item.id === 'full-preserved-history-task')
  assert.equal(selected.id, 'independent-after-deferral')
  assert.equal(state.checkpoint.cyclesStarted, 1)
  assert.equal(state.checkpoint.selectedTaskId, selected.id)
  assert.equal(deferred.status, 'blocked')
  assert.equal(deferred.blocker.code, 'snapshot_history_full')
  assert.equal(deferred.workPreserved.priorSnapshots.length, 10)
  assert.deepEqual(deferred.preservationDeferral.lifecycleSnapshot, {
    baseline: { metric: 9, evidenceRef: 'docs/ai-cost-controls.md' },
    implementation: { branch: 'codex/full-preserved-history-task', commitSha: 'd'.repeat(40) },
    testResult: null,
    assessments: { reviewer: null, qa: null, quality: null, security: null },
    validation: null,
  })
  assert.throws(() => recordNewEvidence(
    state, deferred.id, 'https://github.com/example/repo/actions/runs/13001'), /awaiting snapshot archive/)
  assert.equal(validateState(state), state)
  await saveState(file, state)
  const reopened = validateState(JSON.parse(await fs.readFile(file, 'utf8')))
  const persistedDeferred = reopened.tasks.find(item => item.id === deferred.id)
  assert.equal(reopened.checkpoint.selectedTaskId, 'independent-after-deferral')
  assert.equal(reopened.checkpoint.cyclesStarted, 1)
  assert.equal(persistedDeferred.workPreserved.priorSnapshots.length, 10)
  assert.equal(persistedDeferred.preservationDeferral.reasonCode, 'snapshot_history_full')

  const forgedDeferral = structuredClone(reopened)
  forgedDeferral.tasks.find(item => item.id === persistedDeferred.id).workPreserved.priorSnapshots.pop()
  assert.throws(() => validateState(forgedDeferral), /full prior snapshot history/)
  const forgedSnapshot = structuredClone(reopened)
  const sameSnapshot = {
    baseline: persistedDeferred.workPreserved.baseline,
    implementation: persistedDeferred.workPreserved.implementation,
    testResult: persistedDeferred.workPreserved.testResult,
    assessments: persistedDeferred.workPreserved.assessments,
    validation: persistedDeferred.workPreserved.validation,
  }
  forgedSnapshot.tasks.find(item => item.id === persistedDeferred.id).preservationDeferral.lifecycleSnapshot =
    structuredClone(sameSnapshot)
  assert.throws(() => validateState(forgedSnapshot), /must exceed the bounded work-history capacity/)

  await assert.rejects(resolvePreservationDeferral(
    reopened, persistedDeferred.id, 'docs/autonomy/optimization-report-template.md', directory),
  /task-scoped SHA-256 path/)
  await assert.rejects(resolvePreservationDeferral(
    reopened, 'different-task-id', 'docs/autonomy/archives/different-task-id-' + 'f'.repeat(64) + '.json', directory),
  /Unknown task/)
  assert.equal(persistedDeferred.status, 'blocked')

  const archiveReference = await createPreservationArchive(reopened, persistedDeferred.id, directory)
  assert.match(archiveReference,
    new RegExp(`^docs/autonomy/archives/${persistedDeferred.id}-[a-f0-9]{64}\\.json$`))
  const cappedArchiveState = structuredClone(reopened)
  const cappedArchiveTask = cappedArchiveState.tasks.find(item => item.id === persistedDeferred.id)
  cappedArchiveTask.preservationArchiveRefs = Array.from({ length: 10 }, (_, index) =>
    `docs/autonomy/archives/${persistedDeferred.id}-${String(index).padStart(64, '0')}.json`)
  const archiveDirectory = path.join(directory, 'docs', 'autonomy', 'archives')
  const archiveFilesBeforeCapFailure = await fs.readdir(archiveDirectory)
  await assert.rejects(createPreservationArchive(cappedArchiveState, persistedDeferred.id, directory),
    /archive reference history is full/)
  assert.deepEqual(await fs.readdir(archiveDirectory), archiveFilesBeforeCapFailure)

  const archiveFile = path.join(directory, ...archiveReference.split('/'))
  const archiveBytes = await fs.readFile(archiveFile)
  await fs.writeFile(archiveFile, Buffer.from('tampered'))
  await assert.rejects(resolvePreservationDeferral(reopened, persistedDeferred.id, archiveReference, directory),
    /SHA-256 does not match/)
  assert.equal(persistedDeferred.status, 'blocked')
  await fs.writeFile(archiveFile, archiveBytes)

  await resolvePreservationDeferral(reopened, persistedDeferred.id, archiveReference, directory)
  assert.equal(persistedDeferred.status, 'ready')
  assert.equal(persistedDeferred.preservationDeferral, null)
  assert.equal(persistedDeferred.preservationArchiveRefs.length, 1)
  assert.equal(persistedDeferred.workPreserved.baseline.metric, 9)
  assert.equal(persistedDeferred.workPreserved.priorSnapshots, undefined)
  assert.equal(persistedDeferred.baseline, null)
  assert.equal(reopened.checkpoint.cyclesStarted, 1)
  assert.equal(validateState(reopened), reopened)
  const missingArchiveEvent = structuredClone(reopened)
  missingArchiveEvent.checkpoint.events = missingArchiveEvent.checkpoint.events.filter(event =>
    !(event.type === 'preservation_archived' && event.taskId === persistedDeferred.id))
  assert.throws(() => validateState(missingArchiveEvent), /archive references do not match persisted archive events/)
  const changedArchiveReference = structuredClone(reopened)
  changedArchiveReference.tasks.find(item => item.id === persistedDeferred.id).preservationArchiveRefs[0] =
    `docs/autonomy/archives/${persistedDeferred.id}-${'a'.repeat(64)}.json`
  assert.throws(() => validateState(changedArchiveReference), /archive references do not match persisted archive events/)
  const checkpointFile = path.join(directory, 'checkpoint.json')
  const persistedCheckpoint = structuredClone(reopened)
  persistedCheckpoint.checkpoint.revision = 0
  await saveState(checkpointFile, persistedCheckpoint)
  assert.equal((await loadState(checkpointFile, directory)).tasks.find(item => item.id === persistedDeferred.id).id,
    persistedDeferred.id)
  const archiveDirectoryBackup = `${archiveDirectory}.real`
  await fs.rename(archiveDirectory, archiveDirectoryBackup)
  let archiveDirectoryLinkCreated = false
  try {
    await fs.symlink(archiveDirectoryBackup, archiveDirectory, 'junction')
    archiveDirectoryLinkCreated = true
  } catch (error) {
    await fs.rename(archiveDirectoryBackup, archiveDirectory)
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    t.diagnostic(`Skipped archive-directory symlink assertion: ${error.code}`)
  }
  if (archiveDirectoryLinkCreated) {
    try {
      await assert.rejects(loadState(checkpointFile, directory), /cannot contain symlinks/)
    } finally {
      await fs.unlink(archiveDirectory)
      await fs.rename(archiveDirectoryBackup, archiveDirectory)
    }
  }
  const archivedEventCheckpoint = structuredClone(reopened)
  const archivedEventIndex = archivedEventCheckpoint.checkpoint.events.findIndex(event =>
    event.type === 'preservation_archived' && event.taskId === persistedDeferred.id)
  archivedEventCheckpoint.checkpoint.eventArchives.push([
    ...archivedEventCheckpoint.checkpoint.events.splice(archivedEventIndex, 1),
  ])
  archivedEventCheckpoint.checkpoint.revision = 0
  const archivedEventFile = path.join(directory, 'archived-event-checkpoint.json')
  await saveState(archivedEventFile, archivedEventCheckpoint)
  assert.equal((await loadState(archivedEventFile, directory)).tasks.find(item => item.id === persistedDeferred.id).id,
    persistedDeferred.id)
  await fs.rename(archiveFile, `${archiveFile}.missing`)
  await assert.rejects(loadState(checkpointFile, directory), /archive artifact is missing/i)
  await fs.rename(`${archiveFile}.missing`, archiveFile)
  await fs.writeFile(archiveFile, Buffer.from('tampered'))
  await assert.rejects(loadState(checkpointFile, directory), /lifecycle archive SHA-256 does not match its path/)
  await fs.writeFile(archiveFile, archiveBytes)

  const oversizedBytes = Buffer.alloc(128 * 1024 + 1, 0x61)
  const oversizedRef = `docs/autonomy/archives/${persistedDeferred.id}-${crypto.createHash('sha256').update(oversizedBytes).digest('hex')}.json`
  const oversizedState = structuredClone(reopened)
  oversizedState.tasks.find(item => item.id === persistedDeferred.id).preservationArchiveRefs[0] = oversizedRef
  oversizedState.checkpoint.events.find(event => event.type === 'preservation_archived' &&
    event.taskId === persistedDeferred.id).evidenceRef = oversizedRef
  oversizedState.checkpoint.revision = 0
  const oversizedFile = path.join(directory, `${persistedDeferred.id}-oversized.json`)
  await fs.writeFile(path.join(directory, ...oversizedRef.split('/')), oversizedBytes)
  await saveState(oversizedFile, oversizedState)
  await assert.rejects(loadState(oversizedFile, directory), /exceeds its bounded size/)

  const malformedManifest = {
    schemaVersion: 1, taskId: persistedDeferred.id, snapshotCount: 2,
    snapshots: [
      { kind: 'work_preserved', snapshot: {} },
      { kind: 'deferred', snapshot: {} },
    ],
  }
  const malformedBytes = Buffer.from(`${JSON.stringify(malformedManifest, null, 2)}\n`)
  const malformedRef = `docs/autonomy/archives/${persistedDeferred.id}-${crypto.createHash('sha256').update(malformedBytes).digest('hex')}.json`
  const malformedState = structuredClone(reopened)
  malformedState.tasks.find(item => item.id === persistedDeferred.id).preservationArchiveRefs[0] = malformedRef
  const malformedEvent = malformedState.checkpoint.events.find(event => event.type === 'preservation_archived' &&
    event.taskId === persistedDeferred.id)
  malformedEvent.evidenceRef = malformedRef
  malformedEvent.archivedSnapshotCount = 2
  malformedState.checkpoint.revision = 0
  const malformedFile = path.join(directory, `${persistedDeferred.id}-malformed.json`)
  await fs.writeFile(path.join(directory, ...malformedRef.split('/')), malformedBytes)
  await saveState(malformedFile, malformedState)
  await assert.rejects(loadState(malformedFile, directory), /Invalid preserved/)

  const onlyState = createInitialState()
  createPilot(onlyState, { pilotId: 'archive-only-task-pilot', maxCycles: 2 })
  addTask(onlyState, {
    ...task('archive-only-task', { impact: 5 }),
    baseline: { metric: 6, evidenceRef: 'docs/ai-cost-controls.md' },
    workPreserved: { ...priorSnapshot, priorSnapshots: Array.from({ length: 10 }, () => structuredClone(priorSnapshot)) },
  })
  assert.equal(beginRun(onlyState).task, null)
  assert.equal(onlyState.checkpoint.cyclesStarted, 0)
  const onlyTask = onlyState.tasks.find(item => item.id === 'archive-only-task')
  const freshArchiveRoot = path.join(directory, 'fresh-concurrent-root')
  await fs.mkdir(freshArchiveRoot)
  const [onlyArchive, concurrentArchive] = await Promise.all([
    createPreservationArchive(onlyState, onlyTask.id, freshArchiveRoot),
    createPreservationArchive(onlyState, onlyTask.id, freshArchiveRoot),
  ])
  assert.equal(concurrentArchive, onlyArchive)
  await resolvePreservationDeferral(onlyState, onlyTask.id, onlyArchive, freshArchiveRoot)
  assert.equal(onlyTask.evidenceRevision, 1)
  assert.equal(beginRun(onlyState).task.id, onlyTask.id)
  assert.equal(onlyState.checkpoint.cyclesStarted, 1)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('recovery diagnosis and final failed attempt fail atomically when snapshot history is full', () => {
  const previousSnapshot = {
    baseline: { metric: 3, evidenceRef: 'backend/performance_metrics.py' },
    implementation: { branch: 'codex/old-preserved-work', commitSha: 'e'.repeat(40) },
    testResult: { passed: true, evidenceRef: 'scripts/production/test_runtime.py' },
    assessments: { reviewer: null, qa: null, quality: null, security: null },
    validation: null,
  }
  const makeStateWithFullHistory = pilotId => {
    const state = createInitialState()
    createPilot(state, { pilotId, maxCycles: 3 })
    addTask(state, task(`${pilotId}-task`))
    const active = beginRun(state).task
    recordBaseline(state, active.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
    recordImplementation(state, active.id, {
      branch: `codex/${active.id}`, commitSha: 'f'.repeat(40),
    })
    recordTests(state, active.id, { passed: false, artifactRef: 'scripts/production/test_runtime.py' })
    active.workPreserved = {
      ...structuredClone(previousSnapshot),
      priorSnapshots: Array.from({ length: 10 }, () => structuredClone(previousSnapshot)),
    }
    assert.equal(validateState(state), state)
    return { state, active }
  }

  const nonrecoverable = makeStateWithFullHistory('recovery-atomic-diagnosis')
  const beforeDiagnosis = JSON.stringify(nonrecoverable.state)
  assert.throws(() => recordRecoveryDiagnosis(nonrecoverable.state, nonrecoverable.active.id, {
    diagnosisCode: 'evidence_insufficient',
    investigatorEvidenceRef: 'docs/autonomy/optimization-loop.md',
    investigatorInvocationRef: 'test/investigator/recovery-atomic-diagnosis/1',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: false,
    blockerCode: 'unavailable_evidence',
    nonRecoverableReasonCode: 'evidence_unavailable',
  }), /bounded work history is full/)
  assert.equal(JSON.stringify(nonrecoverable.state), beforeDiagnosis)

  const recoverable = makeStateWithFullHistory('recovery-atomic-attempt')
  diagnose(recoverable.state, recoverable.active.id, {
    diagnosisCode: 'environment_incompatible',
    investigatorEvidenceRef: 'docs/autonomy/optimization-loop.md',
    originalCheckRef: 'scripts/production/test_runtime.py',
    recoverable: true,
    blockerCode: 'tooling_unavailable',
  })
  recover(recoverable.state, recoverable.active.id, {
    strategy: 'dependency_repair', evidenceRef: 'backend/performance_metrics.py',
    verificationRef: 'https://github.com/example/repo/actions/runs/12001', result: 'failed',
  })
  const beforeFinalAttempt = JSON.stringify(recoverable.state)
  assert.throws(() => recover(recoverable.state, recoverable.active.id, {
    strategy: 'alternative_tooling', evidenceRef: 'scripts/autonomy/test/optimization-orchestrator.test.cjs',
    verificationRef: 'https://github.com/example/repo/actions/runs/12002', result: 'failed',
  }), /bounded work history is full/)
  assert.equal(JSON.stringify(recoverable.state), beforeFinalAttempt)
})

test('blocked task at the evidence-reference cap rejects new evidence without mutation', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'evidence-cap-pilot', maxCycles: 2 })
  const fullEvidence = Array.from({ length: 12 }, (_, index) => `docs/evidence-${index}.md`)
  addTask(state, { ...task('evidence-cap-task'), evidenceRefs: fullEvidence })
  const active = beginRun(state).task
  blockWithDiagnosis(state, active.id, 'unavailable_evidence', fullEvidence[0])
  const beforeTask = JSON.stringify(state.tasks[0])
  const beforeCheckpoint = JSON.stringify(state.checkpoint)

  assert.throws(() => recordNewEvidence(
    state, active.id, 'https://github.com/example/repo/actions/runs/98765'),
  /evidence reference limit reached/)
  assert.equal(JSON.stringify(state.tasks[0]), beforeTask)
  assert.equal(JSON.stringify(state.checkpoint), beforeCheckpoint)
  assert.equal(validateState(state), state)
})

test('full validation lifecycle requires baseline, branch commit, tests, independent roles, and no regression', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-lifecycle-test', maxCycles: 1 })
  addTask(state, task('lifecycle-task'))
  const selected = beginRun(state).task
  const id = selected.id

  assert.throws(() => recordImplementation(state, id, {
    branch: 'codex/lifecycle-task', commitSha: 'a'.repeat(40),
  }), /baseline/)
  recordBaseline(state, id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(state, id, { branch: 'codex/lifecycle-task', commitSha: 'a'.repeat(40) })
  recordTests(state, id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  assert.throws(() => recordAssessment(state, id, {
    role: 'reviewer', passed: true, artifactRef: 'docs/ai-cost-controls.md',
  }), /actual agent invocation reference/)
  assert.throws(() => recordAssessment(state, id, {
    role: 'reviewer', passed: true, artifactRef: 'docs/ai-cost-controls.md',
    invocationRef: '/root/test_reviewer_invocation', targetCommitSha: 'b'.repeat(40),
  }), /exact implemented commit/)
  for (const role of ['reviewer', 'qa', 'quality', 'security']) {
    recordAssessment(state, id, {
      role,
      passed: true,
      artifactRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
      invocationRef: `/root/test_${role}_invocation`,
      targetCommitSha: 'a'.repeat(40),
    })
  }
  const validated = recordBenchmark(state, id, {
    resultMetric: 8, artifactRef: 'docs/ai-cost-controls.md',
  })
  assert.equal(validated.status, 'validated')
  assert.equal(state.checkpoint.cyclesValidated, 1)
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(validateState(state), state)
  const reviewerEvent = state.checkpoint.events.find(event => event.type === 'reviewer_passed')
  assert.equal(reviewerEvent.invocationRef, '/root/test_reviewer_invocation')
  assert.equal(reviewerEvent.assessmentCommitSha, 'a'.repeat(40))
  const missingTrace = structuredClone(state)
  delete missingTrace.tasks[0].assessments.reviewer.invocationRef
  delete missingTrace.tasks[0].assessments.reviewer.targetCommitSha
  assert.throws(() => validateState(missingTrace), /traceable Reviewer and QA invocations/)
  const wrongCommitTrace = structuredClone(state)
  wrongCommitTrace.tasks[0].assessments.reviewer.targetCommitSha = 'b'.repeat(40)
  assert.throws(() => validateState(wrongCommitTrace), /traceable Reviewer and QA invocations/)

  const legacyState = structuredClone(state)
  legacyState.schemaVersion = 1
  for (const assessment of Object.values(legacyState.tasks[0].assessments)) {
    delete assessment.invocationRef
    delete assessment.targetCommitSha
  }
  for (const event of legacyState.checkpoint.events) {
    delete event.invocationRef
    delete event.assessmentCommitSha
  }
  assert.equal(validateState(legacyState), legacyState)
  assert.equal(legacyState.schemaVersion, 2)
  assert.equal(legacyState.tasks[0].assessmentProvenanceLegacy, true)
  assert.ok(Object.values(legacyState.tasks[0].assessments).every(item => !('invocationRef' in item)))
  assert.equal(startNewCycle(state).reason, 'cycle_limit_reached')
})

test('schema v1 mid-review checkpoints preserve old events but require fresh traceable reviews', () => {
  for (const reviewStage of ['reviewed', 'qa_passed', 'quality_security_passed']) {
    const state = createInitialState()
    createPilot(state, { pilotId: `legacy-${reviewStage.replaceAll('_', '-')}`, maxCycles: 2 })
    addTask(state, task('legacy-review-migration'))
    const selected = beginRun(state).task
    recordBaseline(state, selected.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
    recordImplementation(state, selected.id, { branch: 'codex/legacy-review-migration', commitSha: 'a'.repeat(40) })
    recordTests(state, selected.id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })

    selected.status = reviewStage
    selected.assessments = Object.fromEntries(['reviewer', 'qa', 'quality', 'security'].map(role => [role, {
      passed: true,
      evidenceRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
    }]))
    for (const role of ['reviewer', 'qa', 'quality', 'security']) {
      state.checkpoint.events.push({
        at: new Date().toISOString(),
        type: `${role}_passed`,
        taskId: selected.id,
        evidenceRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
      })
    }
    state.schemaVersion = 1

    assert.equal(validateState(state), state)
    assert.equal(state.schemaVersion, 2)
    assert.equal(selected.status, 'tests_passed')
    assert.deepEqual(selected.assessments, { reviewer: null, qa: null, quality: null, security: null })
    assert.equal(selected.assessmentProvenanceLegacy, undefined)
    assert.ok(state.checkpoint.events.some(event => event.type === 'reviewer_passed' &&
      event.taskId === selected.id && event.invocationRef === undefined))
  }

  const malformed = createInitialState()
  createPilot(malformed, { pilotId: 'legacy-malformed-assessment', maxCycles: 1 })
  addTask(malformed, task('legacy-malformed-task'))
  const taskRecord = beginRun(malformed).task
  recordBaseline(malformed, taskRecord.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(malformed, taskRecord.id, { branch: 'codex/legacy-malformed-task', commitSha: 'c'.repeat(40) })
  recordTests(malformed, taskRecord.id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  taskRecord.assessments = 'malformed'
  malformed.schemaVersion = 1
  assert.throws(() => validateState(malformed), /Invalid assessment record/)
  assert.equal(taskRecord.assessments, 'malformed', 'migration must not erase malformed checkpoint data')
})

test('schema v1 blocker and rejection migrations preserve their matching lifecycle snapshots', () => {
  const blockedState = createInitialState()
  createPilot(blockedState, { pilotId: 'legacy-blocked-assessments', maxCycles: 2 })
  addTask(blockedState, task('legacy-blocked-task'))
  const blocked = beginRun(blockedState).task
  recordBaseline(blockedState, blocked.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(blockedState, blocked.id, { branch: 'codex/legacy-blocked-task', commitSha: 'a'.repeat(40) })
  recordTests(blockedState, blocked.id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  blocked.assessments.reviewer = { passed: true, evidenceRef: 'docs/ai-cost-controls.md' }
  blockWithDiagnosis(blockedState, blocked.id, 'unavailable_evidence')
  const preservedBlockerSnapshot = structuredClone(blocked.workPreserved)
  blockedState.schemaVersion = 1

  assert.equal(validateState(blockedState), blockedState)
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.assessments, preservedBlockerSnapshot.assessments)
  assert.deepEqual(blocked.workPreserved.assessments, preservedBlockerSnapshot.assessments)

  const rejectedState = createInitialState()
  createPilot(rejectedState, { pilotId: 'legacy-rejected-assessments', maxCycles: 1 })
  addTask(rejectedState, task('legacy-rejected-task'))
  const rejected = beginRun(rejectedState).task
  recordBaseline(rejectedState, rejected.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(rejectedState, rejected.id, { branch: 'codex/legacy-rejected-task', commitSha: 'b'.repeat(40) })
  recordTests(rejectedState, rejected.id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  for (const role of ['reviewer', 'qa', 'quality', 'security']) {
    recordAssessment(rejectedState, rejected.id, {
      role,
      passed: true,
      artifactRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
      invocationRef: `/root/test_${role}_invocation`,
      targetCommitSha: 'b'.repeat(40),
    })
  }
  recordBenchmark(rejectedState, rejected.id, { resultMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
  const rejectedRecord = structuredClone(rejected.validation)
  rejectedState.schemaVersion = 1
  for (const assessment of Object.values(rejected.assessments)) {
    delete assessment.invocationRef
    delete assessment.targetCommitSha
  }
  for (const event of rejectedState.checkpoint.events) {
    delete event.invocationRef
    delete event.assessmentCommitSha
  }

  assert.equal(validateState(rejectedState), rejectedState)
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.validation.accepted, false)
  assert.deepEqual(rejected.validation, rejectedRecord)
  assert.ok(Object.values(rejected.assessments).every(assessment => assessment?.passed === true))
})

test('benchmark regression is derived from metric direction and rejects the task', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-regression-test', maxCycles: 1 })
  addTask(state, { ...task('higher-is-better', { impact: 5 }), benchmarkDirection: 'higher_is_better' })
  const id = beginRun(state).task.id
  recordBaseline(state, id, { baselineMetric: 90, artifactRef: 'docs/ai-cost-controls.md' })
  recordImplementation(state, id, { branch: 'codex/higher-is-better', commitSha: 'b'.repeat(40) })
  recordTests(state, id, { passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  for (const role of ['reviewer', 'qa', 'quality', 'security']) {
    recordAssessment(state, id, {
      role, passed: true,
      artifactRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
      invocationRef: `/root/test_${role}_invocation`,
      targetCommitSha: 'b'.repeat(40),
    })
  }
  const rejected = recordBenchmark(state, id, {
    resultMetric: 85, artifactRef: 'docs/ai-cost-controls.md',
  })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.validation.reasonCode, 'benchmark_regression')
  assert.equal(state.checkpoint.cyclesValidated, 0)
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(validateState(state), state)
})

test('expensive benchmark work is blocked and the selector immediately advances', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-expensive-test', maxCycles: 3 })
  addTask(state, { ...task('expensive-task', { impact: 5, effort: 1 }), benchmarkCost: 'expensive' })
  addTask(state, task('affordable-task', { domain: 'frontend', impact: 4, effort: 1 }))

  const result = beginRun(state)
  const expensive = state.tasks.find(item => item.id === 'expensive-task')
  assert.equal(expensive.status, 'blocked')
  assert.equal(expensive.blocker.code, 'benchmark_expensive')
  assert.equal(result.task.id, 'affordable-task')
  assert.equal(state.checkpoint.selectedTaskId, 'affordable-task')
})

test('starting a new pilot archives immutable history and bounds active events', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-history-one', maxCycles: 2 })
  const count = state.checkpoint.events.length
  state.checkpoint.optimizationGate.status = 'STOPPED'
  state.checkpoint.optimizationGate.stopReason = 'budget'
  preparePilot(state, { pilotId: 'pilot-history-two' })
  startPreparedPilot(state, {
    pilotId: 'pilot-history-two', maxCycles: 10, approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  })

  assert.equal(count, 1)
  assert.equal(state.checkpoint.events.length, 1)
  assert.equal(state.checkpoint.eventArchives.flat()[0].type, 'pilot_started')
  assert.deepEqual(state.checkpoint.pilotHistory.map(x => x.pilotId), ['pilot-history-one'])
  assert.equal(state.checkpoint.events.at(-1).pilotId, 'pilot-history-two')
  assert.equal(validateState(state), state)
})

test('event history archives without dropping old transitions or pilot attribution', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'archive-events-pilot', maxCycles: 10 })
  for (let index = 0; index < 520; index += 1) {
    addTask(state, task(`archived-event-${index}`))
  }
  const allEvents = [...state.checkpoint.eventArchives.flat(), ...state.checkpoint.events]
  assert.equal(allEvents.length, 521)
  assert.ok(allEvents.every(event => event.pilotId === 'archive-events-pilot'))
  assert.ok(state.checkpoint.events.length < 500)
  assert.equal(validateState(state), state)
})

test('CLI persists a blocker fallback and resumes the same active task', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-optimizer-cli-'))
  const file = path.join(temp, 'state.json')
  const cliFile = path.resolve(__dirname, '../optimization-orchestrator.cjs')
  const run = (...args) => spawnSync(process.execPath, [cliFile, ...args, '--state', file], {
    encoding: 'utf8',
  })
  const firstTask = task('cli-blocked-task', { impact: 5, effort: 1 })
  const secondTask = task('cli-fallback-task', { domain: 'security', impact: 4, effort: 1 })
  try {
    assert.equal(run('init').status, 0)
    assert.equal(run('add-task', JSON.stringify(firstTask)).status, 0)
    assert.equal(run('add-task', JSON.stringify(secondTask)).status, 0)

    assert.equal(run('prepare-pilot', 'pilot-cli-explicit').status, 0)
    assert.equal(run('start-pilot', JSON.stringify({
      pilotId: 'pilot-cli-explicit', maxCycles: 10, approverIdentity: 'hamed',
      approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
    })).status, 0)
    const first = JSON.parse(run('begin').stdout)
    assert.equal(first.task.id, firstTask.id)
    const blocked = JSON.parse(run('diagnose-recovery', firstTask.id, JSON.stringify({
      diagnosisCode: 'existing_change_conflict',
      investigatorEvidenceRef: 'https://github.com/example/repo/pull/665',
      investigatorInvocationRef: 'test/investigator/cli-blocked-task/1',
      originalCheckRef: 'scripts/production/test_runtime.py',
      recoverable: false,
      blockerCode: 'existing_pr',
      nonRecoverableReasonCode: 'external_dependency',
    })).stdout)
    assert.equal(blocked.next.id, secondTask.id)
    assert.equal(JSON.parse(run('resume').stdout).reason, 'active_checkpoint_resumed')

    const diskState = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(diskState.tasks.find(item => item.id === firstTask.id).status, 'blocked')
    assert.equal(diskState.checkpoint.selectedTaskId, secondTask.id)
    assert.ok(diskState.checkpoint.events.some(event => event.type === 'blocked'))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('CLI approval transition requires explicit evidence and makes the task ready', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-optimizer-approval-cli-'))
  const file = path.join(temp, 'state.json')
  const cliFile = path.resolve(__dirname, '../optimization-orchestrator.cjs')
  const run = (...args) => spawnSync(process.execPath, [cliFile, ...args, '--state', file], { encoding: 'utf8' })
  try {
    assert.equal(run('init').status, 0)
    assert.equal(run('add-task', JSON.stringify({ ...task('cli-approval-task'), status: 'awaiting_approval' })).status, 0)
    const approved = run('approve', 'cli-approval-task', JSON.stringify(approvalAttestation(
      'https://github.com/example/repo/issues/31')))
    assert.equal(approved.status, 0, approved.stderr)
    assert.equal(JSON.parse(approved.stdout).status, 'ready')
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.ok(saved.checkpoint.events.some(event => event.type === 'approval_recorded' &&
      event.approvalEvidenceRef === 'https://github.com/example/repo/issues/31' &&
      event.approverIdentity === 'reviewer@example.com' && event.scopeCommitSha === 'd'.repeat(40)))
    assert.equal(validateState(saved), saved)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('cannot forge release of an initially awaiting-approval task', () => {
  const legacy = createInitialState()
  addTask(legacy, task('legacy-ready-discovery'))
  delete legacy.checkpoint.events.find(event => event.type === 'task_discovered').initialStatus
  assert.equal(validateState(legacy), legacy)

  const state = createInitialState()
  addTask(state, { ...task('approval-tamper-task'), status: 'awaiting_approval' })
  assert.equal(state.tasks[0].initialStatus, 'awaiting_approval')
  assert.equal(state.checkpoint.events[0].initialStatus, 'awaiting_approval')
  assert.equal(validateState(state), state)

  const forgedReady = structuredClone(state)
  forgedReady.tasks[0].status = 'ready'
  assert.throws(() => validateState(forgedReady), /changed status without structured approval evidence/)

  recordApproval(state, 'approval-tamper-task', approvalAttestation())
  assert.equal(state.tasks[0].status, 'ready')
  assert.equal(validateState(state), state)

  const removedApproval = structuredClone(state)
  removedApproval.checkpoint.events = removedApproval.checkpoint.events.filter(event => event.type !== 'approval_recorded')
  assert.throws(() => validateState(removedApproval), /changed status without structured approval evidence/)

  const removedBoth = structuredClone(state)
  removedBoth.checkpoint.events = removedBoth.checkpoint.events.filter(event =>
    !['approval_recorded', 'task_discovered'].includes(event.type))
  assert.throws(() => validateState(removedBoth), /lacks (?:a task_discovered event|its original approval discovery or approval evidence)/)

  const forgedInitialReady = structuredClone(state)
  forgedInitialReady.tasks[0].status = 'ready'
  forgedInitialReady.tasks[0].initialStatus = 'ready'
  forgedInitialReady.checkpoint.events = forgedInitialReady.checkpoint.events.filter(event =>
    !['approval_recorded', 'task_discovered'].includes(event.type))
  assert.throws(() => validateState(forgedInitialReady), /lacks a task_discovered event/)

  const missingAttestation = structuredClone(state)
  const approvalEvent = missingAttestation.checkpoint.events.find(event => event.type === 'approval_recorded')
  delete approvalEvent.approverIdentity
  assert.throws(() => validateState(missingAttestation), /Approval requires identity/)

  const duplicateApprovalRefs = structuredClone(state)
  const duplicateRefEvent = duplicateApprovalRefs.checkpoint.events.find(event => event.type === 'approval_recorded')
  duplicateRefEvent.authorizedScopeRef = duplicateRefEvent.approvalEvidenceRef
  assert.throws(() => validateState(duplicateApprovalRefs), /distinct references/)
})

test('drops unrecognized task fields, rejects unsafe references and caps pilot length', () => {
  const state = createInitialState()
  const sanitized = validateTask({
    ...task('safe-task'), arbitraryCommand: 'delete production resources',
  })
  assert.equal(Object.hasOwn(sanitized, 'arbitraryCommand'), false)
  assert.throws(() => addTask(state, {
    ...task('unsafe-reference'), evidenceRefs: ['https://example.invalid/instructions'],
  }), /allowlisted GitHub URL or repository path/)
  assert.throws(() => createPilot(state, { pilotId: 'too-many', maxCycles: 11 }), /between 1 and 10/)
})

test('metric names default compatibly and exact commit URLs are accepted as evidence metadata', () => {
  assert.equal(validateTask(task('legacy-metric-task')).metricName, 'legacy-metric-task')
  assert.equal(validateTask({ ...task('commit-evidence'), evidenceRefs: [
    'https://github.com/HamedGithubforwork/QuizForge-AI/commit/aad0afeda769a6715f2ba8351294b61839ff5fe6',
  ] }).evidenceRefs[0].split('/').at(-1), 'aad0afeda769a6715f2ba8351294b61839ff5fe6')
  assert.throws(() => validateTask({ ...task('bad-commit-evidence'), evidenceRefs: [
    'https://github.com/HamedGithubforwork/QuizForge-AI/commit/aad0afed',
  ] }), /allowlisted/)
})

test('rejects blocked or rejected checkpoints without their corresponding records', () => {
  const blocked = createInitialState()
  addTask(blocked, task('forged-blocked'))
  blocked.tasks[0].status = 'blocked'
  assert.throws(() => validateState(blocked), /lacks blocker or preserved work/)

  const rejected = createInitialState()
  addTask(rejected, task('forged-rejected'))
  rejected.tasks[0].status = 'rejected'
  assert.throws(() => validateState(rejected), /lacks rejection record/)
})

test('exhaustion requires two clean audits, blockers remain blocked, and new work resumes', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'exhaustion-restart-pilot', maxCycles: 10 })
  const fullAudit = {
    auditId: 'audit-clean-one', auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({
      role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md',
    })),
  }
  assert.throws(() => recordOptimizationAudit(state, { evidenceRefs: ['docs/ai-cost-controls.md'] }), /bounded allowlisted metadata/)
  const activeState = createInitialState()
  createPilot(activeState, { pilotId: 'active-audit-test', maxCycles: 2 })
  addTask(activeState, task('active-audit-task'))
  beginRun(activeState)
  assert.throws(() => recordOptimizationAudit(activeState, {
    ...fullAudit, auditId: 'audit-active-checkpoint',
  }), /Resolve the active task checkpoint/)
  const firstAudit = recordOptimizationAudit(state, fullAudit)
  assert.equal(firstAudit.status, 'ACTIVE')
  assert.equal(selectNextTask(state), null)
  const secondAudit = recordOptimizationAudit(state, { ...fullAudit, auditId: 'audit-clean-two' })
  assert.equal(secondAudit.status, 'OPTIMIZATION_EXHAUSTED')
  assert.deepEqual(secondAudit.finalReport.auditDimensions, [...AUDIT_DIMENSIONS])
  assert.equal(secondAudit.finalReport.auditEvidenceRefs[0], 'docs/ai-cost-controls.md')
  assert.ok(secondAudit.finalReport.restartCriteria.length > 0)
  assert.deepEqual(secondAudit.auditHistory.map(audit => audit.auditId), ['audit-clean-one', 'audit-clean-two'])
  assert.deepEqual(secondAudit.auditHistory[0].specialistAssessments.map(item => item.role), [...AUDIT_ROLES])
  assert.equal(validateState(state), state)
  const forgedAuditHistory = structuredClone(state)
  forgedAuditHistory.checkpoint.optimizationGate.auditHistory[0].evidenceRefs = []
  assert.throws(() => validateState(forgedAuditHistory), /persisted audit record/)
  const missingAudit = structuredClone(state)
  missingAudit.checkpoint.optimizationGate.auditHistory.pop()
  assert.throws(() => validateState(missingAudit), /two persisted complete clean audits/)
  assert.throws(() => recordOptimizationAudit(state, fullAudit), /Duplicate audit ID/)
  assert.equal(selectNextTask(state), null)
  const forgedReport = structuredClone(state)
  forgedReport.checkpoint.optimizationGate.finalReport.auditEvidenceRefs = []
  assert.throws(() => validateState(forgedReport), /Invalid optimization exhaustion gate/)

  const blockedState = createInitialState()
  createPilot(blockedState, { pilotId: 'blocked-audit-test', maxCycles: 2 })
  addTask(blockedState, task('blocked-audit-task'))
  blockWithDiagnosis(blockedState, beginRun(blockedState).task.id, 'existing_pr', 'https://github.com/example/repo/pull/665')
  const blockedAudit = recordOptimizationAudit(blockedState, { ...fullAudit, auditId: 'audit-blocked' })
  assert.equal(blockedAudit.status, 'BLOCKED')
  assert.notEqual(blockedAudit.status, 'OPTIMIZATION_EXHAUSTED')

  addTask(state, task('newly-actionable-task'))
  assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(state.checkpoint.optimizationGate.finalReport, null)
  const latestExhaustion = state.checkpoint.optimizationGate.auditHistory.at(-1)
  const exhaustionEventIndex = state.checkpoint.events.findIndex(event =>
    event.type === 'audit_completed' && event.auditId === latestExhaustion.auditId)
  const resumedEvent = state.checkpoint.events.findLast(event =>
    event.type === 'optimization_resumed' && event.taskId === 'newly-actionable-task')
  assert.notEqual(exhaustionEventIndex, -1)
  assert.ok(resumedEvent)
  resumedEvent.at = latestExhaustion.recordedAt
  // Model a timestamp tie and an event archive boundary. Event ordering, not
  // millisecond wall-clock resolution, proves that the actionable discovery
  // followed the exhaustion audit.
  state.checkpoint.eventArchives.push(state.checkpoint.events.splice(0, exhaustionEventIndex + 1))
  const pendingAfterExhaustion = preparePilot(state, { pilotId: 'pilot-after-exhaustion-reopened' })
  assert.equal(pendingAfterExhaustion.maxCycles, 10)
  assert.equal(state.checkpoint.selectedTaskId, null)
  assert.equal(validateState(state), state)
  assert.equal(selectNextTask(state).id, 'newly-actionable-task')
  assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
  // A separately corroborated specialist improvement also resets the audit counter.
  const resumed = recordOptimizationAudit(state, {
    auditId: 'audit-improvement',
    specialistAssessments: AUDIT_ROLES.map(role => ({
      role,
      finding: role === 'performance_efficiency_engineer' ? 'improvement_identified' :
        role === 'reviewer' ? 'improvement_confirmed' : 'clear',
      evidenceRef: 'docs/ai-cost-controls.md',
      ...(role === 'reviewer' ? { confirmsRole: 'performance_efficiency_engineer' } : {}),
    })),
    auditedDimensions: [...AUDIT_DIMENSIONS],
    evidenceRefs: ['scripts/autonomy/test/optimization-orchestrator.test.cjs'],
  })
  assert.equal(resumed.status, 'ACTIVE')
  assert.equal(selectNextTask(state).id, 'newly-actionable-task')
})

test('audit history accepts the 101st audit without losing the exhaustion evidence', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'audit-history-rollover-test', maxCycles: 10 })
  const input = {
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  }
  let result
  for (let index = 0; index < 101; index += 1) {
    result = recordOptimizationAudit(state, { ...input, auditId: `audit-roll-${String(index).padStart(3, '0')}` })
  }
  assert.equal(result.auditHistory.length, 101)
  assert.equal(result.status, 'OPTIMIZATION_EXHAUSTED')
  assert.equal(result.finalReport.audits.length, 2)
  assert.equal(state.checkpoint.events.filter(event => event.auditId).length, 101)
  assert.equal(validateState(state), state)
  assert.throws(() => recordOptimizationAudit(state, { ...input, auditId: 'audit-roll-100' }), /Duplicate audit ID/)
})

test('task capacity rejects before mutation and preserves the existing backlog', () => {
  const state = createInitialState()
  state.tasks = Array.from({ length: 1000 }, (_, index) => ({ id: `preserved-${index}` }))
  const before = structuredClone(state.tasks)
  assert.throws(() => addTask(state, task('over-capacity')), /Task capacity reached \(1000\)/)
  assert.deepEqual(state.tasks, before)
})

test('reaching the cycle cap persists a budget stop rather than exhaustion', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'cycle-budget-test', maxCycles: 1 })
  addTask(state, task('last-cycle-task'))
  const active = beginRun(state).task
  blockWithDiagnosis(state, active.id, 'existing_pr', 'https://github.com/example/repo/pull/88')
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(startNewCycle(state).reason, 'cycle_limit_reached')
  assert.equal(validateState(state), state)

  const finishLastCycle = ({ passedTests = true, resultMetric = 8 } = {}) => {
    const finalState = createInitialState()
    createPilot(finalState, { pilotId: `final-cycle-${passedTests ? 'success' : 'rejected'}`, maxCycles: 1 })
    const selected = addTask(finalState, task(`final-cycle-${passedTests ? 'success' : 'rejected'}`))
    const active = beginRun(finalState).task
    recordBaseline(finalState, active.id, { baselineMetric: 10, artifactRef: 'docs/ai-cost-controls.md' })
    recordImplementation(finalState, active.id, {
      branch: `codex/${selected.id}`, commitSha: 'c'.repeat(40),
    })
    if (!passedTests) {
      recordTests(finalState, active.id, {
        passed: false, artifactRef: 'scripts/production/test_runtime.py',
      })
      blockWithDiagnosis(finalState, active.id, 'unavailable_evidence')
      assert.equal(finalState.tasks[0].status, 'blocked')
    } else {
      recordTests(finalState, active.id, {
        passed: true, artifactRef: 'scripts/production/test_runtime.py',
      })
      for (const role of ['reviewer', 'qa', 'quality', 'security']) {
        recordAssessment(finalState, active.id, {
          role, passed: true,
          artifactRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
          invocationRef: `/root/test_${role}_invocation`,
          targetCommitSha: active.implementation.commitSha,
        })
      }
      const completed = recordBenchmark(finalState, active.id, {
        resultMetric, artifactRef: 'docs/ai-cost-controls.md',
      })
      assert.equal(completed.status, 'validated')
    }
    assert.equal(finalState.checkpoint.optimizationGate.status, 'STOPPED')
    assert.equal(finalState.checkpoint.optimizationGate.stopReason, 'budget')
    assert.equal(validateState(finalState), finalState)
  }

  finishLastCycle()
  finishLastCycle({ passedTests: false })
})

test('awaiting approval is held behind the blocked audit gate', () => {
  const state = createInitialState()
  addTask(state, { ...task('approval-task'), status: 'awaiting_approval' })
  const result = recordOptimizationAudit(state, {
    auditId: 'audit-awaiting',
    auditedDimensions: [...AUDIT_DIMENSIONS],
    evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({
      role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md',
    })),
  })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(selectNextTask(state), null)
})

test('awaiting approval releases only with evidence and independent tasks can proceed', async () => {
  const state = createInitialState()
  addTask(state, { ...task('approval-required-task'), status: 'awaiting_approval' })
  recordOptimizationAudit(state, {
    auditId: 'audit-approval-gate', immediateStopCode: 'approval',
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  })
  assert.throws(() => recordApproval(state, 'approval-required-task', approvalAttestation('unsafe://approval')), /allowlisted/)
  assert.equal(selectNextTask(state), null)
  const released = recordApproval(state, 'approval-required-task', approvalAttestation('https://github.com/example/repo/issues/21'))
  assert.equal(released.status, 'ready')
  assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(selectNextTask(state).id, 'approval-required-task')

  const independent = createInitialState()
  addTask(independent, { ...task('awaiting-one'), status: 'awaiting_approval' })
  recordOptimizationAudit(independent, {
    auditId: 'audit-approval-gate-two', immediateStopCode: 'approval',
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  })
  addTask(independent, task('independent-ready-task'))
  assert.equal(independent.tasks.find(item => item.id === 'awaiting-one').status, 'awaiting_approval')
  assert.equal(independent.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(selectNextTask(independent).id, 'independent-ready-task')

  const exhausted = createInitialState()
  const cleanAudit = {
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  }
  recordOptimizationAudit(exhausted, { ...cleanAudit, auditId: 'audit-approval-clean-one' })
  recordOptimizationAudit(exhausted, { ...cleanAudit, auditId: 'audit-approval-clean-two' })
  addTask(exhausted, { ...task('approval-after-exhaustion'), status: 'awaiting_approval' })
  assert.equal(exhausted.checkpoint.optimizationGate.status, 'BLOCKED')
  assert.equal(exhausted.checkpoint.optimizationGate.stopReason, 'approval')
  assert.equal(exhausted.checkpoint.optimizationGate.consecutiveCleanAudits, 0)
  assert.equal(exhausted.checkpoint.optimizationGate.finalReport, null)
  assert.deepEqual(exhausted.checkpoint.optimizationGate.auditHistory.map(audit => audit.auditId), [
    'audit-approval-clean-one', 'audit-approval-clean-two',
  ])
  assert.equal(selectNextTask(exhausted), null)
  assert.equal(validateState(exhausted), exhausted)
  const approvalStatePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-awaiting-approval-')), 'state.json')
  try {
    await saveState(approvalStatePath, exhausted)
    const reloaded = await loadState(approvalStatePath)
    assert.equal(reloaded.checkpoint.optimizationGate.status, 'BLOCKED')
    assert.equal(reloaded.checkpoint.optimizationGate.stopReason, 'approval')
    assert.deepEqual(reloaded.checkpoint.optimizationGate.auditHistory.map(audit => audit.auditId), [
      'audit-approval-clean-one', 'audit-approval-clean-two',
    ])
    assert.equal(selectNextTask(reloaded), null)
    assert.throws(() => recordApproval(reloaded, 'approval-after-exhaustion',
      approvalAttestation('unsafe://approval')), /allowlisted/)
    assert.equal(validateState(reloaded), reloaded)
    assert.equal(reloaded.checkpoint.optimizationGate.status, 'BLOCKED')
    assert.equal(selectNextTask(reloaded), null)
    recordApproval(reloaded, 'approval-after-exhaustion', approvalAttestation('https://github.com/example/repo/issues/22'))
    assert.equal(reloaded.checkpoint.optimizationGate.status, 'ACTIVE')
    assert.equal(selectNextTask(reloaded).id, 'approval-after-exhaustion')
    assert.equal(validateState(reloaded), reloaded)
  } finally {
    await fs.rm(path.dirname(approvalStatePath), { recursive: true, force: true })
  }
  assert.equal(exhausted.tasks.find(item => item.id === 'approval-after-exhaustion').status, 'awaiting_approval')
  recordApproval(exhausted, 'approval-after-exhaustion', approvalAttestation('https://github.com/example/repo/issues/22'))
  assert.equal(exhausted.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(selectNextTask(exhausted).id, 'approval-after-exhaustion')
  assert.equal(validateState(exhausted), exhausted)
})

test('unconfirmed specialist improvement remains blocked and new evidence clears an exhausted gate', () => {
  const state = createInitialState()
  const assessments = AUDIT_ROLES.map(role => ({
    role, finding: role === 'performance_efficiency_engineer' ? 'improvement_identified' : 'clear',
    evidenceRef: 'docs/ai-cost-controls.md',
  }))
  const gate = recordOptimizationAudit(state, {
    auditId: 'audit-unconfirmed-improvement', auditedDimensions: [...AUDIT_DIMENSIONS],
    evidenceRefs: ['docs/ai-cost-controls.md'], specialistAssessments: assessments,
  })
  assert.equal(gate.status, 'BLOCKED')
  assert.equal(selectNextTask(state), null)

  const evidenceState = createInitialState()
  createPilot(evidenceState, { pilotId: 'pilot-reopen-evidence', maxCycles: 2 })
  addTask(evidenceState, task('evidence-after-exhaustion'))
  const picked = beginRun(evidenceState).task
  blockWithDiagnosis(evidenceState, picked.id, 'unavailable_evidence')
  evidenceState.checkpoint.optimizationGate.status = 'OPTIMIZATION_EXHAUSTED'
  evidenceState.checkpoint.optimizationGate.consecutiveCleanAudits = 2
  recordNewEvidence(evidenceState, picked.id, 'https://github.com/example/repo/actions/runs/123')
  assert.equal(evidenceState.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(evidenceState.checkpoint.optimizationGate.finalReport, null)
  assert.equal(selectNextTask(evidenceState).id, picked.id)
})

test('approval gates as BLOCKED; budget, security, and correctness stop immediately', () => {
  const audit = {
    auditId: 'audit-immediate-stop',
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  }
  const approval = createInitialState()
  assert.equal(recordOptimizationAudit(approval, { ...audit, immediateStopCode: 'approval' }).status, 'BLOCKED')
  assert.equal(approval.checkpoint.optimizationGate.stopReason, 'approval')
  for (const immediateStopCode of ['budget', 'security', 'correctness']) {
    const state = createInitialState()
    assert.equal(recordOptimizationAudit(state, { ...audit, immediateStopCode }).status, 'STOPPED')
    assert.equal(state.checkpoint.optimizationGate.stopReason, immediateStopCode)
    assert.equal(selectNextTask(state), null)
    assert.throws(() => recordOptimizationAudit(state, {
      ...audit, auditId: `audit-ordinary-after-${immediateStopCode}`,
    }), /Stopped optimization gate requires/)
    assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
    assert.equal(state.checkpoint.optimizationGate.stopReason, immediateStopCode)
  }
  const newBudget = createInitialState()
  recordOptimizationAudit(newBudget, { ...audit, immediateStopCode: 'budget' })
  preparePilot(newBudget, { pilotId: 'explicit-new-budget' })
  startPreparedPilot(newBudget, {
    pilotId: 'explicit-new-budget', maxCycles: 10, approverIdentity: 'hamed',
    approvalEvidenceRef: 'docs/autonomy/optimization-loop.md',
  })
  assert.equal(newBudget.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(newBudget.checkpoint.optimizationGate.stopReason, null)
})

test('security and correctness stops require explicit remediation and independent release evidence', () => {
  const baseAudit = {
    auditId: 'audit-stop-release', auditedDimensions: [...AUDIT_DIMENSIONS],
    evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  }
  for (const stopReason of ['security', 'correctness']) {
    const state = createInitialState()
    recordOptimizationAudit(state, { ...baseAudit, immediateStopCode: stopReason })
    const release = {
      remediationEvidenceRef: 'docs/autonomy/optimization-loop.md',
      authorizedScopeRef: '.github/workflows/quizforge-autonomy-bridge.yml',
      scopeCommitSha: 'e'.repeat(40),
      approvals: [
        { role: 'reviewer', identity: 'reviewer@example.com', evidenceRef: 'docs/local-qwen-pilot-progress.md' },
        { role: 'qa', identity: 'qa@example.com', evidenceRef: 'scripts/autonomy/test/optimization-orchestrator.test.cjs' },
        { role: 'security_privacy_engineer', identity: 'security@example.com', evidenceRef: 'docs/autonomy/optimization-report-template.md' },
        ...(stopReason === 'correctness' ? [
          { role: 'ai_quality_engineer', identity: 'ai-quality@example.com', evidenceRef: 'docs/autonomy/optimization-state.json' },
        ] : []),
      ],
    }
    assert.throws(() => releaseStopGate(state, { ...release, scopeCommitSha: 'bad' }), /exact reviewed scope/)
    assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
    releaseStopGate(state, release)
    assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
    assert.equal(state.checkpoint.optimizationGate.stopReason, null)
    assert.equal(validateState(state), state)
    const forgedRelease = structuredClone(state)
    const releaseEvent = forgedRelease.checkpoint.events.find(event => event.type === 'stop_released')
    releaseEvent.authorizedScopeRef = releaseEvent.evidenceRef
    assert.throws(() => validateState(forgedRelease), /distinct scope and evidence references/)
  }
})

test('rejects forged validated checkpoint missing lifecycle evidence', () => {
  const state = createInitialState()
  addTask(state, task('forged-validated'))
  const forged = structuredClone(state)
  Object.assign(forged.tasks[0], { status: 'validated' })
  assert.throws(() => validateState(forged), /lacks baseline/)
})

test('saveState recovers a provably dead owner lock and refuses an active lock', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-optimizer-lock-'))
  try {
    const staleFile = path.join(temp, 'stale.json')
    await fs.writeFile(`${staleFile}.lock`, JSON.stringify({
      pid: 2147483647, host: os.hostname(), createdAt: new Date().toISOString(), token: 'dead-owner',
    }))
    await saveState(staleFile, createInitialState())
    assert.ok(JSON.parse(await fs.readFile(staleFile, 'utf8')))
    await assert.rejects(fs.access(`${staleFile}.lock`), { code: 'ENOENT' })

    const activeFile = path.join(temp, 'active.json')
    const activeLock = JSON.stringify({
      pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: 'live-owner',
    })
    await fs.writeFile(`${activeFile}.lock`, activeLock)
    await assert.rejects(saveState(activeFile, createInitialState()), /live orchestrator process/)
    assert.equal(await fs.readFile(`${activeFile}.lock`, 'utf8'), activeLock)

    const collisionFile = path.join(temp, 'recovery-collision.json')
    const deadLock = JSON.stringify({
      pid: 2147483647, host: os.hostname(), createdAt: new Date().toISOString(), token: 'dead-collision-owner',
    })
    const recoveryMarker = 'another-process-recovery-guard'
    await fs.writeFile(`${collisionFile}.lock`, deadLock)
    await fs.writeFile(`${collisionFile}.lock.recovery`, recoveryMarker)
    await assert.rejects(saveState(collisionFile, createInitialState()), /recovery is already in progress/)
    assert.equal(await fs.readFile(`${collisionFile}.lock`, 'utf8'), deadLock)
    assert.equal(await fs.readFile(`${collisionFile}.lock.recovery`, 'utf8'), recoveryMarker)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('concurrent checkpoint writers reject stale revisions without losing the first update', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-revision-'))
  const file = path.join(dir, 'state.json')
  try {
    await saveState(file, createInitialState())
    const [writerA, writerB] = await Promise.all([
      fs.readFile(file, 'utf8').then(JSON.parse),
      fs.readFile(file, 'utf8').then(JSON.parse),
    ])
    addTask(writerA, task('revision-writer-a'))
    addTask(writerB, task('revision-writer-b'))
    const results = await Promise.allSettled([saveState(file, writerA), saveState(file, writerB)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.match(rejected.reason.message, /Stale checkpoint revision|locked/)
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(persisted.checkpoint.revision, 2)
    assert.equal(persisted.tasks.length, 1)
    assert.equal(validateState(persisted), persisted)
    const stale = results[0].status === 'rejected' ? writerA : writerB
    await assert.rejects(saveState(file, stale), /Stale checkpoint revision/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('autonomy bridge records blocker fallback without a global stop instruction', async () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/quizforge-autonomy-bridge.yml')
  const workflow = await fs.readFile(workflowPath, 'utf8')

  assert.doesNotMatch(workflow, /do not advance (?:the )?(?:roadmap|backlog)/i)
  assert.match(workflow,
    /its blocker will be recorded while the Coordinator selects another independent actionable task/i)
  assert.match(workflow,
    /Preserve the task and its evidence as blocked\.[\s\S]*Immediately select the highest-value independent actionable backlog task\.[\s\S]*distinct new evidence/i)
})

test('pull_request_target bridge stays metadata-only and does not check out PR code', async () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/quizforge-autonomy-bridge.yml')
  const workflow = await fs.readFile(workflowPath, 'utf8')
  const mergedJob = workflow.split('  queue-merged-pr:')[1]?.split('  queue-repeat-failure:')[0]

  assert.ok(mergedJob)
  assert.match(mergedJob, /github\.event\.pull_request\.(?:number|title|base\.ref|merge_commit_sha)/)
  assert.doesNotMatch(mergedJob, /actions\/checkout|checkout@/i)
})

test('autonomy bridge write permissions are scoped to jobs', async () => {
  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/quizforge-autonomy-bridge.yml')
  const workflow = await fs.readFile(workflowPath, 'utf8')
  const globalPermissions = workflow.match(/^permissions:\r?\n((?:  [^\r\n]*\r?\n)+)/m)?.[1]

  assert.ok(globalPermissions)
  assert.match(globalPermissions, /contents: read/)
  assert.doesNotMatch(globalPermissions, /write/)
  assert.match(workflow, /retry-once:[\s\S]*?\r?\n    permissions:\r?\n      actions: write\r?\n      issues: write/)
  assert.match(workflow, /queue-merged-pr:[\s\S]*?\r?\n    permissions:\r?\n      issues: write/)
  assert.match(workflow, /queue-repeat-failure:[\s\S]*?\r?\n    permissions:\r?\n      issues: write/)
  assert.doesNotMatch(workflow, /pull-requests: write/)
})

// The Required PR CI workflow invokes this test file as its deterministic
// autonomy suite; keep the supervised authorization regressions in that gate.
require('./supervised-merge-policy.test.cjs')
