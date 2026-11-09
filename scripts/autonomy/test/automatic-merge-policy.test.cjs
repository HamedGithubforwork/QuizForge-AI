'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const policyApi = require('../automatic-merge-policy.cjs')

const repository = 'HamedGithubforwork/QuizForge-AI'
const activationTime = new Date('2026-11-10T12:00:00.000Z')
const now = new Date('2026-11-10T12:30:00.000Z')
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const diffSha = 'c'.repeat(64)
const prUrl = `https://github.com/${repository}/pull/999`
const evidenceUrl = prUrl
const runUrl = `https://github.com/${repository}/actions/runs/12345`
const rulesetUrl = `https://github.com/${repository}/rulesets/123`

function authorization(overrides = {}) {
  return {
    repository,
    targetBranch: 'main',
    version: policyApi.POLICY_VERSION,
    digest: policyApi.POLICY_DIGEST,
    authorizedBy: 'QuizForgeOwner',
    authorizedAt: activationTime.toISOString(),
    expiresAt: '2027-01-01T00:00:00.000Z',
    approvalEvidenceRef: evidenceUrl,
    implementationMergeSha: 'd'.repeat(40),
    implementationEvidenceRef: `https://github.com/${repository}/commit/${'d'.repeat(40)}`,
    ...overrides,
  }
}

function activePolicy(overrides = {}) {
  return policyApi.activatePolicy({
    policy: policyApi.defaultPolicy(),
    authorization: authorization(overrides),
    now: activationTime,
  })
}

function assessment(role, overrides = {}) {
  return {
    passed: true,
    headSha: head,
    invocationId: `${role}-session-20261110-1`,
    evidenceRef: evidenceUrl,
    ...overrides,
  }
}

function candidate(overrides = {}) {
  return {
    repository,
    targetBranch: 'main',
    prNumber: 999,
    prUrl,
    prCreatedAt: '2026-11-10T12:10:00.000Z',
    category: 'low_risk_ui',
    riskFindings: [],
    changeFlags: [],
    changedFiles: ['src/components/quiz/QuizCard.tsx'],
    headSha: head,
    baseSha: base,
    currentHeadSha: head,
    currentBaseSha: base,
    diffSha256: diffSha,
    diffEvidenceRef: `${prUrl}/files`,
    observedAt: now.toISOString(),
    tests: { passed: true, headSha: head, evidenceRef: evidenceUrl },
    coordinator: { invocationId: 'coordinator-session-20261110-1', headSha: head, evidenceRef: evidenceUrl },
    developer: { invocationId: 'developer-session-20261110-1', commitSha: head, evidenceRef: evidenceUrl },
    reviewer: assessment('reviewer'),
    qa: assessment('qa'),
    security: assessment('security'),
    requiredCheck: {
      name: 'Required PR gate', conclusion: 'success', headSha: head, baseSha: base,
      prNumber: 999, runUrl, completedAt: now.toISOString(), associatedPr: true,
    },
    reviews: { blocking: false, unresolvedMaterialConcern: false, evidenceRef: evidenceUrl },
    protections: { verified: true, evidenceRef: evidenceUrl, rulesetRef: rulesetUrl },
    sideEffects: {
      assessed: true, productionDeployment: false, cloudSpend: false, destructive: false,
      unexpectedExternalSideEffects: false, evidenceRef: evidenceUrl,
    },
    mergeManager: {
      passed: true, headSha: head, baseSha: base, diffSha256: diffSha,
      diffInspected: true, riskClassification: 'low_risk', invocationId: 'merge_manager-session-20261110-1', evidenceRef: evidenceUrl,
    },
    ...overrides,
  }
}

test('standing low-risk policy defaults disabled and fails closed', () => {
  const disabled = policyApi.defaultPolicy()
  assert.equal(disabled.status, 'disabled')
  assert.equal(policyApi.evaluateCandidate({ policy: disabled, evidence: candidate(), now }).reason, 'policy_disabled')
})

test('activation requires a current explicit authorization scoped to this repository, main, and policy digest', () => {
  const enabled = activePolicy()
  assert.equal(enabled.status, 'active')
  assert.equal(enabled.repository, repository)
  assert.equal(enabled.targetBranch, 'main')
  assert.equal(enabled.implementationMergeSha, 'd'.repeat(40))
  assert.equal(enabled.implementationEvidenceRef, `https://github.com/${repository}/commit/${'d'.repeat(40)}`)
  for (const change of [
    { repository: 'someone/else' },
    { targetBranch: 'release' },
    { digest: '0'.repeat(64) },
    { authorizedAt: '2026-11-10T11:59:59.000Z' },
    { expiresAt: '2027-12-01T00:00:00.000Z' },
    { implementationMergeSha: 'e'.repeat(40) },
    { implementationEvidenceRef: `https://github.com/${repository}/commit/${'e'.repeat(40)}` },
    { implementationMergeSha: 'invalid' },
  ]) {
    assert.throws(() => activePolicy(change), /explicit authorization|scoped user-authorization/)
  }
})

test('existing and self-enabling PRs cannot enter a standing policy activated afterward', () => {
  const enabled = activePolicy()
  const prior = candidate({ prNumber: 698, prUrl: `https://github.com/${repository}/pull/698`,
    prCreatedAt: '2026-11-09T10:00:00.000Z', diffEvidenceRef: `https://github.com/${repository}/pull/698/files` })
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: prior, now }).reason, 'pr_predates_policy_activation')
  const createdAtActivation = candidate({ prCreatedAt: enabled.activatedAt })
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: createdAtActivation, now }).reason,
    'pr_predates_policy_activation')
  const selfEnabling = candidate({ changeFlags: ['merge_policy'] })
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: selfEnabling, now }).reason, 'high_risk_or_uncertain_change')
})

test('a fresh low-risk PR passes only with exact independent assessments and safeguards', () => {
  assert.deepEqual(policyApi.evaluateCandidate({ policy: activePolicy(), evidence: candidate(), now }),
    { eligible: true, reason: 'eligible' })
})

test('high-risk, policy, and uncertain changes are excluded even if other evidence passes', () => {
  const enabled = activePolicy()
  for (const risk of policyApi.EXCLUDED_RISKS) {
    const result = policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ riskFindings: [risk] }), now })
    assert.equal(result.eligible, false, risk)
  }
  for (const flag of policyApi.EXCLUDED_RISKS) {
    const result = policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ changeFlags: [flag] }), now })
    assert.equal(result.eligible, false, flag)
  }
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ category: 'infrastructure' }), now }).eligible, false)
})

test('protected files independently block automatic merge despite empty risk claims and passing evidence', () => {
  const enabled = activePolicy()
  for (const changedFile of [
    'AGENTS.md', '.github/workflows/ci.yml', 'scripts/autonomy/optimization-orchestrator.cjs',
    'scripts/ci/test-pr-ci-trigger.cjs', 'docs/autonomy/supervised-merge.md',
    '.codex/agents/merge-manager.toml', 'backend/alembic/versions/0001_initial.py',
    'terraform/main.tf', 'infra/deploy/config.yml',
  ]) {
    const result = policyApi.evaluateCandidate({
      policy: enabled,
      evidence: candidate({ changedFiles: [changedFile], riskFindings: [], changeFlags: [] }),
      now,
    })
    assert.deepEqual(result, { eligible: false, reason: 'protected_path_changed' }, changedFile)
  }
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ changedFiles: [] }), now }).reason,
    'protected_path_changed')
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ changedFiles: ['../src/app.tsx'] }), now }).reason,
    'protected_path_changed')
})

test('changed head, base, or final diff invalidates the candidate', () => {
  const enabled = activePolicy()
  for (const update of [
    { currentHeadSha: 'd'.repeat(40) },
    { currentBaseSha: 'e'.repeat(40) },
    { diffSha256: 'f'.repeat(64) },
  ]) assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate(update), now }).eligible, false)
})

test('missing, skipped, failed, stale, or unassociated Required PR checks block eligibility', () => {
  const enabled = activePolicy()
  for (const update of [
    { conclusion: 'skipped' },
    { conclusion: 'failure' },
    { associatedPr: false },
    { headSha: 'd'.repeat(40) },
  ]) {
    const result = policyApi.evaluateCandidate({ policy: enabled,
      evidence: candidate({ requiredCheck: { ...candidate().requiredCheck, ...update } }), now })
    assert.equal(result.reason, 'required_check_unverified')
  }
  const missing = candidate()
  delete missing.requiredCheck
  assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: missing, now }).reason, 'evidence_missing_or_invalid')
  assert.equal(policyApi.evaluateCandidate({ policy: enabled,
    evidence: candidate({ observedAt: '2026-11-10T11:54:59.000Z' }), now }).reason, 'live_evidence_stale')
})

test('missing or failed Reviewer, QA, or Security evidence blocks eligibility', () => {
  const enabled = activePolicy()
  for (const role of ['reviewer', 'qa', 'security']) {
    for (const invalid of [null, assessment(role, { passed: false }), assessment(role, { headSha: 'd'.repeat(40) })]) {
      assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate({ [role]: invalid }), now }).eligible, false, role)
    }
  }
})

test('Coordinator and Developer provenance must identify actual invocations and the exact candidate head', () => {
  const enabled = activePolicy()
  for (const update of [
    { coordinator: undefined },
    { coordinator: { ...candidate().coordinator, headSha: 'd'.repeat(40) } },
    { coordinator: { ...candidate().coordinator, invocationId: '' } },
    { developer: undefined },
    { developer: { ...candidate().developer, commitSha: 'd'.repeat(40) } },
    { developer: { ...candidate().developer, invocationId: '' } },
  ]) {
    const result = policyApi.evaluateCandidate({ policy: enabled, evidence: candidate(update), now })
    assert.equal(result.eligible, false)
  }
})

test('unresolved findings, unverified protections, effects, or failed Manager assessment block', () => {
  const enabled = activePolicy()
  const updates = [
    { reviews: { blocking: true, unresolvedMaterialConcern: false, evidenceRef: evidenceUrl } },
    { reviews: { blocking: false, unresolvedMaterialConcern: true, evidenceRef: evidenceUrl } },
    { protections: { verified: false, evidenceRef: evidenceUrl, rulesetRef: rulesetUrl } },
    { sideEffects: { ...candidate().sideEffects, productionDeployment: true } },
    { mergeManager: { ...candidate().mergeManager, riskClassification: 'uncertain' } },
    { mergeManager: { ...candidate().mergeManager, invocationId: '' } },
  ]
  for (const update of updates) assert.equal(policyApi.evaluateCandidate({ policy: enabled, evidence: candidate(update), now }).eligible, false)
})

test('revoked and expired policy cannot authorize automatic merges', () => {
  const active = activePolicy()
  const revoked = policyApi.revokePolicy(active, {
    revokedAt: '2026-11-10T12:01:00.000Z', evidenceRef: `https://github.com/${repository}/issues/555`,
  })
  assert.equal(policyApi.evaluateCandidate({ policy: revoked, evidence: candidate(), now: new Date('2026-11-10T12:02:00.000Z') }).reason, 'policy_revoked')
  assert.equal(policyApi.evaluateCandidate({ policy: active, evidence: candidate(), now: new Date('2027-01-02T00:00:00.000Z') }).reason, 'policy_expired')
})
