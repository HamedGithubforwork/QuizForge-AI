'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const policy = require('../supervised-merge-policy.cjs')
const orchestrator = require('../optimization-orchestrator.cjs')

const repository = 'HamedGithubforwork/QuizForge-AI'
const runId = 'pilot-supervised-test'
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const diff = 'c'.repeat(64)
const pr = 73
const prRef = `https://github.com/${repository}/pull/${pr}`
const now = new Date()

function authorization(overrides = {}) {
  const authorizedAt = new Date(now.getTime() - 60_000).toISOString()
  const expiresAt = new Date(now.getTime() + 86_400_000).toISOString()
  return {
    authorizationId: 'auth-supervised-test', policyVersion: policy.POLICY_VERSION,
    policyDigest: policy.POLICY_DIGEST, repository, runId,
    objectives: ['application_performance'], allowedCategories: ['low_risk_ui'],
    maxTasks: 2, maxCycles: 10,
    resourceBudget: { maxCiRuns: 2, maxLocalBenchmarkMinutes: 0, paidWorkflowRuns: 0 },
    authorizedBy: 'coordinator@example.test', authorizedAt,
    expiresAt, approvalEvidenceRef: prRef,
    status: 'active', revokedAt: null, revocationEvidenceRef: null,
    ...overrides,
  }
}

function evidence(overrides = {}) {
  return {
    repository, runId, taskId: 'task-ui-polish', objective: 'application_performance',
    policyDigest: policy.POLICY_DIGEST, prNumber: pr, prUrl: prRef,
    prCreatedAt: new Date(now.getTime() - 30_000).toISOString(),
    headSha: head, baseSha: base, category: 'low_risk_ui', diffSha256: diff,
    diffEvidenceRef: `${prRef}/files`, impactEvidenceRef: prRef, riskFindings: [],
    resourceUsage: { ciRunsUsed: 1, localBenchmarkMinutesUsed: 0, paidWorkflowRuns: 0, evidenceRef: prRef },
    reviewer: { passed: true, commitSha: head, evidenceRef: prRef },
    qa: { passed: true, commitSha: head, evidenceRef: prRef },
    specialistAssessments: [{ role: 'ui_ux', status: 'passed', commitSha: head, evidenceRef: prRef }],
    requiredCheck: { name: 'Required PR gate', conclusion: 'success', headSha: head,
      baseSha: base, prNumber: pr, runUrl: `https://github.com/${repository}/actions/runs/987654` },
    reviews: { blocking: false, evidenceRef: prRef },
    protections: { verified: true, evidenceRef: prRef, rulesetRef: `https://github.com/${repository}/rulesets/4321` },
    sideEffects: { assessed: true, evidenceRef: prRef, productionDeployment: false,
      cloudSpend: false, destructive: false, unexpectedExternalSideEffects: false },
    mergeManager: { passed: true, headSha: head, baseSha: base, diffSha256: diff,
      diffInspected: true, evidenceRef: prRef },
    ...overrides,
  }
}

test('manual remains default and Fully Autonomous cannot be activated', () => {
  assert.equal(orchestrator.createInitialState().checkpoint.mergeMode, 'manual')
  const state = orchestrator.createInitialState()
  orchestrator.preparePilot(state, { pilotId: runId })
  assert.throws(() => orchestrator.startPreparedPilot(state, {
    pilotId: runId, maxCycles: 10, approverIdentity: 'coordinator@example.test',
    approvalEvidenceRef: 'docs/autonomy/supervised-merge.md', mergeMode: 'fully_autonomous',
  }), /future-only/)
})

test('the authorized maxTasks cap stops further selection after a rejected task consumes the slot', () => {
  const state = orchestrator.createInitialState()
  for (const id of ['task-first', 'task-next']) {
    orchestrator.addTask(state, { id, domain: 'frontend', title: `Improve ${id}`,
      impact: 2, effort: 1, risk: 1, dependencies: [], evidenceRefs: ['docs/autonomy/supervised-merge.md'],
      testRefs: ['scripts/autonomy/test/supervised-merge-policy.test.cjs'], benchmarkRefs: [] })
  }
  orchestrator.preparePilot(state, { pilotId: runId })
  orchestrator.startPreparedPilot(state, { pilotId: runId, maxCycles: 10,
    approverIdentity: 'coordinator@example.test', approvalEvidenceRef: 'docs/autonomy/supervised-merge.md',
    mergeMode: 'supervised_autonomous', mergeAuthorization: authorization({ maxTasks: 1 }) })
  const first = orchestrator.selectTask(state)
  orchestrator.rejectTask(state, first.id, 'reviewer_rejected', prRef)
  assert.equal(state.checkpoint.cyclesStarted, 1)
  assert.equal(orchestrator.selectTask(state), null)
  assert.equal(state.checkpoint.optimizationGate.status, 'STOPPED')
  assert.equal(state.checkpoint.optimizationGate.stopReason, 'budget')
  assert.equal(state.checkpoint.events.at(-1).type, 'supervised_task_limit_reached')
  assert.equal(state.tasks.find(item => item.id === 'task-next').status, 'ready')
})

test('eligibility binds scope, policy digest, exact CI, protections, side effects, and Manager diff inspection', () => {
  const args = { mode: 'supervised_autonomous', authorization: authorization(), evidence: evidence(),
    pilotId: runId, maxCycles: 10, cyclesStarted: 1, tasksSelected: 1, now }
  assert.deepEqual(policy.evaluateSupervisedMerge(args), { eligible: true, reason: 'eligible' })
  for (const bad of [
    { evidence: evidence({ requiredCheck: { ...evidence().requiredCheck, headSha: base } }) },
    { evidence: evidence({ requiredCheck: { ...evidence().requiredCheck, baseSha: head } }) },
    { evidence: evidence({ requiredCheck: { ...evidence().requiredCheck, prNumber: pr + 1 } }) },
    { evidence: evidence({ requiredCheck: { ...evidence().requiredCheck, conclusion: 'failure' } }) },
    { evidence: evidence({ protections: { verified: false, evidenceRef: prRef, rulesetRef: prRef } }) },
    { evidence: evidence({ sideEffects: { ...evidence().sideEffects, cloudSpend: true } }) },
    { evidence: evidence({ mergeManager: { ...evidence().mergeManager, diffInspected: false } }) },
    { evidence: evidence({ policyDigest: '0'.repeat(64) }) },
    { evidence: evidence({ prCreatedAt: new Date(now.getTime() - 120_000).toISOString() }) },
    { authorization: authorization({ policyDigest: '0'.repeat(64) }) },
    { authorization: authorization({ status: 'revoked', revokedAt: now.toISOString(), revocationEvidenceRef: prRef }) },
    { authorization: null },
    { authorization: authorization({ runId: 'another-run' }) },
    { authorization: authorization({ expiresAt: new Date(now.getTime() - 1000).toISOString() }) },
    { evidence: evidence({ riskFindings: ['authentication'] }) },
    { evidence: evidence({ riskFindings: ['uncertain'] }) },
    { evidence: evidence({ resourceUsage: undefined }) },
    { evidence: evidence({ resourceUsage: { ciRunsUsed: 3, localBenchmarkMinutesUsed: 0, paidWorkflowRuns: 0, evidenceRef: prRef } }) },
    { evidence: evidence({ resourceUsage: { ciRunsUsed: 1, localBenchmarkMinutesUsed: 1, paidWorkflowRuns: 0, evidenceRef: prRef } }) },
    { evidence: evidence({ resourceUsage: { ciRunsUsed: 1, localBenchmarkMinutesUsed: 0, paidWorkflowRuns: 1, evidenceRef: prRef } }) },
    { evidence: evidence({ objective: 'learner_grading_correctness' }) },
    { maxCycles: 9 },
    { tasksSelected: 3 },
  ]) {
    assert.equal(policy.evaluateSupervisedMerge({ ...args, ...bad }).eligible, false)
  }
  assert.equal(policy.evaluateSupervisedMerge({ ...args, mode: 'manual' }).reason, 'manual_mode')
  assert.equal(policy.evaluateSupervisedMerge({ ...args, mode: 'fully_autonomous' }).reason, 'fully_autonomous_disabled')
})

test('decision audit persists rejected evidence without fabricated PR/task placeholders and survives checkpoint reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quizforge-supervised-'))
  const checkpoint = path.join(dir, 'checkpoint.json')
  try {
    const state = orchestrator.createInitialState()
    orchestrator.addTask(state, { id: 'task-ui-polish', domain: 'frontend', title: 'Polish a small UI detail',
      impact: 2, effort: 1, risk: 1, dependencies: [], evidenceRefs: ['docs/autonomy/supervised-merge.md'],
      testRefs: ['scripts/autonomy/test/supervised-merge-policy.test.cjs'], benchmarkRefs: [] })
    orchestrator.preparePilot(state, { pilotId: runId })
    orchestrator.startPreparedPilot(state, { pilotId: runId, maxCycles: 10,
      approverIdentity: 'coordinator@example.test', approvalEvidenceRef: 'docs/autonomy/supervised-merge.md',
      mergeMode: 'supervised_autonomous', mergeAuthorization: authorization() })
    const result = orchestrator.recordSupervisedMergeDecision(state, { taskId: 'task-ui-polish' })
    assert.equal(result.eligible, false)
    const record = state.checkpoint.events.find(event => event.type === 'supervised_merge_decision').mergeRecord
    assert.equal(record.outcome, 'rejected')
    assert.equal(record.prNumber, null)
    assert.equal(record.prUrl, null)
    assert.equal(record.taskId, 'task-ui-polish')
    for (let index = 0; index < 500; index += 1) {
      state.checkpoint.events.push({ at: new Date().toISOString(), type: 'optimization_resumed',
        pilotId: runId, taskId: 'task-ui-polish', reasonCode: 'new_actionable_task' })
    }
    orchestrator.revokeSupervisedMerges(state, prRef)
    assert.ok(state.checkpoint.eventArchives.flat().some(event => event.type === 'supervised_merge_decision'))
    await orchestrator.saveState(checkpoint, state, dir)
    const reloaded = await orchestrator.loadState(checkpoint, dir)
    assert.equal([...reloaded.checkpoint.eventArchives.flat(), ...reloaded.checkpoint.events]
      .find(event => event.type === 'supervised_merge_decision').mergeRecord.prNumber, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('merge result requires a matching eligible decision and structured merged GitHub response', async () => {
  const state = orchestrator.createInitialState()
  orchestrator.addTask(state, { id: 'task-ui-polish', domain: 'frontend', title: 'Polish a small UI detail',
    impact: 2, effort: 1, risk: 1, dependencies: [], evidenceRefs: ['docs/autonomy/supervised-merge.md'],
    testRefs: ['scripts/autonomy/test/supervised-merge-policy.test.cjs'], benchmarkRefs: [], benchmarkDirection: 'higher_is_better' })
  orchestrator.preparePilot(state, { pilotId: runId })
  const scopedAuthorization = authorization({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
  orchestrator.startPreparedPilot(state, { pilotId: runId, maxCycles: 10,
    approverIdentity: 'coordinator@example.test', approvalEvidenceRef: 'docs/autonomy/supervised-merge.md',
    mergeMode: 'supervised_autonomous', mergeAuthorization: scopedAuthorization })
  const task = orchestrator.selectTask(state)
  orchestrator.recordBaseline(state, task.id, { baselineMetric: 1, artifactRef: 'docs/autonomy/supervised-merge.md' })
  orchestrator.recordImplementation(state, task.id, { branch: 'codex/supervised-task', commitSha: head })
  orchestrator.recordTests(state, task.id, { passed: true, artifactRef: 'scripts/autonomy/test/supervised-merge-policy.test.cjs' })
  for (const role of ['reviewer', 'qa', 'quality', 'security']) {
    orchestrator.recordAssessment(state, task.id, {
      role,
      passed: true,
      artifactRef: 'docs/autonomy/supervised-merge.md',
      invocationRef: `${role}.unit-test-session-001`,
      targetCommitSha: head,
    })
  }
  const validatedTask = orchestrator.recordBenchmark(state, task.id, { resultMetric: 2, artifactRef: 'docs/autonomy/supervised-merge.md' })
  assert.equal(validatedTask.status, 'validated')
  const approvedEvidence = evidence({ taskId: task.id })
  const decision = orchestrator.recordSupervisedMergeDecision(state, approvedEvidence)
  assert.equal(decision.eligible, true, JSON.stringify(decision))
  assert.throws(() => orchestrator.recordSupervisedMergeDecision(state, approvedEvidence), /Exact duplicate/)
  const refreshed = evidence({ taskId: task.id, resourceUsage: { ...approvedEvidence.resourceUsage, ciRunsUsed: 2 },
    requiredCheck: { ...approvedEvidence.requiredCheck, runUrl: `https://github.com/${repository}/actions/runs/987655` } })
  const refreshedDecision = orchestrator.recordSupervisedMergeDecision(state, refreshed)
  assert.equal(refreshedDecision.eligible, true)
  assert.notEqual(refreshedDecision.decisionDigest, decision.decisionDigest)
  const decreasedUsage = evidence({ taskId: task.id,
    resourceUsage: { ...approvedEvidence.resourceUsage, ciRunsUsed: 1 },
    requiredCheck: { ...approvedEvidence.requiredCheck, runUrl: `https://github.com/${repository}/actions/runs/987656` } })
  assert.equal(orchestrator.recordSupervisedMergeDecision(state, decreasedUsage).reason, 'budget_exhausted')
  const rejectedRevision = evidence({ taskId: task.id, riskFindings: ['authentication'],
    resourceUsage: { ...approvedEvidence.resourceUsage, ciRunsUsed: 2 },
    requiredCheck: { ...approvedEvidence.requiredCheck, runUrl: `https://github.com/${repository}/actions/runs/987657` } })
  assert.equal(orchestrator.recordSupervisedMergeDecision(state, rejectedRevision).eligible, false)
  assert.throws(() => orchestrator.recordSupervisedMergeResult(state, {
    taskId: task.id, prNumber: pr, headSha: head, baseSha: base,
    decisionDigest: refreshedDecision.decisionDigest,
    githubResponse: { merged: true, number: pr, headSha: head, baseSha: base,
      mergeCommitSha: 'd'.repeat(40), mergedAt: new Date().toISOString(), message: 'merged' },
  }), /latest decision/)
  const finalDecision = orchestrator.recordSupervisedMergeDecision(state, evidence({ taskId: task.id,
    resourceUsage: { ...approvedEvidence.resourceUsage, ciRunsUsed: 2 },
    requiredCheck: { ...approvedEvidence.requiredCheck, runUrl: `https://github.com/${repository}/actions/runs/987658` } }))
  assert.equal(finalDecision.eligible, true)
  for (const candidate of [
    { taskId: 'another-task', prNumber: pr, headSha: head, baseSha: base },
    { taskId: 'task-ui-polish', prNumber: pr + 1, headSha: head, baseSha: base },
    { taskId: 'task-ui-polish', prNumber: pr, headSha: 'e'.repeat(40), baseSha: base },
    { taskId: 'task-ui-polish', prNumber: pr, headSha: head, baseSha: 'e'.repeat(40) },
  ]) {
    assert.throws(() => orchestrator.recordSupervisedMergeResult(state, { ...candidate,
      decisionDigest: finalDecision.decisionDigest,
      githubResponse: { merged: true, number: pr, headSha: head, baseSha: base,
        mergeCommitSha: 'd'.repeat(40), mergedAt: new Date().toISOString(), message: 'merged' },
    }), /latest decision/)
  }
  assert.throws(() => orchestrator.recordSupervisedMergeResult(state, {
    taskId: 'task-ui-polish', prNumber: pr, headSha: head, baseSha: base,
    decisionDigest: finalDecision.decisionDigest,
    githubResponse: { merged: false, number: pr, headSha: head, baseSha: base,
      mergeCommitSha: 'd'.repeat(40), mergedAt: new Date().toISOString(), message: 'not merged' },
  }), /merged=true/)
  const latestEligibleEvent = state.checkpoint.events.findLast(event => event.type === 'supervised_merge_decision' && event.mergeRecord.outcome === 'eligible')
  const mergeAt = new Date(Date.parse(latestEligibleEvent.at) + 1000).toISOString()
  const revokeAt = new Date(Date.parse(latestEligibleEvent.at) + 5000).toISOString()
  assert.throws(() => orchestrator.recordSupervisedMergeResult(state, {
    taskId: 'task-ui-polish', prNumber: pr, headSha: head, baseSha: base,
    decisionDigest: finalDecision.decisionDigest,
    githubResponse: { merged: true, number: pr, headSha: head, baseSha: base,
      mergeCommitSha: 'd'.repeat(40), mergedAt: new Date(Date.parse(scopedAuthorization.expiresAt) + 1000).toISOString(), message: 'merged' },
  }, { currentTime: new Date(Date.parse(scopedAuthorization.expiresAt) + 2000).toISOString() }), /before expiry/)
  orchestrator.revokeSupervisedMerges(state, prRef, { currentTime: revokeAt })
  assert.throws(() => orchestrator.recordSupervisedMergeResult(state, {
    taskId: 'task-ui-polish', prNumber: pr, headSha: head, baseSha: base,
    decisionDigest: finalDecision.decisionDigest,
    githubResponse: { merged: true, number: pr, headSha: head, baseSha: base,
      mergeCommitSha: 'd'.repeat(40), mergedAt: new Date(Date.parse(revokeAt) + 1000).toISOString(), message: 'merged' },
  }, { currentTime: new Date(Date.parse(scopedAuthorization.expiresAt) + 1000).toISOString() }), /before expiry\/revocation/)
  const result = orchestrator.recordSupervisedMergeResult(state, {
    taskId: 'task-ui-polish', prNumber: pr, headSha: head, baseSha: base,
    decisionDigest: finalDecision.decisionDigest,
    githubResponse: { merged: true, number: pr, headSha: head, baseSha: base,
      mergeCommitSha: 'd'.repeat(40), mergedAt: mergeAt, message: 'merged' },
  }, { currentTime: new Date(Date.parse(scopedAuthorization.expiresAt) + 1000).toISOString() })
  assert.equal(result.recorded, true)
  assert.equal(state.checkpoint.events.filter(event => event.type === 'supervised_merge_completed').length, 1)
  assert.equal(orchestrator.validateState(state), state)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quizforge-merge-result-'))
  try {
    const checkpoint = path.join(dir, 'checkpoint.json')
    await orchestrator.saveState(checkpoint, state, dir)
    const reloaded = await orchestrator.loadState(checkpoint, dir)
    assert.equal(reloaded.checkpoint.events.filter(event => event.type === 'supervised_merge_completed').length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('CLI persists supervised start, decision, status, and revocation on a disposable checkpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quizforge-supervised-cli-'))
  const stateFile = path.join(dir, 'checkpoint.json')
  const script = path.resolve(__dirname, '../optimization-orchestrator.cjs')
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args, '--state', stateFile], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() ? JSON.parse(result.stdout) : null
  }
  try {
    run('init')
    run('add-task', JSON.stringify({ id: 'task-ui-polish', domain: 'frontend', title: 'Polish a small UI detail',
      impact: 2, effort: 1, risk: 1, dependencies: [], evidenceRefs: ['docs/autonomy/supervised-merge.md'],
      testRefs: ['scripts/autonomy/test/supervised-merge-policy.test.cjs'], benchmarkRefs: [] }))
    run('prepare-pilot', runId)
    run('start-pilot', JSON.stringify({ pilotId: runId, maxCycles: 10,
      approverIdentity: 'coordinator@example.test', approvalEvidenceRef: 'docs/autonomy/supervised-merge.md',
      mergeMode: 'supervised_autonomous', mergeAuthorization: authorization() }))
    const rejected = run('record-supervised-merge', JSON.stringify({ taskId: 'task-ui-polish' }))
    assert.equal(rejected.decisionRecorded, true)
    run('revoke-supervised-merges', prRef)
    const status = run('status')
    assert.equal(status.checkpoint.mergeAuthorization.status, 'revoked')
    assert.ok(status.checkpoint.events.some(event => event.type === 'supervised_merge_revoked'))
    const denied = spawnSync(process.execPath, [script, 'record-supervised-merge-result', '{}', '--state', stateFile], { encoding: 'utf8' })
    assert.notEqual(denied.status, 0)
    assert.match(denied.stderr, /latest decision|eligible decision/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('agent instructions keep Manual default and preserve all gates within supervised scope', async () => {
  const root = path.resolve(__dirname, '../../..')
  const [agents, manager, operator] = await Promise.all([
    fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/merge-manager.toml'), 'utf8'),
    fs.readFile(path.join(root, 'docs/autonomy/supervised-merge.md'), 'utf8'),
  ])
  assert.match(operator, /Manual.*default/i)
  assert.match(operator, /fully_autonomous.*rejected|rejected.*fully_autonomous/i)
  assert.match(manager, /supervised/i)
  assert.match(manager, /only the repeated per-PR approval prompt/i)
  assert.match(manager, /never waives normal PR checks/i)
  assert.match(manager, /Required PR gate/i)
  assert.match(manager, /branch.protection|ruleset/i)
  assert.match(agents, /three.concurrent|three or fewer/i)
})
