'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  AUDIT_DIMENSIONS, AUDIT_ROLES, addTask, beginRun, blockTask, createInitialState, createPilot,
  recordApproval, recordAssessment, recordBaseline, recordBenchmark, recordImplementation,
  recordNewEvidence, recordOptimizationAudit, recordTests, releaseStopGate, resume, saveState, selectNextTask,
  startNewCycle, validateState, validateTask,
} = require('../optimization-orchestrator.cjs')

function task(id, { domain = 'backend', impact = 3, effort = 2, risk = 1, dependencies = [] } = {}) {
  return {
    id, domain, title: `Improve ${id.replace(/-/g, ' ')}`,
    impact, effort, risk, dependencies, evidenceRefs: ['docs/ai-cost-controls.md'],
    testRefs: ['scripts/production/test_runtime.py'], benchmarkRefs: [],
  }
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
  const outcome = blockTask(state, selected.id, 'existing_pr', 'https://github.com/example/repo/pull/665')

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

test('blocked task requires distinct new evidence before it can be selected again', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-evidence-test', maxCycles: 4 })
  addTask(state, task('evidence-task', { impact: 5, effort: 1 }))
  addTask(state, task('fallback-task', { impact: 4, effort: 1 }))
  const first = beginRun(state).task
  blockTask(state, first.id, 'unavailable_evidence', 'docs/ai-cost-controls.md')

  assert.throws(() => recordNewEvidence(state, first.id, 'docs/ai-cost-controls.md'), /distinct/)
  assert.throws(() => addTask(state, {
    ...task('duplicate-investigation'), investigationKey: first.investigationKey,
  }), /investigation already exists/)
  recordNewEvidence(state, first.id, 'https://github.com/example/repo/actions/runs/123')
  assert.equal(state.tasks.find(item => item.id === first.id).status, 'ready')
  assert.equal(state.tasks.find(item => item.id === first.id).evidenceRevision, 1)
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
  recordAssessment(state, id, { role: 'reviewer', passed: true, artifactRef: 'docs/ai-cost-controls.md' })
  recordAssessment(state, id, { role: 'qa', passed: true, artifactRef: 'scripts/production/test_runtime.py' })
  recordAssessment(state, id, { role: 'quality', passed: true, artifactRef: 'docs/ai-cost-controls.md' })
  recordAssessment(state, id, { role: 'security', passed: true, artifactRef: 'docs/ai-cost-controls.md' })
  const validated = recordBenchmark(state, id, {
    resultMetric: 8, artifactRef: 'docs/ai-cost-controls.md',
  })
  assert.equal(validated.status, 'validated')
  assert.equal(state.checkpoint.cyclesValidated, 1)
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(validateState(state), state)
  assert.equal(startNewCycle(state).reason, 'cycle_limit_reached')
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

test('starting a new pilot retains historical checkpoint events', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'pilot-history-one', maxCycles: 2 })
  const count = state.checkpoint.events.length
  createPilot(state, { pilotId: 'pilot-history-two', maxCycles: 3 })

  assert.equal(state.checkpoint.events.length, count + 1)
  assert.equal(state.checkpoint.events[0].type, 'pilot_started')
  assert.equal(state.checkpoint.events.at(-1).pilotId, 'pilot-history-two')
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

    const first = JSON.parse(run('begin').stdout)
    assert.equal(first.task.id, firstTask.id)
    const blocked = JSON.parse(run('block', firstTask.id, 'existing_pr',
      'https://github.com/example/repo/pull/665').stdout)
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
    const approved = run('approve', 'cli-approval-task', 'https://github.com/example/repo/issues/31')
    assert.equal(approved.status, 0, approved.stderr)
    assert.equal(JSON.parse(approved.stdout).status, 'ready')
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.ok(saved.checkpoint.events.some(event => event.type === 'approval_recorded' &&
      event.evidenceRef === 'https://github.com/example/repo/issues/31'))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
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
  blockTask(blockedState, beginRun(blockedState).task.id, 'existing_pr', 'https://github.com/example/repo/pull/665')
  const blockedAudit = recordOptimizationAudit(blockedState, { ...fullAudit, auditId: 'audit-blocked' })
  assert.equal(blockedAudit.status, 'BLOCKED')
  assert.notEqual(blockedAudit.status, 'OPTIMIZATION_EXHAUSTED')

  addTask(state, task('newly-actionable-task'))
  assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(state.checkpoint.optimizationGate.finalReport, null)
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

test('reaching the cycle cap persists a budget stop rather than exhaustion', () => {
  const state = createInitialState()
  createPilot(state, { pilotId: 'cycle-budget-test', maxCycles: 1 })
  addTask(state, task('last-cycle-task'))
  const active = beginRun(state).task
  blockTask(state, active.id, 'existing_pr', 'https://github.com/example/repo/pull/88')
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
      const rejected = recordTests(finalState, active.id, {
        passed: false, artifactRef: 'scripts/production/test_runtime.py',
      })
      assert.equal(rejected.status, 'rejected')
    } else {
      recordTests(finalState, active.id, {
        passed: true, artifactRef: 'scripts/production/test_runtime.py',
      })
      for (const role of ['reviewer', 'qa', 'quality', 'security']) {
        recordAssessment(finalState, active.id, {
          role, passed: true,
          artifactRef: role === 'qa' ? 'scripts/production/test_runtime.py' : 'docs/ai-cost-controls.md',
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

test('awaiting approval releases only with evidence and independent tasks can proceed', () => {
  const state = createInitialState()
  addTask(state, { ...task('approval-required-task'), status: 'awaiting_approval' })
  recordOptimizationAudit(state, {
    auditId: 'audit-approval-gate', immediateStopCode: 'approval',
    auditedDimensions: [...AUDIT_DIMENSIONS], evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  })
  assert.throws(() => recordApproval(state, 'approval-required-task', 'unsafe://approval'), /allowlisted/)
  assert.equal(selectNextTask(state), null)
  const released = recordApproval(state, 'approval-required-task', 'https://github.com/example/repo/issues/21')
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
  assert.equal(exhausted.checkpoint.optimizationGate.status, 'OPTIMIZATION_EXHAUSTED')
  recordApproval(exhausted, 'approval-after-exhaustion', 'https://github.com/example/repo/issues/22')
  assert.equal(exhausted.checkpoint.optimizationGate.status, 'ACTIVE')
  assert.equal(selectNextTask(exhausted).id, 'approval-after-exhaustion')
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
  blockTask(evidenceState, picked.id, 'unavailable_evidence', 'docs/ai-cost-controls.md')
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
  createPilot(newBudget, { pilotId: 'explicit-new-budget', maxCycles: 2 })
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
      evidenceRef: 'docs/autonomy/optimization-loop.md',
      reviewerEvidenceRef: 'docs/local-qwen-pilot-progress.md',
      qaEvidenceRef: 'scripts/autonomy/test/optimization-orchestrator.test.cjs',
      securityEvidenceRef: '.github/workflows/quizforge-autonomy-bridge.yml',
      scopeReviewed: true,
      ...(stopReason === 'correctness' ? { aiQualityEvidenceRef: 'docs/autonomy/optimization-report-template.md' } : {}),
    }
    assert.throws(() => releaseStopGate(state, { ...release, scopeReviewed: false }), /safe-scope review/)
    assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
    releaseStopGate(state, release)
    assert.equal(state.checkpoint.optimizationGate.status, 'ACTIVE')
    assert.equal(state.checkpoint.optimizationGate.stopReason, null)
    assert.equal(validateState(state), state)
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
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
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

