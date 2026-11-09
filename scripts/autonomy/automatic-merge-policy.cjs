'use strict'

// Pure, fail-closed policy checks. This module neither authenticates the
// approval claim nor calls GitHub, dispatches agents, or performs merges.
const crypto = require('node:crypto')

const POLICY_VERSION = 'standing-low-risk-auto-merge-v1'
const POLICY_MANIFEST = Object.freeze({
  repository: 'HamedGithubforwork/QuizForge-AI',
  targetBranch: 'main',
  maxAuthorizationDays: 90,
  liveEvidenceMaxAgeMs: 5 * 60 * 1000,
  categories: ['documentation', 'test_coverage', 'low_risk_ui', 'ordinary_application_bug_fix', 'application_performance'],
  requiredRoles: ['coordinator', 'developer', 'reviewer', 'qa', 'security', 'merge_manager'],
  protectedPathPrefixes: [
    '.github/workflows/', 'scripts/autonomy/', 'scripts/ci/', 'docs/autonomy/', '.codex/agents/',
    'terraform/', 'infra/', 'infrastructure/', 'database/migrations/', 'db/migrations/',
    'backend/migrations/', 'backend/migration/', 'backend/alembic/', 'migrations/',
  ],
  protectedPaths: [
    'AGENTS.md', 'CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md',
    '.github/dependabot.yml', '.github/dependabot.yaml',
  ],
  excludedRisks: [
    'authentication', 'authorization', 'permissions', 'secrets', 'security_sensitive',
    'infrastructure', 'aws_infrastructure', 'production_deployment', 'database_schema',
    'database_migration', 'user_data', 'billing', 'cloud_spending', 'destructive',
    'ci_gate', 'branch_protection', 'agent_permissions', 'merge_policy',
    'unexpected_external_side_effect', 'out_of_scope', 'uncertain',
  ],
  semantics: 'explicit-post-merge-activation;future-prs-only;exact-head-base-diff;fresh-required-ci;reviewer-qa-security-manager;current-protections;no-effects;fail-closed',
})
const POLICY_DIGEST = crypto.createHash('sha256').update(JSON.stringify(POLICY_MANIFEST)).digest('hex')
const SHA = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const PR_REF = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/
const EVIDENCE_REF = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull\/[1-9][0-9]*(?:\/(?:files|commits|checks|reviews))?|issues\/[1-9][0-9]*|actions\/runs\/[1-9][0-9]*|rulesets\/[1-9][0-9]*|commit\/[a-f0-9]{40})$/
const CATEGORIES = Object.freeze([...POLICY_MANIFEST.categories])
const EXCLUDED_RISKS = Object.freeze([...POLICY_MANIFEST.excludedRisks])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed, required = allowed) {
  return isObject(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key))
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

function evidenceRef(value, repository) {
  return typeof value === 'string' && value.length <= 240 && EVIDENCE_REF.test(value) &&
    value.startsWith(`https://github.com/${repository}/`)
}

function hasProtectedPath(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return true
  return changedFiles.some(file => {
    if (typeof file !== 'string' || file.length === 0 || file.length > 512 || file.startsWith('/') || file.includes('\\')) return true
    const segments = file.split('/')
    if (segments.some(segment => segment === '.' || segment === '..' || segment.length === 0)) return true
    return POLICY_MANIFEST.protectedPaths.includes(file) ||
      POLICY_MANIFEST.protectedPathPrefixes.some(prefix => file.startsWith(prefix)) ||
      segments.some((segment, index) => segment === 'migrations' || segment === 'migration' || segment === 'alembic' ||
        (segment === 'db' && segments[index + 1] === 'schema'))
  })
}

function defaultPolicy() {
  return Object.freeze({
    status: 'disabled',
    version: POLICY_VERSION,
    digest: POLICY_DIGEST,
    repository: POLICY_MANIFEST.repository,
    targetBranch: POLICY_MANIFEST.targetBranch,
    activatedAt: null,
    expiresAt: null,
    authorizedBy: null,
    approvalEvidenceRef: null,
    implementationMergeSha: null,
    implementationEvidenceRef: null,
    revokedAt: null,
    revocationEvidenceRef: null,
  })
}

function validatePolicy(policy, { now = new Date() } = {}) {
  const fields = [
    'status', 'version', 'digest', 'repository', 'targetBranch', 'activatedAt', 'expiresAt',
    'authorizedBy', 'approvalEvidenceRef', 'implementationMergeSha', 'implementationEvidenceRef',
    'revokedAt', 'revocationEvidenceRef',
  ]
  if (!exactKeys(policy, fields) || !['disabled', 'active', 'revoked'].includes(policy.status) ||
      policy.version !== POLICY_VERSION || policy.digest !== POLICY_DIGEST ||
      policy.repository !== POLICY_MANIFEST.repository || policy.targetBranch !== POLICY_MANIFEST.targetBranch) {
    throw new Error('Automatic merge policy is missing, invalid, or out of scope')
  }
  if (policy.status === 'disabled') {
    if (policy.activatedAt !== null || policy.expiresAt !== null || policy.authorizedBy !== null ||
        policy.approvalEvidenceRef !== null || policy.implementationMergeSha !== null ||
        policy.implementationEvidenceRef !== null || policy.revokedAt !== null || policy.revocationEvidenceRef !== null) {
      throw new Error('Disabled automatic merge policy cannot carry activation or revocation authority')
    }
    return policy
  }
  if (!isIso(policy.activatedAt) || !isIso(policy.expiresAt) ||
      Date.parse(policy.activatedAt) > Date.parse(now) ||
      Date.parse(policy.expiresAt) <= Date.parse(policy.activatedAt) ||
      Date.parse(policy.expiresAt) - Date.parse(policy.activatedAt) > POLICY_MANIFEST.maxAuthorizationDays * 86400000 ||
      typeof policy.authorizedBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{1,79}$/.test(policy.authorizedBy) ||
      !evidenceRef(policy.approvalEvidenceRef, policy.repository) ||
      !SHA.test(policy.implementationMergeSha ?? '') ||
      policy.implementationEvidenceRef !== `https://github.com/${policy.repository}/commit/${policy.implementationMergeSha}`) {
    throw new Error('Active automatic merge policy requires a valid, scoped user-authorization record')
  }
  if (policy.status === 'active' && (policy.revokedAt !== null || policy.revocationEvidenceRef !== null)) {
    throw new Error('Active automatic merge policy cannot contain revocation evidence')
  }
  if (policy.status === 'revoked' && (!isIso(policy.revokedAt) || Date.parse(policy.revokedAt) < Date.parse(policy.activatedAt) ||
      policy.revocationEvidenceRef === null || !evidenceRef(policy.revocationEvidenceRef, policy.repository))) {
    throw new Error('Revoked automatic merge policy requires a valid revocation record')
  }
  return policy
}

function activatePolicy({ policy = defaultPolicy(), authorization, now = new Date() } = {}) {
  validatePolicy(policy, { now })
  if (policy.status !== 'disabled' && policy.status !== 'revoked') {
    throw new Error('Automatic merge policy is already active')
  }
  const required = [
    'repository', 'targetBranch', 'version', 'digest', 'authorizedBy', 'authorizedAt',
    'expiresAt', 'approvalEvidenceRef', 'implementationMergeSha', 'implementationEvidenceRef',
  ]
  if (!exactKeys(authorization, required) || authorization.repository !== POLICY_MANIFEST.repository ||
      authorization.targetBranch !== POLICY_MANIFEST.targetBranch || authorization.version !== POLICY_VERSION ||
      authorization.digest !== POLICY_DIGEST || !isIso(authorization.authorizedAt) ||
      !isIso(authorization.expiresAt) || authorization.authorizedAt !== new Date(now).toISOString() ||
      Date.parse(authorization.expiresAt) <= Date.parse(authorization.authorizedAt) ||
      Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt) > POLICY_MANIFEST.maxAuthorizationDays * 86400000 ||
      typeof authorization.authorizedBy !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9@._+-]{1,79}$/.test(authorization.authorizedBy) ||
      !evidenceRef(authorization.approvalEvidenceRef, authorization.repository) ||
      !SHA.test(authorization.implementationMergeSha ?? '') ||
      authorization.implementationEvidenceRef !== `https://github.com/${authorization.repository}/commit/${authorization.implementationMergeSha}`) {
    throw new Error('Activation requires fresh explicit authorization for this repository, target, and policy digest')
  }
  return Object.freeze({
    status: 'active', version: POLICY_VERSION, digest: POLICY_DIGEST,
    repository: authorization.repository, targetBranch: authorization.targetBranch,
    activatedAt: authorization.authorizedAt, expiresAt: authorization.expiresAt,
    authorizedBy: authorization.authorizedBy, approvalEvidenceRef: authorization.approvalEvidenceRef,
    implementationMergeSha: authorization.implementationMergeSha,
    implementationEvidenceRef: authorization.implementationEvidenceRef,
    revokedAt: null, revocationEvidenceRef: null,
  })
}

function revokePolicy(policy, { revokedAt = new Date().toISOString(), evidenceRef: ref } = {}) {
  validatePolicy(policy, { now: new Date(revokedAt) })
  if (policy.status !== 'active' || !isIso(revokedAt) || Date.parse(revokedAt) < Date.parse(policy.activatedAt) ||
      !evidenceRef(ref, policy.repository)) {
    throw new Error('Only an active policy can be revoked with valid repository evidence')
  }
  return Object.freeze({ ...policy, status: 'revoked', revokedAt, revocationEvidenceRef: ref })
}

function evaluateCandidate({ policy, evidence, now = new Date() } = {}) {
  const blocked = reason => ({ eligible: false, reason })
  try {
    validatePolicy(policy, { now })
    if (policy.status !== 'active') return blocked(policy.status === 'revoked' ? 'policy_revoked' : 'policy_disabled')
    if (Date.parse(policy.expiresAt) <= Date.parse(now)) return blocked('policy_expired')
    const required = [
      'repository', 'targetBranch', 'prNumber', 'prUrl', 'prCreatedAt', 'category', 'riskFindings',
      'changeFlags', 'changedFiles', 'headSha', 'baseSha', 'currentHeadSha', 'currentBaseSha', 'diffSha256',
      'diffEvidenceRef', 'observedAt', 'tests', 'coordinator', 'developer', 'reviewer', 'qa', 'security', 'requiredCheck',
      'reviews', 'protections', 'sideEffects', 'mergeManager',
    ]
    if (!exactKeys(evidence, required)) return blocked('evidence_missing_or_invalid')
    const repository = policy.repository
    const prMatch = typeof evidence.prUrl === 'string' && evidence.prUrl.match(PR_REF)
    if (evidence.repository !== repository || evidence.targetBranch !== policy.targetBranch ||
        !Number.isInteger(evidence.prNumber) || evidence.prNumber < 1 || !prMatch ||
        `${prMatch[1]}/${prMatch[2]}` !== repository || Number(prMatch[3]) !== evidence.prNumber) {
      return blocked('scope_mismatch')
    }
    if (!isIso(evidence.prCreatedAt) || Date.parse(evidence.prCreatedAt) <= Date.parse(policy.activatedAt)) {
      return blocked('pr_predates_policy_activation')
    }
    if (!CATEGORIES.includes(evidence.category) || !Array.isArray(evidence.riskFindings) ||
        evidence.riskFindings.length !== 0 || !Array.isArray(evidence.changeFlags) || evidence.changeFlags.length !== 0) {
      return blocked('high_risk_or_uncertain_change')
    }
    if (hasProtectedPath(evidence.changedFiles)) return blocked('protected_path_changed')
    if (!SHA.test(evidence.headSha ?? '') || !SHA.test(evidence.baseSha ?? '') ||
        evidence.headSha !== evidence.currentHeadSha || evidence.baseSha !== evidence.currentBaseSha ||
        !SHA256.test(evidence.diffSha256 ?? '') ||
        evidence.diffEvidenceRef !== `${evidence.prUrl}/files` && evidence.diffEvidenceRef !== `${evidence.prUrl}.diff`) {
      return blocked('head_base_or_diff_changed')
    }
    if (!isIso(evidence.observedAt) || Date.parse(evidence.observedAt) > Date.parse(now) ||
        Date.parse(now) - Date.parse(evidence.observedAt) > POLICY_MANIFEST.liveEvidenceMaxAgeMs) {
      return blocked('live_evidence_stale')
    }
    if (!exactKeys(evidence.tests, ['passed', 'headSha', 'evidenceRef']) || evidence.tests.passed !== true ||
        evidence.tests.headSha !== evidence.headSha || !evidenceRef(evidence.tests.evidenceRef, repository)) {
      return blocked('tests_unverified')
    }
    const coordinator = evidence.coordinator
    if (!exactKeys(coordinator, ['invocationId', 'headSha', 'evidenceRef']) || coordinator.headSha !== evidence.headSha ||
        typeof coordinator.invocationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(coordinator.invocationId) ||
        !evidenceRef(coordinator.evidenceRef, repository)) return blocked('coordinator_provenance_missing_or_invalid')
    const developer = evidence.developer
    if (!exactKeys(developer, ['invocationId', 'commitSha', 'evidenceRef']) || developer.commitSha !== evidence.headSha ||
        typeof developer.invocationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(developer.invocationId) ||
        !evidenceRef(developer.evidenceRef, repository)) return blocked('developer_provenance_missing_or_invalid')
    for (const role of ['reviewer', 'qa', 'security']) {
      const assessment = evidence[role]
      if (!exactKeys(assessment, ['passed', 'headSha', 'invocationId', 'evidenceRef']) ||
          assessment.passed !== true || assessment.headSha !== evidence.headSha ||
          typeof assessment.invocationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(assessment.invocationId) ||
          !evidenceRef(assessment.evidenceRef, repository)) {
        return blocked(`${role}_assessment_missing_or_failed`)
      }
    }
    const check = evidence.requiredCheck
    if (!exactKeys(check, ['name', 'conclusion', 'headSha', 'baseSha', 'prNumber', 'runUrl', 'completedAt', 'associatedPr']) ||
        check.name !== 'Required PR gate' || check.conclusion !== 'success' || check.headSha !== evidence.headSha ||
        check.baseSha !== evidence.baseSha || check.prNumber !== evidence.prNumber || check.associatedPr !== true ||
        !isIso(check.completedAt) || Date.parse(check.completedAt) > Date.parse(now) ||
        Date.parse(now) - Date.parse(check.completedAt) > POLICY_MANIFEST.liveEvidenceMaxAgeMs ||
        !evidenceRef(check.runUrl, repository) || !check.runUrl.includes(`/actions/runs/`)) {
      return blocked('required_check_unverified')
    }
    if (!exactKeys(evidence.reviews, ['blocking', 'unresolvedMaterialConcern', 'evidenceRef']) ||
        evidence.reviews.blocking !== false || evidence.reviews.unresolvedMaterialConcern !== false ||
        !evidenceRef(evidence.reviews.evidenceRef, repository)) return blocked('review_finding_unresolved')
    if (!exactKeys(evidence.protections, ['verified', 'evidenceRef', 'rulesetRef']) ||
        evidence.protections.verified !== true || !evidenceRef(evidence.protections.evidenceRef, repository) ||
        !evidenceRef(evidence.protections.rulesetRef, repository)) return blocked('protections_unverified')
    if (!exactKeys(evidence.sideEffects, [
      'assessed', 'productionDeployment', 'cloudSpend', 'destructive', 'unexpectedExternalSideEffects', 'evidenceRef',
    ]) || evidence.sideEffects.assessed !== true || evidence.sideEffects.productionDeployment !== false ||
        evidence.sideEffects.cloudSpend !== false || evidence.sideEffects.destructive !== false ||
        evidence.sideEffects.unexpectedExternalSideEffects !== false ||
        !evidenceRef(evidence.sideEffects.evidenceRef, repository)) return blocked('side_effect_risk_or_unknown')
    const manager = evidence.mergeManager
    if (!exactKeys(manager, [
      'passed', 'headSha', 'baseSha', 'diffSha256', 'diffInspected', 'riskClassification', 'invocationId', 'evidenceRef',
    ]) || manager.passed !== true || manager.headSha !== evidence.headSha || manager.baseSha !== evidence.baseSha ||
        manager.diffSha256 !== evidence.diffSha256 || manager.diffInspected !== true ||
        manager.riskClassification !== 'low_risk' ||
        typeof manager.invocationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(manager.invocationId) ||
        !evidenceRef(manager.evidenceRef, repository)) {
      return blocked('merge_manager_review_missing_or_failed')
    }
  } catch {
    return blocked('evidence_invalid')
  }
  return { eligible: true, reason: 'eligible' }
}

module.exports = {
  CATEGORIES, EXCLUDED_RISKS, POLICY_DIGEST, POLICY_MANIFEST, POLICY_VERSION,
  activatePolicy, defaultPolicy, evaluateCandidate, hasProtectedPath, revokePolicy, validatePolicy,
}
