'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  begin, blockTask, completeTask, createWorkflow, DEFAULT_CHECKPOINT, loadCheckpoint, recordApproval,
  refreshMergeScope, rejectTask, retryTask, saveCheckpoint, transitionAndSave, validateWorkflow,
} = require('../integration-coordinator.cjs')

const sha = 'a'.repeat(40)
const mergedSha = 'b'.repeat(40)
const pr = {
  repository: 'HamedGithubforwork/QuizForge-AI', number: 678,
  baseRef: 'main', baseSha: 'd'.repeat(40), headSha: sha,
  url: 'https://github.com/HamedGithubforwork/QuizForge-AI/pull/678',
}
const work = (id, priority = 1, dependencies = []) => ({ id, title: id, priority, dependencies })
const merge = (id, dependencies = []) => ({ id, title: id, kind: 'merge', priority: 10, dependencies, pr })

test('completing one task automatically selects the next eligible task in one bounded continuation', () => {
  const state = createWorkflow({ objectiveId: 'continue-integration', maxSelections: 4, tasks: [work('first', 10), work('second', 9)] })
  assert.equal(begin(state).task.id, 'first')

  const outcome = completeTask(state, 'first', { evidenceRef: 'docs/autonomy/integration-workflow.md' })

  assert.equal(outcome.completed.id, 'first')
  assert.equal(outcome.task.id, 'second')
  assert.equal(state.selectedTaskId, 'second')
  assert.equal(state.selections, 2)
})

test('completion transition persists the next task before returning it', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-transition-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'durable-auto-next', maxSelections: 3, tasks: [work('first', 2), work('second', 1)] })
    await saveCheckpoint(file, state)
    await transitionAndSave(file, state, { type: 'begin' })
    const outcome = await transitionAndSave(file, state, {
      type: 'complete', taskId: 'first', payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    })
    assert.equal(outcome.task.id, 'second')
    const reloaded = await loadCheckpoint(file)
    assert.equal(reloaded.tasks.find(task => task.id === 'first').status, 'completed')
    assert.equal(reloaded.selectedTaskId, 'second')
    assert.equal(reloaded.tasks.find(task => task.id === 'second').status, 'running')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('blocked work and an unapproved merge do not prevent independent safe work', () => {
  const state = createWorkflow({ objectiveId: 'blocker-fallback', tasks: [work('blocked-candidate', 10), merge('needs-approval'), work('independent', 4)] })
  assert.equal(begin(state).task.id, 'blocked-candidate')

  const outcome = blockTask(state, 'blocked-candidate', {
    blockerCode: 'existing_pr', evidenceRef: 'docs/autonomy/integration-workflow.md#existing-pr',
  })

  assert.equal(outcome.task.id, 'independent')
  assert.equal(state.tasks.find(task => task.id === 'needs-approval').status, 'awaiting_approval')
  assert.equal(state.selectedTaskId, 'independent')
})

test('merge approval is exact-scope and cannot be inferred from task readiness', () => {
  const state = createWorkflow({ objectiveId: 'approval-scope', tasks: [merge('merge-678')] })
  assert.equal(begin(state).task, null)
  assert.equal(state.status, 'blocked')
  assert.throws(() => recordApproval(state, 'merge-678', {
    action: 'merge', repository: pr.repository, prNumber: pr.number,
    headSha: 'c'.repeat(40), targetBranch: pr.baseRef, baseSha: pr.baseSha,
    approver: 'owner', evidenceRef: 'docs/autonomy/integration-workflow.md#approval',
  }), /exact repository, PR, head SHA, and target branch/)
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(state.tasks[0].approval, null)
})

test('a malformed ready merge task without approval cannot be selected', () => {
  const state = createWorkflow({ objectiveId: 'reject-unauthorized-merge', tasks: [merge('merge-678')] })
  state.tasks[0].status = 'ready'
  assert.throws(() => validateWorkflow(state), /Unauthorized merge task .* cannot be ready/)
  assert.throws(() => begin(state), /Unauthorized merge task .* cannot be ready/)
})

test('a changed PR head invalidates prior approval and returns the task to approval wait', () => {
  const state = createWorkflow({ objectiveId: 'changed-pr-head', tasks: [merge('merge-678'), work('independent')] })
  recordApproval(state, 'merge-678', {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#approval-old-head',
  })
  const updatedPr = { ...pr, headSha: 'c'.repeat(40) }
  const result = refreshMergeScope(state, 'merge-678', updatedPr)
  assert.equal(result.task.id, 'independent')
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(state.tasks[0].approval, null)
  assert.equal(state.events.at(-2).type, 'merge_scope_changed')
  assert.equal(state.events.at(-2).previous.headSha, sha)
  assert.equal(state.events.at(-2).current.headSha, updatedPr.headSha)
})

test('a changed target base SHA invalidates prior approval and remains approval-gated', () => {
  const state = createWorkflow({ objectiveId: 'changed-pr-base-sha', tasks: [merge('merge-678')] })
  recordApproval(state, 'merge-678', {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#approval-old-base',
  })
  const updatedPr = { ...pr, baseSha: 'e'.repeat(40) }
  const result = refreshMergeScope(state, 'merge-678', updatedPr)
  assert.equal(result.reason, 'blocked')
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(state.tasks[0].approval, null)
  assert.equal(state.tasks[0].pr.baseSha, updatedPr.baseSha)
})

test('a changed target branch invalidates prior approval', () => {
  const state = createWorkflow({ objectiveId: 'changed-target-ref', tasks: [merge('merge-678')] })
  recordApproval(state, 'merge-678', {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#approval-old-target',
  })
  refreshMergeScope(state, 'merge-678', { ...pr, baseRef: 'release' })
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(state.tasks[0].approval, null)
  assert.equal(state.tasks[0].pr.baseRef, 'release')
})

test('approved dependency merge causes downstream work to be reconsidered automatically', () => {
  const state = createWorkflow({ objectiveId: 'dependency-resume', tasks: [merge('merge-base'), work('dependent', 8, ['merge-base'])] })
  const approval = {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#user-approval',
  }
  assert.equal(recordApproval(state, 'merge-base', approval).task.id, 'merge-base')
  const result = completeTask(state, 'merge-base', {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
    commitSha: mergedSha,
  })
  assert.equal(result.task.id, 'dependent')
  assert.deepEqual(state.tasks.find(task => task.id === 'dependent').dependencies, ['merge-base'])
})

test('review completion alone cannot unlock the next stack level', () => {
  const state = createWorkflow({ objectiveId: 'review-is-not-merge', tasks: [
    work('review-parent', 10), merge('merge-parent', ['review-parent']), work('review-child', 5, ['merge-parent']),
  ] })
  assert.equal(begin(state).task.id, 'review-parent')
  const reviewed = completeTask(state, 'review-parent', { evidenceRef: 'docs/autonomy/integration-workflow.md#review' })
  assert.equal(reviewed.task, null)
  assert.equal(state.status, 'blocked')
  assert.equal(state.tasks.find(task => task.id === 'review-child').status, 'ready')
  assert.equal(state.tasks.find(task => task.id === 'merge-parent').status, 'awaiting_approval')

  const authorized = recordApproval(state, 'merge-parent', {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#merge-approval',
  })
  assert.equal(authorized.task.id, 'merge-parent')
  const merged = completeTask(state, 'merge-parent', {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
    commitSha: mergedSha,
  })
  assert.equal(merged.task.id, 'review-child')
})

test('checkpoint reload resumes selected work and preserves exact approval scope', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-checkpoint-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'checkpoint-resume', tasks: [merge('merge-678'), work('dependent', 5, ['merge-678'])] })
    recordApproval(state, 'merge-678', {
      action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
      targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
      evidenceRef: 'docs/autonomy/integration-workflow.md#approval-678',
    })
    await saveCheckpoint(file, state)
    const reopened = await loadCheckpoint(file)
    assert.equal(reopened.revision, 1)
    assert.equal(reopened.selectedTaskId, 'merge-678')
    assert.equal(begin(reopened).task.id, 'merge-678')
    assert.equal(reopened.tasks[0].approval.headSha, sha)
    assert.equal(reopened.tasks[0].pr.baseSha, pr.baseSha)

    completeTask(reopened, 'merge-678', {
      evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
      commitSha: mergedSha,
    })
    await saveCheckpoint(file, reopened)
    const nextSession = await loadCheckpoint(file)
    assert.equal(begin(nextSession).task.id, 'dependent')
    assert.equal(nextSession.tasks[0].approval.targetBranch, 'main')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('schema-v1 nonempty checkpoint migrates through save/reload without losing tasks, events, approval, or gate state', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-v1-migration-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'schema-v1-migration', tasks: [
      merge('legacy-merge'), work('legacy-dependent', 3, ['legacy-merge']),
    ] })
    recordApproval(state, 'legacy-merge', {
      action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
      targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
      evidenceRef: 'docs/autonomy/integration-workflow.md#schema-v1-approval',
    })
    await saveCheckpoint(file, state)

    const legacy = JSON.parse(await fs.readFile(file, 'utf8'))
    for (const task of legacy.tasks) delete task.rejection
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`)
    const oldEventCount = legacy.events.length
    const migrated = await loadCheckpoint(file)
    assert.equal(migrated.tasks.length, 2)
    assert.equal(migrated.events.length, oldEventCount)
    assert.equal(migrated.tasks[0].rejection, null)
    assert.equal(migrated.tasks[0].approval.headSha, pr.headSha)
    assert.equal(migrated.tasks[0].approval.baseSha, pr.baseSha)
    assert.equal(migrated.status, 'active')
    assert.equal(migrated.stopReason, null)
    assert.equal(migrated.selectedTaskId, 'legacy-merge')

    const next = await transitionAndSave(file, migrated, {
      type: 'complete', taskId: 'legacy-merge',
      payload: {
        evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
        commitSha: mergedSha,
      },
    })
    assert.equal(next.task.id, 'legacy-dependent')
    const reopened = await loadCheckpoint(file)
    assert.equal(reopened.tasks.length, 2)
    assert.equal(reopened.tasks[0].status, 'completed')
    assert.equal(reopened.tasks[0].approval.headSha, pr.headSha)
    assert.equal(reopened.tasks[0].result.mergeCommitSha, mergedSha)
    assert.equal(reopened.tasks[1].status, 'running')
    assert.equal(reopened.selectedTaskId, 'legacy-dependent')
    assert.equal(reopened.status, 'active')
    assert.equal(reopened.stopReason, null)
    assert.ok(reopened.events.length > oldEventCount)
    assert.ok(reopened.events.some(event => event.type === 'merge_authorized'))
    assert.ok(reopened.events.some(event => event.type === 'task_completed'))
    assert.ok(reopened.tasks.every(task => task.rejection === null))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('version-controlled integration checkpoint loads verified PR states and dependency graph', async () => {
  const checkpoint = await loadCheckpoint(DEFAULT_CHECKPOINT)
  assert.equal(checkpoint.objectiveId, 'autonomous-integration')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-678-complete').status, 'completed')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-678-complete').pr.mergeCommitSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').status, 'completed')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').candidateHeadSha, 'b5b09c2c23dc99add09ef10804fc18bd73c94525')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.headSha, '2e58e03cdf8e48a2025b307f696c359e3dad2d3d')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.baseSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.reportedBaseSha, 'aad0afeda769a6715f2ba8351294b61839ff5fe6')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.liveTargetSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.baseShaNote, 'api_base_differs_from_live_target_requires_refresh')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.mergeable, false)
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').pr.checkedOn, '2026-11-09')
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-695-reconcile').result, {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42561665578',
    commitSha: '176fc7961781d622519597a4c8268b33d40d4514',
  })
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-merge').status, 'awaiting_approval')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-merge').approval, null)
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-merge').pr.headSha, '176fc7961781d622519597a4c8268b33d40d4514')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-695-merge').pr.baseSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-review').status, 'completed')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-review').pr.headSha, 'e36eed8e453fd724557224353e2e7470184efbb0')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-review').pr.mergeable, true)
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-698-review').result, {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42561714261',
    commitSha: '6add3dac88d211f5bdc127bd8c1a1ea7c4a3d845',
  })
  assert.equal(checkpoint.maxSelections, 50)
  assert.ok(checkpoint.maxSelections >= 6 * 2 * 3) // six open PRs; review and merge steps; initial plus two retries
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-merge').status, 'awaiting_approval')
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-merge').approval, null)
  assert.equal(checkpoint.tasks.find(task => task.id === 'pr-698-merge').pr.headSha, '6add3dac88d211f5bdc127bd8c1a1ea7c4a3d845')
  assert.equal(checkpoint.status, 'blocked')
  assert.equal(checkpoint.stopReason, 'no_actionable_task')
  assert.equal(checkpoint.selectedTaskId, null)
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-690-reconcile').dependencies, ['pr-695-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-690-merge').dependencies, ['pr-690-reconcile'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-691-reconcile').dependencies, ['pr-690-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-691-merge').dependencies, ['pr-691-reconcile'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-692-reconcile').dependencies, ['pr-691-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-694-reconcile').dependencies, ['pr-691-merge'])
  for (const number of [695, 698, 690, 691, 692, 694]) {
    const mergeTask = checkpoint.tasks.find(task => task.id === `pr-${number}-merge`)
    assert.equal(mergeTask.status, 'awaiting_approval')
    assert.equal(mergeTask.approval, null)
    assert.match(mergeTask.pr.baseSha, /^[a-f0-9]{40}$/)
  }
  assert.equal(checkpoint.tasks.filter(task => task.kind === 'merge').length, 6)
  assert.ok(checkpoint.tasks.filter(task => task.kind === 'merge').every(task => task.status === 'awaiting_approval' && task.approval === null))
  for (const number of [690, 691, 692, 694]) {
    assert.equal(checkpoint.tasks.find(task => task.pr?.number === number).pr.checkedOn, '2026-11-09')
    assert.equal(checkpoint.tasks.find(task => task.pr?.number === number).pr.mergeable, true)
  }
})

test('workflow terminates when every task is complete', () => {
  const state = createWorkflow({ objectiveId: 'finished-objective', tasks: [work('one')] })
  begin(state)
  const result = completeTask(state, 'one', { evidenceRef: 'docs/autonomy/integration-workflow.md#one' })
  assert.equal(result.task, null)
  assert.equal(result.reason, 'completed')
  assert.equal(state.status, 'completed')
  assert.equal(begin(state).reason, 'completed')
})

test('evidence-backed rejection preserves history, continues to another task, and can terminate', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-reject-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'reject-and-continue', maxSelections: 3, tasks: [work('reject-one', 2), work('continue-two', 1)] })
    await saveCheckpoint(file, state)
    await transitionAndSave(file, state, { type: 'begin' })
    const result = await transitionAndSave(file, state, {
      type: 'reject', taskId: 'reject-one',
      payload: { reasonCode: 'duplicate_work', evidenceRef: 'docs/autonomy/integration-workflow.md#duplicate' },
    })
    assert.equal(result.rejected.status, 'rejected')
    assert.equal(result.task.id, 'continue-two')
    const reopened = await loadCheckpoint(file)
    assert.equal(reopened.selectedTaskId, 'continue-two')
    assert.deepEqual(reopened.tasks.find(task => task.id === 'reject-one').rejection, {
      reasonCode: 'duplicate_work', evidenceRef: 'docs/autonomy/integration-workflow.md#duplicate',
    })
    const nullRejectionRef = structuredClone(reopened)
    nullRejectionRef.tasks.find(task => task.id === 'reject-one').rejection.evidenceRef = null
    assert.throws(() => validateWorkflow(nullRejectionRef), /allowlisted/)
    const droppedRejectionRef = structuredClone(reopened)
    droppedRejectionRef.tasks.find(task => task.id === 'reject-one').evidenceRefs = []
    assert.throws(() => validateWorkflow(droppedRejectionRef), /does not preserve its rejection evidence/)

    const terminal = createWorkflow({ objectiveId: 'reject-final-task', tasks: [work('only-rejected')] })
    begin(terminal)
    rejectTask(terminal, 'only-rejected', {
      reasonCode: 'scope_invalid', evidenceRef: 'docs/autonomy/integration-workflow.md#invalid-scope',
    })
    assert.equal(terminal.status, 'completed')
    assert.equal(validateWorkflow(terminal).tasks[0].status, 'rejected')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('objective completion takes precedence when the final task uses the last selection', () => {
  const state = createWorkflow({ objectiveId: 'finish-at-budget', maxSelections: 1, tasks: [work('only-task')] })
  begin(state)
  const result = completeTask(state, 'only-task', { evidenceRef: 'docs/autonomy/integration-workflow.md#finish' })
  assert.equal(result.reason, 'completed')
  assert.equal(state.selections, state.maxSelections)
  assert.equal(state.status, 'completed')
  assert.equal(validateWorkflow(state).stopReason, 'objective_complete')
})

test('strict checkpoint validation rejects malformed task states and inconsistent counters', () => {
  const unknownKind = createWorkflow({ objectiveId: 'unknown-task-kind', tasks: [work('one')] })
  unknownKind.tasks[0].kind = 'shell'
  assert.throws(() => validateWorkflow(unknownKind), /Malformed integration task record/)

  const unfinished = createWorkflow({ objectiveId: 'unfinished-completed', tasks: [work('one'), work('two')] })
  unfinished.status = 'completed'; unfinished.stopReason = 'objective_complete'
  assert.throws(() => validateWorkflow(unfinished), /Completed workflow contains unfinished tasks/)

  const earlyBudget = createWorkflow({ objectiveId: 'early-budget', maxSelections: 3, tasks: [work('one')] })
  earlyBudget.status = 'budget_reached'; earlyBudget.stopReason = 'selection_budget'
  assert.throws(() => validateWorkflow(earlyBudget), /Budget stop must be at the selection limit/)

  const wrongCount = createWorkflow({ objectiveId: 'wrong-count', tasks: [work('one')] })
  wrongCount.selections = 1
  assert.throws(() => validateWorkflow(wrongCount), /Selection count does not match/)
})

test('evidence references remain intact and reject prose, absolute paths, traversal, queries, and credentials', () => {
  const refs = ['docs/autonomy/integration-workflow.md', 'https://github.com/example/repo/commit/' + sha]
  const state = createWorkflow({ objectiveId: 'evidence-refs', tasks: [{ ...work('one'), evidenceRefs: refs }] })
  assert.deepEqual(state.tasks[0].evidenceRefs, refs)
  assert.equal(validateWorkflow(state).tasks[0].evidenceRefs.length, 2)
  for (const evidenceRef of [
    'the test passed', 'C:/private/secret.txt', '../secret.txt', 'docs/../secret.md',
    'https://github.com/example/repo/pull/1?token=secret',
    'https://user:pass@github.com/example/repo/pull/1',
  ]) {
    assert.throws(() => createWorkflow({ objectiveId: 'invalid-evidence', tasks: [{ ...work('one'), evidenceRefs: [evidenceRef] }] }), /allowlisted|path traversal/)
  }
  const badEvent = createWorkflow({ objectiveId: 'tampered-event-evidence', tasks: [work('one')] })
  badEvent.events.push({ sequence: 1, type: 'task_completed', taskId: 'one', evidenceRef: 'credential=secret' })
  assert.throws(() => validateWorkflow(badEvent), /allowlisted/)
  const persisted = createWorkflow({ objectiveId: 'tampered-evidence', tasks: [work('one')] })
  persisted.tasks[0].evidenceRefs.push('leaked password')
  assert.throws(() => validateWorkflow(persisted), /allowlisted|path traversal/)
})

test('event schema validates every typed field and nested PR scope against tampering', async () => {
  const checkpoint = await loadCheckpoint(DEFAULT_CHECKPOINT)
  const tamper = change => {
    const copy = structuredClone(checkpoint)
    change(copy)
    assert.throws(() => validateWorkflow(copy))
  }
  tamper(copy => { copy.events[0].headSha = 'not-a-sha' })
  tamper(copy => { copy.events[0].targetBranch = '../main' })
  tamper(copy => { copy.events[0].evidenceRef = null })
  tamper(copy => { copy.events[1].attempt = 'one' })
  tamper(copy => { copy.events[1].candidateHeadSha = 'short' })
  tamper(copy => { copy.events[1].unexpected = 'ignored text' })

  const add = (copy, event) => {
    event.sequence = copy.events.length + 1
    copy.events.push(event)
  }
  tamper(copy => add(copy, {
    type: 'task_blocked', taskId: 'pr-695-reconcile', blockerCode: 'invented',
    evidenceRef: 'docs/autonomy/integration-workflow.md#block', retryExhausted: false,
  }))
  tamper(copy => add(copy, {
    type: 'task_completed', taskId: 'pr-695-reconcile', evidenceRef: 'docs/autonomy/integration-workflow.md#complete', commitSha: 'bad',
  }))
  tamper(copy => add(copy, {
    type: 'merge_authorized', taskId: 'pr-695-merge', evidenceRef: 'docs/autonomy/integration-workflow.md#approve',
    headSha: 'a'.repeat(40), baseSha: 'bad',
  }))
  tamper(copy => add(copy, {
    type: 'task_retry_authorized', taskId: 'pr-695-reconcile', evidenceRef: null,
  }))
  tamper(copy => add(copy, {
    type: 'task_rejected', taskId: 'pr-695-reconcile', reasonCode: 'other', evidenceRef: null,
  }))
  tamper(copy => add(copy, {
    type: 'merge_scope_changed', taskId: 'pr-695-merge',
    previous: { ...copy.tasks.find(task => task.id === 'pr-695-merge').pr, approvalEvidenceRef: null },
    current: { ...copy.tasks.find(task => task.id === 'pr-695-merge').pr, baseRef: '../main' },
  }))
})

test('merge tasks require exact canonical base SHA', () => {
  assert.throws(() => createWorkflow({
    objectiveId: 'missing-merge-base', tasks: [{ ...merge('merge-678'), pr: { ...pr, baseSha: undefined } }],
  }), /canonical baseSha/)
})

test('selection budget and two-retry limit stop repeated work without losing blocker evidence', () => {
  const budget = createWorkflow({ objectiveId: 'selection-budget', maxSelections: 2, tasks: [work('one', 10), work('two', 9), work('three', 8)] })
  begin(budget)
  const second = blockTask(budget, 'one', { blockerCode: 'tooling_unavailable', evidenceRef: 'docs/autonomy/integration-workflow.md#failure-one' })
  assert.equal(second.task.id, 'two')
  const stopped = completeTask(budget, 'two', { evidenceRef: 'docs/autonomy/integration-workflow.md#two' })
  assert.equal(stopped.reason, 'budget_reached')
  assert.equal(budget.status, 'budget_reached')
  assert.equal(begin(budget).reason, 'budget_reached')

  const retries = createWorkflow({ objectiveId: 'retry-budget', maxSelections: 10, tasks: [work('retry-me')] })
  begin(retries)
  blockTask(retries, 'retry-me', { blockerCode: 'environment_failure', evidenceRef: 'docs/autonomy/integration-workflow.md#attempt-1' })
  assert.equal(retryTask(retries, 'retry-me', { evidenceRef: 'docs/autonomy/integration-workflow.md#retry-evidence-2' }).task.attempts, 2)
  blockTask(retries, 'retry-me', { blockerCode: 'environment_failure', evidenceRef: 'docs/autonomy/integration-workflow.md#attempt-2' })
  assert.equal(retryTask(retries, 'retry-me', { evidenceRef: 'docs/autonomy/integration-workflow.md#retry-evidence-3' }).task.attempts, 3)
  const exhausted = blockTask(retries, 'retry-me', { blockerCode: 'environment_failure', evidenceRef: 'docs/autonomy/integration-workflow.md#attempt-3' })
  assert.equal(exhausted.blocked.retryExhausted, true)
  assert.throws(() => retryTask(retries, 'retry-me', { evidenceRef: 'docs/autonomy/integration-workflow.md#retry-evidence-4' }), /not safely retryable/)
  assert.equal(retries.tasks[0].evidenceRefs.length, 5)
})

test('stale checkpoint writer cannot overwrite a newer session', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-stale-'))
  const file = path.join(temp, 'integration.json')
  try {
    const first = createWorkflow({ objectiveId: 'stale-writer', tasks: [work('one')] })
    await saveCheckpoint(file, first)
    const stale = await loadCheckpoint(file)
    const current = await loadCheckpoint(file)
    begin(current)
    await saveCheckpoint(file, current)
    validateWorkflow(stale)
    await assert.rejects(saveCheckpoint(file, stale), /Stale integration checkpoint revision/)
    assert.equal((await loadCheckpoint(file)).selectedTaskId, 'one')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('active checkpoint lock is preserved and fails closed', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-active-lock-'))
  const file = path.join(temp, 'integration.json')
  const lock = `${file}.lock`
  try {
    const state = createWorkflow({ objectiveId: 'active-lock', tasks: [work('one')] })
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: 'live-test-lock' })
    await fs.writeFile(lock, owner, { flag: 'wx' })
    await assert.rejects(saveCheckpoint(file, state), /locked by a live Coordinator process/)
    assert.equal(await fs.readFile(lock, 'utf8'), owner)
    await assert.rejects(fs.access(`${lock}.recovery`), { code: 'ENOENT' })
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('same-host dead-owner checkpoint lock is recovered after PID proof', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-stale-lock-'))
  const file = path.join(temp, 'integration.json')
  const lock = `${file}.lock`
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(exited.status, 0)
    assert.ok(exited.pid)
    await fs.writeFile(lock, JSON.stringify({ pid: exited.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: 'dead-test-lock' }))
    const state = createWorkflow({ objectiveId: 'dead-lock-recovery', tasks: [work('one')] })
    await saveCheckpoint(file, state)
    assert.equal((await loadCheckpoint(file)).revision, 1)
    await assert.rejects(fs.access(lock), { code: 'ENOENT' })
    await assert.rejects(fs.access(`${lock}.recovery`), { code: 'ENOENT' })
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('old malformed checkpoint lock can be recovered but recent malformed lock cannot', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-integration-malformed-lock-'))
  const file = path.join(temp, 'integration.json')
  const lock = `${file}.lock`
  try {
    await fs.writeFile(lock, '{partial')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(lock, old, old)
    await saveCheckpoint(file, createWorkflow({ objectiveId: 'old-malformed-lock', tasks: [work('one')] }))
    assert.equal((await loadCheckpoint(file)).revision, 1)

    await fs.writeFile(lock, '{partial')
    await assert.rejects(saveCheckpoint(file, createWorkflow({ objectiveId: 'recent-malformed-lock', tasks: [work('one')] })), /too recent for safe recovery/)
    assert.equal(await fs.readFile(lock, 'utf8'), '{partial')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
