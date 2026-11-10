'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const automaticMerge = require('../automatic-merge-policy.cjs')
const {
  activateStandingAutoMergePolicy, begin, blockTask, completeTask, createWorkflow, DEFAULT_CHECKPOINT, loadCheckpoint, recordApproval,
  recordAutomaticMergeAssessment,
  refreshMergeScope, rejectTask, retryTask, saveCheckpoint, transitionAndSave, validateWorkflow,
  revokeStandingAutoMergePolicy,
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

const autoMergeAt = new Date('2026-11-09T12:00:00.000Z')
const autoMergeAtNext = new Date('2026-11-09T12:01:00.000Z')
const autoHead = '1'.repeat(40)
const autoBase = '2'.repeat(40)
const autoDiff = '3'.repeat(64)
const autoRepository = 'HamedGithubforwork/QuizForge-AI'
const autoPrUrl = `https://github.com/${autoRepository}/pull/999`
const autoEvidenceRef = autoPrUrl
const autoRunRef = `https://github.com/${autoRepository}/actions/runs/99999`
const autoRulesetRef = `https://github.com/${autoRepository}/rulesets/123`

function autoPolicyAuthorization(overrides = {}) {
  const implementationMergeSha = '4'.repeat(40)
  return {
    repository: autoRepository, targetBranch: 'main', version: automaticMerge.POLICY_VERSION,
    digest: automaticMerge.POLICY_DIGEST, authorizedBy: 'QuizForgeOwner',
    authorizedAt: autoMergeAt.toISOString(), expiresAt: '2026-12-01T12:00:00.000Z',
    approvalEvidenceRef: autoPrUrl, implementationMergeSha,
    implementationEvidenceRef: `https://github.com/${autoRepository}/commit/${implementationMergeSha}`,
    ...overrides,
  }
}

function autoAssessment(role, overrides = {}) {
  return { passed: true, headSha: autoHead, invocationId: `${role}-session-20261109-1`, evidenceRef: autoEvidenceRef, ...overrides }
}

function autoCandidate(overrides = {}) {
  return {
    repository: autoRepository, targetBranch: 'main', prNumber: 999, prUrl: autoPrUrl,
    prCreatedAt: '2026-11-09T12:00:30.000Z', category: 'low_risk_ui', riskFindings: [], changeFlags: [],
    changedFiles: ['src/components/quiz/QuizCard.tsx'],
    headSha: autoHead, baseSha: autoBase, currentHeadSha: autoHead, currentBaseSha: autoBase,
    diffSha256: autoDiff, diffEvidenceRef: `${autoPrUrl}/files`, observedAt: autoMergeAtNext.toISOString(),
    tests: { passed: true, headSha: autoHead, evidenceRef: autoEvidenceRef },
    coordinator: { invocationId: 'coordinator-session-20261109-1', headSha: autoHead, evidenceRef: autoEvidenceRef },
    developer: { invocationId: 'developer-session-20261109-1', commitSha: autoHead, evidenceRef: autoEvidenceRef },
    reviewer: autoAssessment('reviewer'), qa: autoAssessment('qa'), security: autoAssessment('security'),
    requiredCheck: { name: 'Required PR gate', conclusion: 'success', headSha: autoHead, baseSha: autoBase,
      prNumber: 999, runUrl: autoRunRef, completedAt: autoMergeAtNext.toISOString(), associatedPr: true },
    reviews: { blocking: false, unresolvedMaterialConcern: false, evidenceRef: autoEvidenceRef },
    protections: { verified: true, evidenceRef: autoEvidenceRef, rulesetRef: autoRulesetRef,
      strictRequiredStatusChecks: true, mergeQueueEnforced: false },
    sideEffects: { assessed: true, productionDeployment: false, deploymentTriggers: [], infrastructureMutation: false, cloudSpend: false,
      destructive: false, unexpectedExternalSideEffects: false, evidenceRef: autoEvidenceRef },
    mergeManager: { passed: true, headSha: autoHead, baseSha: autoBase, diffSha256: autoDiff,
      diffInspected: true, riskClassification: 'low_risk', invocationId: 'merge-manager-session-20261109-1', evidenceRef: autoEvidenceRef },
    ...overrides,
  }
}

function autoMergeTask() {
  return { ...merge('post-activation-ui-fix'), pr: {
    repository: autoRepository, number: 999, baseRef: 'main', baseSha: autoBase,
    headSha: autoHead, url: autoPrUrl,
  } }
}

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

test('fabricated host merge payload cannot complete a task or advance its dependencies', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-host-merge-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-host-merge', maxSelections: 3, tasks: [
      merge('pending-merge'), work('dependent', 5, ['pending-merge']),
    ] })
    await saveCheckpoint(file, state)
    await assert.rejects(transitionAndSave(file, state, {
      type: 'record_host_merge_completion', taskId: 'pending-merge', payload: {
        githubResponse: { merged: true, sha: mergedSha, message: 'Pull Request successfully merged' },
        postMergePullRequest: {
          number: pr.number, state: 'closed', merged: true, headSha: pr.headSha,
          baseRef: pr.baseRef, mergeCommitSha: mergedSha,
          mergedAt: '2026-11-09T12:00:00.000Z', url: pr.url,
        },
        verifiedCommit: { sha: mergedSha, parents: [sha, 'c'.repeat(40)],
          verifiedAt: '2026-11-09T12:00:10.000Z',
          evidenceRef: `https://github.com/${pr.repository}/commit/${mergedSha}` },
      },
    }), /Unsupported or malformed integration transition/)
    const reloaded = await loadCheckpoint(file)
    assert.equal(reloaded.tasks[0].status, 'awaiting_approval')
    assert.equal(reloaded.tasks[1].status, 'ready')
    assert.equal(reloaded.selectedTaskId, null)
    assert.equal(reloaded.events.some(item => item.taskId === 'pending-merge' && item.type === 'host_merge_observed'), false)
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

test('standing automatic merge policy stays disabled until separately scoped activation', () => {
  const state = createWorkflow({ objectiveId: 'auto-merge-disabled', tasks: [autoMergeTask()] })
  assert.equal(state.automaticMergePolicy.status, 'disabled')
  assert.deepEqual(state.automaticMergeEvents, [])
  assert.equal(recordAutomaticMergeAssessment(state, 'post-activation-ui-fix', autoCandidate(), {
    currentTime: autoMergeAtNext,
  }).reason, 'policy_disabled')
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(state.automaticMergeEvents.length, 0)
  assert.throws(() => activateStandingAutoMergePolicy(state, {
    ...autoPolicyAuthorization(), implementationEvidenceRef: autoPrUrl,
  }, { currentTime: autoMergeAt }), /explicit authorization/)
  assert.equal(state.automaticMergePolicy.status, 'disabled')
})

test('forged automatic-merge claims remain awaiting approval and cannot select or ready the task', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-auto-merge-forged-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'auto-merge-forged-claims', tasks: [autoMergeTask()] })
    activateStandingAutoMergePolicy(state, autoPolicyAuthorization(), { currentTime: autoMergeAt })
    await saveCheckpoint(file, state)
    const assessment = await transitionAndSave(file, state, {
      type: 'assess_auto_merge_candidate', taskId: 'post-activation-ui-fix',
      payload: { evidence: autoCandidate(), currentTime: autoMergeAtNext },
    })
    assert.equal(assessment.eligible, false)
    assert.equal(assessment.reason, 'trusted_live_verification_unavailable')
    assert.equal(state.tasks[0].status, 'awaiting_approval')
    assert.equal(state.tasks[0].automaticMergeDecision, null)
    assert.notEqual(state.selectedTaskId, 'post-activation-ui-fix')
    const reloaded = await loadCheckpoint(file)
    assert.equal(reloaded.tasks[0].status, 'awaiting_approval')
    assert.equal(reloaded.tasks[0].automaticMergeDecision, null)
    assert.equal(reloaded.automaticMergeEvents.at(-1).reason, 'trusted_live_verification_unavailable')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('checkpoint reload rejects a fabricated eligible assessment without advancing dependents', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-eligible-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-eligible-ledger', tasks: [
      autoMergeTask(), work('dependent-task', 8, ['post-activation-ui-fix']),
    ] })
    activateStandingAutoMergePolicy(state, autoPolicyAuthorization(), { currentTime: autoMergeAt })
    state.automaticMergeEvents.push({
      sequence: 2, type: 'candidate_assessed', at: autoMergeAtNext.toISOString(),
      taskId: 'post-activation-ui-fix', decisionDigest: 'f'.repeat(64),
      policyDigest: state.automaticMergePolicy.digest, eligible: true, reason: 'eligible',
      repository: autoRepository, prNumber: 999, headSha: autoHead, baseSha: autoBase,
      diffSha256: autoDiff, evidenceRef: autoPrUrl,
    })
    await fs.writeFile(file, `${JSON.stringify(state)}\n`)
    await assert.rejects(loadCheckpoint(file), /Eligible automatic-merge claims cannot be restored without a trusted verification provider/)
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(persisted.tasks[0].status, 'awaiting_approval')
    assert.equal(persisted.tasks[1].status, 'ready')
    assert.equal(persisted.selectedTaskId, null)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('checkpoint reload rejects a fabricated merge_completed event without advancing dependents', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-completion-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-completion-ledger', tasks: [
      autoMergeTask(), work('dependent-task', 8, ['post-activation-ui-fix']),
    ] })
    activateStandingAutoMergePolicy(state, autoPolicyAuthorization(), { currentTime: autoMergeAt })
    state.automaticMergeEvents.push({
      sequence: 2, type: 'merge_completed', at: autoMergeAtNext.toISOString(),
      taskId: 'post-activation-ui-fix', decisionDigest: 'f'.repeat(64),
      policyDigest: state.automaticMergePolicy.digest, repository: autoRepository, prNumber: 999,
      headSha: autoHead, baseSha: autoBase, mergeCommitSha: '5'.repeat(40),
      evidenceRef: `https://github.com/${autoRepository}/commit/${'5'.repeat(40)}`,
      commitVerificationRef: `https://github.com/${autoRepository}/commit/${'5'.repeat(40)}`,
      verifiedAt: autoMergeAtNext.toISOString(),
    })
    await fs.writeFile(file, `${JSON.stringify(state)}\n`)
    await assert.rejects(loadCheckpoint(file), /Automatic-merge completion claims cannot be restored without a trusted verification provider/)
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(persisted.tasks[0].status, 'awaiting_approval')
    assert.equal(persisted.tasks[1].status, 'ready')
    assert.equal(persisted.selectedTaskId, null)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('pre-activation and high-risk policy changes remain on the manual approval path', () => {
  for (const evidence of [
    autoCandidate({ prCreatedAt: '2026-11-08T23:59:00.000Z' }),
    autoCandidate({ changeFlags: ['merge_policy'] }),
  ]) {
    const state = createWorkflow({ objectiveId: 'auto-merge-excluded', tasks: [autoMergeTask()] })
    activateStandingAutoMergePolicy(state, autoPolicyAuthorization(), { currentTime: autoMergeAt })
    const result = recordAutomaticMergeAssessment(state, 'post-activation-ui-fix', evidence, {
      currentTime: autoMergeAtNext,
    })
    assert.equal(result.eligible, false)
    assert.equal(state.tasks[0].status, 'awaiting_approval')
    assert.equal(state.tasks[0].automaticMergeDecision, null)
    assert.equal(state.status, 'blocked')
  }
})

test('revocation preserves the manual approval path when automatic eligibility is unavailable', () => {
  const state = createWorkflow({ objectiveId: 'auto-merge-revocation', tasks: [autoMergeTask()] })
  activateStandingAutoMergePolicy(state, autoPolicyAuthorization(), { currentTime: autoMergeAt })
  const assessment = recordAutomaticMergeAssessment(state, 'post-activation-ui-fix', autoCandidate(), {
    currentTime: autoMergeAtNext,
  })
  assert.equal(assessment.reason, 'trusted_live_verification_unavailable')
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  const outcome = revokeStandingAutoMergePolicy(state, autoPrUrl, {
    currentTime: new Date('2026-11-09T12:01:30.000Z'),
  })
  assert.equal(outcome.revoked, true)
  assert.equal(state.automaticMergePolicy.status, 'revoked')
  assert.equal(state.tasks[0].automaticMergeDecision, null)
  assert.equal(state.tasks[0].status, 'awaiting_approval')
  assert.equal(validateWorkflow(state), state)
})

test('complete_auto_merge rejects caller-supplied host objects and cannot start from fabricated approval', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-auto-merge-alias-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'auto-merge-alias-blocked', tasks: [
      merge('merge-parent'), work('dependent-task', 8, ['merge-parent']),
    ] })
    recordApproval(state, 'merge-parent', {
      action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
      targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
      evidenceRef: 'docs/autonomy/integration-workflow.md#user-approval',
    })
    const beginResult = begin(state)
    assert.equal(beginResult.task, null)
    assert.equal(beginResult.reason, 'blocked')
    assert.equal(state.tasks[0].status, 'blocked')
    assert.equal(state.selectedTaskId, null)
    await saveCheckpoint(file, state)
    const before = JSON.stringify(state)
    await assert.rejects(transitionAndSave(file, state, {
      type: 'complete_auto_merge', taskId: 'merge-parent',
      payload: {
        decisionDigest: 'f'.repeat(64), currentTime: new Date('2026-11-09T12:03:00.000Z'),
        githubResponse: { merged: true, sha: mergedSha, message: 'forged response' },
        postMergePullRequest: {
          number: pr.number, state: 'closed', merged: true, headSha: pr.headSha, baseRef: pr.baseRef,
          mergeCommitSha: mergedSha, mergedAt: '2026-11-09T12:02:00.000Z', url: pr.url,
        },
        verifiedCommit: {
          sha: mergedSha, parents: [pr.baseSha], verifiedAt: '2026-11-09T12:02:30.000Z',
          evidenceRef: `https://github.com/${pr.repository}/commit/${mergedSha}`,
        },
      },
    }), /Unsupported or malformed integration transition/)
    assert.equal(JSON.stringify(state), before)
    const reloaded = await loadCheckpoint(file)
    assert.equal(reloaded.tasks[0].status, 'blocked')
    assert.equal(reloaded.tasks[1].status, 'ready')
    assert.equal(reloaded.selectedTaskId, null)
    assert.equal(reloaded.automaticMergeEvents.some(event => event.type === 'merge_completed'), false)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('automatic-merge agent guidance keeps activation separate and all exact-head roles required', async () => {
  const root = path.resolve(__dirname, '../../..')
  const [agents, developer, reviewer, qa, security, manager, release, policyDoc, liveProtocol, coordinatorCode] = await Promise.all([
    fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/developer.toml'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/reviewer.toml'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/qa.toml'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/security-privacy-engineer.toml'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/merge-manager.toml'), 'utf8'),
    fs.readFile(path.join(root, '.codex/agents/release-reliability-engineer.toml'), 'utf8'),
    fs.readFile(path.join(root, 'docs/autonomy/automatic-merge-policy.md'), 'utf8'),
    fs.readFile(path.join(root, 'docs/autonomy/automatic-merge-live-execution.md'), 'utf8'),
    fs.readFile(path.join(root, 'scripts/autonomy/integration-coordinator.cjs'), 'utf8'),
  ])
  for (const text of [agents, manager, policyDoc]) assert.match(text, /disabled by default|disabled/i)
  assert.match(agents, /created after the recorded activation time/)
  assert.match(agents, /does not provide an always-on agent runner/)
  assert.match(reviewer, /material finding remains unresolved/)
  assert.match(qa, /exact current head/)
  assert.match(security, /exact final diff/)
  assert.match(manager, /not the policy-enabling PR or any PR created before activation/)
  assert.match(liveProtocol, /expected_head_sha/)
  assert.match(liveProtocol, /trusted_live_verification_unavailable/)
  assert.match(liveProtocol, /do not atomically prevent a concurrent retarget/)
  assert.doesNotMatch(coordinatorCode, /github_merge_pull_request/)
  assert.doesNotMatch(coordinatorCode, /recordHostAssistedMergeCompletion|host_merge_observed|record_host_merge_completion/)
  assert.match(manager, /never bypass the evaluator by directly calling the GitHub merge tool/i)
  assert.match(liveProtocol, /cannot\s+invoke those tools or\s+authenticate their results/)
  assert.match(liveProtocol, /bottom-up/)
  assert.match(policyDoc, /strict_required_status_checks_policy: true/)
  assert.match(policyDoc, /Required PR gate/)
  assert.match(policyDoc, /no bypass actors/)
  assert.match(policyDoc, /do not atomically prevent a concurrent retarget/)
  for (const text of [agents, reviewer, qa, security, manager, liveProtocol]) {
    assert.match(text, /active collaboration-tool record/)
    assert.match(text, /checkpoint[\s\S]*(?:proof|not sufficient|audit claim)/i)
  }
  assert.match(release, /invocation-ID strings are claims, not independent evidence/)
  for (const tool of [
    'github_fetch_pr', 'github_list_pr_changed_filenames', 'github_fetch_pr_patch',
    'read_pull_request_check_diagnostics', 'github_list_pull_request_reviews',
    'github_list_pull_request_review_threads', 'github_fetch', 'expected_head_sha',
  ]) assert.match(liveProtocol, new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(liveProtocol, /deployment/)
  assert.match(liveProtocol, /cloud spend/)
  assert.match(liveProtocol, /infrastructure/)
  assert.match(developer, /do not classify your own change as low-risk or approve\/merge it/)
})

// Keep the pure eligibility matrix in the same deterministic CI job as this checkpoint suite.
require('./automatic-merge-policy.test.cjs')

test('a ready merge task without approval is quarantined rather than selected', () => {
  const state = createWorkflow({ objectiveId: 'reject-unauthorized-merge', tasks: [merge('merge-678')] })
  state.tasks[0].status = 'ready'
  assert.equal(validateWorkflow(state), state)
  const result = begin(state)
  assert.equal(result.task, null)
  assert.equal(result.reason, 'blocked')
  assert.equal(state.tasks[0].status, 'blocked')
  assert.equal(state.selectedTaskId, null)
})

test('transitioned fabricated approval is audit-only; only independent work can start', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-approval-transition-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-approval-transition', tasks: [
      merge('merge-parent'), work('merge-dependent', 8, ['merge-parent']), work('independent-task', 1),
    ] })
    await saveCheckpoint(file, state)
    const outcome = await transitionAndSave(file, state, {
      type: 'approve_merge', taskId: 'merge-parent', payload: {
        action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
        targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner', evidenceRef: pr.url,
      },
    })
    assert.equal(outcome.task.id, 'independent-task')
    assert.equal(state.tasks[0].status, 'blocked')
    assert.equal(state.tasks[0].approval.headSha, pr.headSha)
    assert.equal(state.tasks[1].status, 'ready')

    const resumed = await loadCheckpoint(file)
    const next = begin(resumed)
    assert.equal(next.task.id, 'independent-task')
    assert.equal(next.reason, 'active_task')
    assert.equal(resumed.tasks[0].status, 'blocked')
    assert.equal(resumed.selectedTaskId, 'independent-task')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('restored running merge task with fabricated approval is blocked before resume', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-running-forged-merge-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'running-forged-merge', tasks: [
      merge('merge-parent'), work('merge-dependent', 8, ['merge-parent']), work('independent-task', 1),
    ] })
    state.tasks[0].status = 'running'
    state.tasks[0].attempts = 1
    state.tasks[0].approval = {
      action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
      targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner', evidenceRef: pr.url,
    }
    state.selectedTaskId = 'merge-parent'
    state.selections = 1
    state.events = [
      { sequence: 1, type: 'merge_authorized', taskId: 'merge-parent', evidenceRef: pr.url,
        headSha: pr.headSha, baseSha: pr.baseSha },
      { sequence: 2, type: 'task_selected', taskId: 'merge-parent', attempt: 1, selection: 1 },
    ]
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await loadCheckpoint(file)
    assert.equal(resumed.tasks[0].status, 'blocked')
    assert.equal(resumed.tasks[0].blockerCode, 'unavailable_evidence')
    assert.equal(resumed.selectedTaskId, null)
    assert.equal(begin(resumed).task.id, 'independent-task')
    assert.equal(resumed.tasks[1].status, 'ready')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('a changed PR head invalidates prior approval while independent work advances', () => {
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
  assert.equal(state.events.some(item => item.type === 'merge_scope_changed' && item.previous.headSha === sha &&
    item.current.headSha === updatedPr.headSha), true)
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

test('manual completion audit claim cannot release transitive dependencies while independent work advances', () => {
  const state = createWorkflow({ objectiveId: 'dependency-resume', tasks: [
    merge('merge-base'), work('dependent', 8, ['merge-base']),
    work('grandchild', 7, ['dependent']), work('independent', 1),
  ] })
  const approval = {
    action: 'merge', repository: pr.repository, prNumber: pr.number, headSha: pr.headSha,
    targetBranch: pr.baseRef, baseSha: pr.baseSha, approver: 'repository-owner',
    evidenceRef: 'docs/autonomy/integration-workflow.md#user-approval',
  }
  const approvalResult = recordApproval(state, 'merge-base', approval)
  assert.equal(approvalResult.task.id, 'independent')
  assert.equal(state.tasks[0].status, 'blocked')
  assert.throws(() => completeTask(state, 'merge-base', {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
    commitSha: mergedSha,
  }), /Task is not the active selected task/)
  // A direct checkpoint edit can still claim completion; it remains audit data.
  const mergeTask = state.tasks[0]
  mergeTask.status = 'completed'
  mergeTask.blockerCode = null
  mergeTask.retryExhausted = false
  mergeTask.result = {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
    mergeCommitSha: mergedSha,
  }
  const result = begin(state)
  assert.equal(result.task.id, 'independent')
  assert.equal(result.reason, 'active_task')
  assert.equal(state.status, 'active')
  assert.equal(state.tasks[0].status, 'completed')
  assert.equal(state.tasks[1].status, 'ready')
  assert.equal(state.tasks[2].status, 'ready')
  assert.equal(state.selectedTaskId, 'independent')
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
  assert.equal(authorized.task, null)
  assert.equal(authorized.reason, 'blocked')
  assert.equal(state.tasks.find(task => task.id === 'merge-parent').status, 'blocked')
  assert.equal(state.tasks.find(task => task.id === 'review-child').status, 'ready')
})

test('checkpoint reload preserves manual completion as audit but does not resume dependent work', async () => {
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
    assert.equal(reopened.selectedTaskId, null)
    const result = begin(reopened)
    assert.equal(result.task, null)
    assert.equal(result.reason, 'blocked')
    assert.equal(reopened.tasks[0].status, 'blocked')
    assert.equal(reopened.tasks[0].approval.headSha, sha)
    assert.equal(reopened.tasks[0].pr.baseSha, pr.baseSha)

    assert.throws(() => completeTask(reopened, 'merge-678', {
      evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/' + mergedSha,
      commitSha: mergedSha,
    }), /Task is not the active selected task/)
    await saveCheckpoint(file, reopened)
    const nextSession = await loadCheckpoint(file)
    const resumedResult = begin(nextSession)
    assert.equal(resumedResult.task, null)
    assert.equal(resumedResult.reason, 'blocked')
    assert.equal(nextSession.status, 'blocked')
    assert.equal(nextSession.tasks[0].status, 'blocked')
    assert.equal(nextSession.tasks[0].result, null)
    assert.equal(nextSession.tasks[1].status, 'ready')
    assert.equal(nextSession.selectedTaskId, null)
    assert.equal(nextSession.tasks[0].approval.targetBranch, 'main')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('forged approval, stale merged-PR fields, fake SHA, events, and transitive completion cannot unlock dependents', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-manual-chain-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-manual-chain', tasks: [
      merge('merge-parent'), work('completed-child', 90, ['merge-parent']),
      work('dependent-grandchild', 80, ['completed-child']), work('independent-task', 1),
    ] })
    const parent = state.tasks.find(task => task.id === 'merge-parent')
    const child = state.tasks.find(task => task.id === 'completed-child')
    const fakeCommit = 'e'.repeat(40)
    parent.pr.headSha = 'c'.repeat(40) // the persisted PR scope has drifted from the original approval event
    parent.pr.baseSha = 'f'.repeat(40)
    const fakeCommitRef = `https://github.com/${pr.repository}/commit/${fakeCommit}`
    parent.pr.state = 'merged'
    parent.pr.mergeCommitSha = fakeCommit
    parent.pr.checkedOn = '2020-01-01'
    parent.approval = {
      action: 'merge', repository: pr.repository, prNumber: pr.number,
      headSha: parent.pr.headSha, targetBranch: pr.baseRef, baseSha: parent.pr.baseSha,
      approver: 'repository-owner', evidenceRef: pr.url,
    }
    parent.status = 'completed'
    parent.result = { evidenceRef: fakeCommitRef, mergeCommitSha: fakeCommit }
    child.status = 'completed'
    child.result = { evidenceRef: 'docs/autonomy/integration-workflow.md#fabricated-dependent-result' }
    state.events = [
      { sequence: 1, type: 'merge_authorized', taskId: 'merge-parent', evidenceRef: pr.url,
        headSha: pr.headSha, baseSha: pr.baseSha }, // stale authorization event remains structurally valid
      { sequence: 2, type: 'task_completed', taskId: 'merge-parent', evidenceRef: fakeCommitRef, commitSha: fakeCommit },
      { sequence: 3, type: 'task_completed', taskId: 'completed-child',
        evidenceRef: 'docs/autonomy/integration-workflow.md#fabricated-dependent-result' },
    ]
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await loadCheckpoint(file)
    assert.equal(resumed.tasks[0].status, 'completed') // retained as audit data
    assert.equal(resumed.tasks[0].pr.state, 'merged') // stale, caller-controlled PR state is not trusted
    assert.equal(resumed.tasks[0].result.mergeCommitSha, fakeCommit)
    assert.equal(resumed.tasks[1].status, 'completed') // transitive completion remains untrusted too
    assert.equal(resumed.tasks[2].status, 'ready')
    assert.equal(resumed.selectedTaskId, null)

    const next = begin(resumed)
    assert.equal(next.task.id, 'independent-task')
    assert.equal(resumed.tasks[2].status, 'ready')
    assert.equal(resumed.tasks[3].status, 'running')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('work-kind task with fabricated merged PR metadata is still treated as unverified merge history', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-demoted-merge-kind-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'demoted-merge-kind', tasks: [
      merge('merge-parent'), work('dependent-task', 100, ['merge-parent']), work('independent-task', 1),
    ] })
    const parent = state.tasks[0]
    const fakeCommit = '9'.repeat(40)
    parent.kind = 'work' // altered task kind cannot erase merge-shaped evidence
    parent.status = 'completed'
    parent.approval = null
    parent.pr.state = 'merged'
    parent.pr.mergeCommitSha = fakeCommit
    parent.pr.checkedOn = '2020-01-01'
    parent.result = { evidenceRef: `https://github.com/${pr.repository}/commit/${fakeCommit}`, mergeCommitSha: fakeCommit }
    state.events = [{ sequence: 1, type: 'historical_merge_confirmed', taskId: parent.id,
      evidenceRef: pr.url, headSha: pr.headSha, targetBranch: pr.baseRef }]
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await loadCheckpoint(file)
    const next = begin(resumed)
    assert.equal(next.task.id, 'independent-task')
    assert.equal(resumed.tasks[1].status, 'ready')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('restored running dependent task is reset and cannot resume ahead of independent work', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-running-dependent-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-running-dependent', tasks: [
      merge('merge-parent'), work('dependent-task', 100, ['merge-parent']), work('independent-task', 1),
    ] })
    const parent = state.tasks[0]
    const dependent = state.tasks[1]
    parent.status = 'completed'
    parent.approval = {
      action: 'merge', repository: pr.repository, prNumber: pr.number,
      headSha: pr.headSha, targetBranch: pr.baseRef, baseSha: pr.baseSha,
      approver: 'repository-owner', evidenceRef: pr.url,
    }
    parent.result = { evidenceRef: pr.url, mergeCommitSha: mergedSha }
    dependent.status = 'running'
    dependent.attempts = 1
    state.selectedTaskId = dependent.id
    state.selections = 1
    state.events = [
      { sequence: 1, type: 'task_completed', taskId: parent.id,
        evidenceRef: `https://github.com/${pr.repository}/commit/${mergedSha}`, commitSha: mergedSha },
      { sequence: 2, type: 'task_selected', taskId: dependent.id, attempt: 1, selection: 1 },
    ]
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await loadCheckpoint(file)
    assert.equal(resumed.selectedTaskId, null)
    assert.equal(resumed.tasks[1].status, 'ready')
    const next = begin(resumed)
    assert.equal(next.task.id, 'independent-task')
    assert.equal(resumed.tasks[1].status, 'ready')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('forged terminal marker cannot hide an unverified merge dependency', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-forged-terminal-'))
  const file = path.join(temp, 'integration.json')
  try {
    const state = createWorkflow({ objectiveId: 'forged-terminal', tasks: [
      merge('merge-parent'), work('dependent-task', 5, ['merge-parent']), work('independent-completed', 1),
    ] })
    const fakeCommit = 'f'.repeat(40)
    for (const task of state.tasks) {
      task.status = 'completed'
      task.result = task.kind === 'merge'
        ? { evidenceRef: `https://github.com/${pr.repository}/commit/${fakeCommit}`, mergeCommitSha: fakeCommit }
        : { evidenceRef: 'docs/autonomy/integration-workflow.md#forged-terminal' }
    }
    state.tasks[0].approval = {
      action: 'merge', repository: pr.repository, prNumber: pr.number,
      headSha: pr.headSha, targetBranch: pr.baseRef, baseSha: pr.baseSha,
      approver: 'repository-owner', evidenceRef: pr.url,
    }
    state.status = 'completed'
    state.stopReason = 'objective_complete'
    state.events = state.tasks.map((task, index) => ({
      sequence: index + 1, type: 'task_completed', taskId: task.id,
      evidenceRef: task.result.evidenceRef,
      ...(task.kind === 'merge' ? { commitSha: fakeCommit } : {}),
    }))
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await loadCheckpoint(file)
    assert.equal(resumed.status, 'active')
    const next = begin(resumed)
    assert.equal(next.task, null)
    assert.equal(next.reason, 'blocked')
    assert.equal(resumed.status, 'blocked')
    assert.equal(resumed.tasks[2].status, 'completed') // unrelated history is retained
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
    for (const task of legacy.tasks) {
      delete task.rejection
      delete task.automaticMergeDecision
    }
    delete legacy.automaticMergePolicy
    delete legacy.automaticMergeEvents
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`)
    const oldEventCount = legacy.events.length
    const migrated = await loadCheckpoint(file)
    assert.equal(migrated.tasks.length, 2)
    assert.equal(migrated.events.length, oldEventCount)
    assert.equal(migrated.tasks[0].rejection, null)
    assert.equal(migrated.tasks[0].automaticMergeDecision, null)
    assert.equal(migrated.automaticMergePolicy.status, 'disabled')
    assert.deepEqual(migrated.automaticMergeEvents, [])
    assert.equal(migrated.tasks[0].approval.headSha, pr.headSha)
    assert.equal(migrated.tasks[0].approval.baseSha, pr.baseSha)
    assert.equal(migrated.status, 'blocked')
    assert.equal(migrated.stopReason, 'no_actionable_task')
    assert.equal(migrated.selectedTaskId, null)

    const next = await transitionAndSave(file, migrated, { type: 'begin' })
    assert.equal(next.task, null)
    assert.equal(next.reason, 'blocked')
    const reopened = await loadCheckpoint(file)
    assert.equal(reopened.tasks.length, 2)
    assert.equal(reopened.tasks[0].status, 'blocked')
    assert.equal(reopened.tasks[0].result, null)
    assert.equal(reopened.tasks[0].approval.headSha, pr.headSha)
    assert.equal(reopened.tasks[1].status, 'ready')
    assert.equal(reopened.selectedTaskId, null)
    assert.equal(reopened.status, 'blocked')
    assert.equal(reopened.stopReason, 'no_actionable_task')
    assert.equal(reopened.events.length, oldEventCount)
    assert.ok(reopened.events.some(event => event.type === 'merge_authorized'))
    assert.ok(!reopened.events.some(event => event.type === 'task_completed'))
    assert.ok(reopened.tasks.every(task => task.rejection === null))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('version-controlled integration checkpoint loads verified PR states and dependency graph', async () => {
  const checkpoint = await loadCheckpoint(DEFAULT_CHECKPOINT)
  assert.equal(checkpoint.objectiveId, 'autonomous-integration')
  assert.equal(checkpoint.automaticMergePolicy.status, 'disabled')
  assert.deepEqual(checkpoint.automaticMergeEvents, [])
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
  const merged695 = checkpoint.tasks.find(task => task.id === 'pr-695-merge')
  assert.equal(merged695.status, 'completed')
  assert.equal(merged695.approval?.repository, 'HamedGithubforwork/QuizForge-AI')
  assert.equal(merged695.approval?.prNumber, 695)
  assert.equal(merged695.approval?.headSha, '176fc7961781d622519597a4c8268b33d40d4514')
  assert.equal(merged695.approval?.targetBranch, 'main')
  assert.equal(merged695.approval?.baseSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(merged695.approval?.evidenceRef, 'docs/autonomy/integration-workflow.md#pr-695-merge-authorization-2026-11-09')
  assert.equal(merged695.pr.headSha, '176fc7961781d622519597a4c8268b33d40d4514')
  assert.equal(merged695.pr.baseSha, '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff')
  assert.equal(merged695.pr.state, 'merged')
  assert.equal(merged695.pr.mergeCommitSha, '4213fe2b7160bdc2e12c5e9661611544e251ae48')
  assert.deepEqual(merged695.result, {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/commit/4213fe2b7160bdc2e12c5e9661611544e251ae48',
    mergeCommitSha: '4213fe2b7160bdc2e12c5e9661611544e251ae48',
  })
  assert.ok(merged695.evidenceRefs.includes('https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42689434199'))
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
  const merge690 = checkpoint.tasks.find(task => task.id === 'pr-690-merge')
  assert.equal(merge690.pr.baseRef, 'main')
  assert.equal(merge690.pr.baseSha, '4213fe2b7160bdc2e12c5e9661611544e251ae48')
  assert.equal(merge690.pr.headSha, '190f6d98ca59baedddf9e7242bb8c3e63de4ec38')
  assert.equal(merge690.pr.mergeable, true)
  assert.equal(merge690.status, 'awaiting_approval')
  assert.equal(merge690.approval, null)
  const merge698 = checkpoint.tasks.find(task => task.id === 'pr-698-merge')
  assert.equal(merge698.pr.baseRef, 'main')
  assert.equal(merge698.pr.baseSha, '4213fe2b7160bdc2e12c5e9661611544e251ae48')
  assert.equal(merge698.pr.headSha, 'ee9e6d2fd10f29f41ac255016358595a215d3a61')
  assert.equal(merge698.pr.mergeable, true)
  assert.equal(merge698.status, 'awaiting_approval')
  assert.equal(merge698.approval, null)
  assert.equal(checkpoint.status, 'blocked')
  assert.equal(checkpoint.stopReason, 'no_actionable_task')
  assert.equal(checkpoint.selectedTaskId, null)
  const reconcile690 = checkpoint.tasks.find(task => task.id === 'pr-690-reconcile')
  assert.equal(reconcile690.status, 'completed')
  assert.equal(reconcile690.title, 'Reconcile PR 690 after CI-stack prerequisites are integrated')
  assert.ok(reconcile690.attempts > 0)
  assert.equal(reconcile690.pr.baseRef, 'main')
  assert.equal(reconcile690.pr.baseSha, '4213fe2b7160bdc2e12c5e9661611544e251ae48')
  assert.equal(reconcile690.pr.headSha, '190f6d98ca59baedddf9e7242bb8c3e63de4ec38')
  assert.equal(reconcile690.pr.mergeable, true)
  assert.ok(reconcile690.evidenceRefs.includes('https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42692660221'))
  assert.ok(reconcile690.evidenceRefs.includes('https://github.com/HamedGithubforwork/QuizForge-AI/commit/190f6d98ca59baedddf9e7242bb8c3e63de4ec38'))
  assert.deepEqual(reconcile690.result, {
    evidenceRef: 'https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42692660221',
    commitSha: '190f6d98ca59baedddf9e7242bb8c3e63de4ec38',
  })
  assert.deepEqual(reconcile690.dependencies, ['pr-695-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-690-merge').dependencies, ['pr-690-reconcile'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-691-reconcile').dependencies, ['pr-690-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-691-merge').dependencies, ['pr-691-reconcile'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-692-reconcile').dependencies, ['pr-691-merge'])
  assert.deepEqual(checkpoint.tasks.find(task => task.id === 'pr-694-reconcile').dependencies, ['pr-691-merge'])
  const merge691 = checkpoint.tasks.find(task => task.id === 'pr-691-merge')
  assert.equal(merge691.pr.baseSha, '190f6d98ca59baedddf9e7242bb8c3e63de4ec38')
  assert.equal(merge691.pr.headSha, 'baddbbc98c5a14bc14f664a01f2d79390e9d70c9')
  const merge692 = checkpoint.tasks.find(task => task.id === 'pr-692-merge')
  assert.equal(merge692.pr.baseSha, 'baddbbc98c5a14bc14f664a01f2d79390e9d70c9')
  assert.equal(merge692.pr.headSha, '8dda007e79afe77dc77a5c186e6e16ab1fa1cc6b')
  const merge694 = checkpoint.tasks.find(task => task.id === 'pr-694-merge')
  assert.equal(merge694.pr.baseSha, 'baddbbc98c5a14bc14f664a01f2d79390e9d70c9')
  assert.equal(merge694.pr.headSha, '03eb7c038c972fb49909019d846c02a69767b18f')
  for (const [task, runId] of [
    [merge691, 42695584837], [merge692, 42697462238], [merge694, 42698118455], [merge698, 42694126716],
  ]) assert.ok(task.evidenceRefs.includes(`https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/${runId}`))
  for (const number of [698, 690, 691, 692, 694]) {
    const mergeTask = checkpoint.tasks.find(task => task.id === `pr-${number}-merge`)
    assert.equal(mergeTask.status, 'awaiting_approval')
    assert.equal(mergeTask.approval, null)
    assert.match(mergeTask.pr.baseSha, /^[a-f0-9]{40}$/)
  }
  assert.equal(checkpoint.tasks.filter(task => task.kind === 'merge').length, 6)
  assert.equal(checkpoint.tasks.filter(task => task.kind === 'merge' && task.status === 'completed').length, 1)
  assert.ok(checkpoint.tasks.filter(task => task.kind === 'merge' && task.status !== 'completed')
    .every(task => task.status === 'awaiting_approval' && task.approval === null))
  for (const number of [691, 692, 694]) {
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

test('checkpoint validation reconciles false terminal markers and rejects malformed states/counters', () => {
  const unknownKind = createWorkflow({ objectiveId: 'unknown-task-kind', tasks: [work('one')] })
  unknownKind.tasks[0].kind = 'shell'
  assert.throws(() => validateWorkflow(unknownKind), /Malformed integration task record/)

  const unfinished = createWorkflow({ objectiveId: 'unfinished-completed', tasks: [work('one'), work('two')] })
  unfinished.status = 'completed'; unfinished.stopReason = 'objective_complete'
  assert.equal(validateWorkflow(unfinished), unfinished)
  assert.equal(unfinished.status, 'active')
  assert.equal(unfinished.stopReason, null)

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
