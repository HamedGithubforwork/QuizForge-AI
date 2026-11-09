'use strict'

// Pure policy validation. This module never calls GitHub or performs a merge.
const crypto = require('node:crypto')
const POLICY_VERSION = 'supervised-merge-v1'
const MODES = Object.freeze(['manual', 'supervised_autonomous', 'fully_autonomous'])
const FUTURE_ONLY_MODE = 'fully_autonomous'
const MAX_TASKS = 10
const MAX_RUN_DAYS = 7
const MAX_CI_RUNS = 30
const MAX_LOCAL_BENCHMARK_MINUTES = 240
const CATEGORIES = Object.freeze([
  'local_qwen_performance', 'quiz_generation_correctness', 'ordinary_grading_fix',
  'low_risk_ui', 'test_coverage', 'local_performance_profiling',
])
const OBJECTIVES = Object.freeze([
  'local_qwen_generation', 'quiz_generation_accuracy', 'learner_grading_correctness',
  'frontend_accessibility', 'desktop_reliability', 'application_performance',
  'application_reliability', 'test_coverage',
])
const REQUIRED_SPECIALISTS = Object.freeze({
  local_qwen_performance: ['ai_quality', 'performance'],
  quiz_generation_correctness: ['ai_quality'],
  ordinary_grading_fix: ['ai_quality'],
  low_risk_ui: ['ui_ux'],
  local_performance_profiling: ['performance'],
  test_coverage: [],
})
const EXCLUDED_RISKS = Object.freeze([
  'authentication', 'authorization', 'permissions', 'secrets', 'security_sensitive',
  'database_schema', 'destructive_migration', 'user_data', 'aws_infrastructure',
  'cloud_spending', 'ci_gate', 'branch_protection', 'agent_permissions', 'merge_policy',
  'production_deployment', 'unexpected_external_side_effect', 'out_of_scope', 'uncertain',
])
const EVIDENCE_REF = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:pull\/[1-9][0-9]*(?:\/(?:files|commits|checks|reviews))?|issues\/[1-9][0-9]*|actions\/runs\/[1-9][0-9]*|rulesets\/[1-9][0-9]*|commit\/[a-f0-9]{40})$/
const SHA = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
// A run pins the exact canonical manifest, including a semantic revision string.
// Any rule-logic change must bump POLICY_VERSION or this semantic revision.
const POLICY_DIGEST = crypto.createHash('sha256').update(JSON.stringify({
  version: POLICY_VERSION,
  categories: CATEGORIES,
  objectives: OBJECTIVES,
  requiredSpecialists: REQUIRED_SPECIALISTS,
  excludedRisks: EXCLUDED_RISKS,
  limits: [MAX_TASKS, MAX_RUN_DAYS, MAX_CI_RUNS, MAX_LOCAL_BENCHMARK_MINUTES],
  semantics: 'only-reviewed-low-risk-final-diff;exact-head-required-ci;current-protection;no-side-effects;manager-inspects-diff;monotonic-resource-usage;github-response-required',
})).digest('hex')

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
}

function assertEvidenceRef(reference, repository) {
  if (typeof reference !== 'string' || reference.length > 240 || !EVIDENCE_REF.test(reference) ||
      !reference.startsWith(`https://github.com/${repository}/`)) {
    throw new Error('Evidence must be an allowlisted GitHub PR or issue URL in the authorized repository')
  }
}

function validateRunAuthorization(authorization, { runId, repository, maxCycles, now = new Date() } = {}) {
  const keys = [
    'authorizationId', 'policyVersion', 'repository', 'runId', 'objectives', 'allowedCategories',
    'policyDigest',
    'maxTasks', 'maxCycles', 'resourceBudget', 'authorizedBy', 'authorizedAt', 'expiresAt',
    'approvalEvidenceRef', 'status', 'revokedAt', 'revocationEvidenceRef',
  ]
  if (!object(authorization) || Object.keys(authorization).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(authorization, key)) ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(authorization.authorizationId ?? '') ||
      authorization.policyVersion !== POLICY_VERSION || authorization.policyDigest !== POLICY_DIGEST || authorization.repository !== repository ||
      authorization.runId !== runId || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(authorization.runId ?? '') ||
      !Array.isArray(authorization.objectives) || authorization.objectives.length === 0 ||
      authorization.objectives.some(item => !OBJECTIVES.includes(item)) || new Set(authorization.objectives).size !== authorization.objectives.length ||
      !Array.isArray(authorization.allowedCategories) || authorization.allowedCategories.length === 0 ||
      authorization.allowedCategories.some(item => !CATEGORIES.includes(item)) || new Set(authorization.allowedCategories).size !== authorization.allowedCategories.length ||
      !Number.isInteger(authorization.maxTasks) || authorization.maxTasks < 1 || authorization.maxTasks > MAX_TASKS ||
      !Number.isInteger(authorization.maxCycles) || authorization.maxCycles < 1 || authorization.maxCycles > MAX_TASKS ||
      authorization.maxCycles !== maxCycles || authorization.maxTasks > authorization.maxCycles ||
      !object(authorization.resourceBudget) || Object.keys(authorization.resourceBudget).some(key => !['maxCiRuns', 'maxLocalBenchmarkMinutes', 'paidWorkflowRuns'].includes(key)) ||
      Object.keys(authorization.resourceBudget).length !== 3 ||
      !Number.isInteger(authorization.resourceBudget.maxCiRuns) || authorization.resourceBudget.maxCiRuns < 0 || authorization.resourceBudget.maxCiRuns > MAX_CI_RUNS ||
      !Number.isInteger(authorization.resourceBudget.maxLocalBenchmarkMinutes) || authorization.resourceBudget.maxLocalBenchmarkMinutes < 0 || authorization.resourceBudget.maxLocalBenchmarkMinutes > MAX_LOCAL_BENCHMARK_MINUTES ||
      authorization.resourceBudget.paidWorkflowRuns !== 0 ||
      typeof authorization.authorizedBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{1,79}$/.test(authorization.authorizedBy) ||
      !isoDate(authorization.authorizedAt) || !isoDate(authorization.expiresAt) ||
      Date.parse(authorization.authorizedAt) > Date.parse(now) ||
      Date.parse(authorization.expiresAt) <= Date.parse(authorization.authorizedAt) ||
      Date.parse(authorization.expiresAt) - Date.parse(authorization.authorizedAt) > MAX_RUN_DAYS * 86400000 ||
      !['active', 'revoked'].includes(authorization.status) ||
      (authorization.status === 'active' && (authorization.revokedAt !== null || authorization.revocationEvidenceRef !== null)) ||
      (authorization.status === 'revoked' && (!isoDate(authorization.revokedAt) || authorization.revocationEvidenceRef === null))) {
    throw new Error('Invalid or out-of-scope supervised run authorization')
  }
  assertEvidenceRef(authorization.approvalEvidenceRef, repository)
  if (authorization.revocationEvidenceRef !== null) assertEvidenceRef(authorization.revocationEvidenceRef, repository)
  return authorization
}

function validateEligibilityEvidence(evidence, { authorization, pilotId, maxCycles, cyclesStarted, tasksSelected, now = new Date() } = {}) {
  const keys = [
    'repository', 'runId', 'taskId', 'objective', 'prNumber', 'prUrl', 'prCreatedAt', 'headSha', 'baseSha', 'category',
    'policyDigest',
    'diffSha256', 'diffEvidenceRef', 'impactEvidenceRef', 'riskFindings', 'resourceUsage', 'reviewer', 'qa',
    'specialistAssessments', 'requiredCheck', 'reviews', 'protections', 'sideEffects', 'mergeManager',
  ]
  if (!object(evidence) || Object.keys(evidence).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(evidence, key)) ||
      evidence.repository !== authorization.repository || evidence.runId !== pilotId ||
      evidence.policyDigest !== authorization.policyDigest || evidence.policyDigest !== POLICY_DIGEST ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(evidence.taskId ?? '') ||
      !authorization.objectives.includes(evidence.objective) ||
      !Number.isInteger(evidence.prNumber) || evidence.prNumber < 1 ||
      evidence.prUrl !== `https://github.com/${evidence.repository}/pull/${evidence.prNumber}` ||
      !isoDate(evidence.prCreatedAt) || Date.parse(evidence.prCreatedAt) < Date.parse(authorization.authorizedAt) ||
      !SHA.test(evidence.headSha ?? '') || !SHA.test(evidence.baseSha ?? '') ||
      !authorization.allowedCategories.includes(evidence.category) ||
      !SHA256.test(evidence.diffSha256 ?? '') || !Array.isArray(evidence.riskFindings) ||
      evidence.riskFindings.some(risk => !EXCLUDED_RISKS.includes(risk)) ||
      new Set(evidence.riskFindings).size !== evidence.riskFindings.length ||
      !Number.isInteger(cyclesStarted) || cyclesStarted < 0 || cyclesStarted > authorization.maxCycles ||
      cyclesStarted > maxCycles || maxCycles !== authorization.maxCycles ||
      !Number.isInteger(tasksSelected) || tasksSelected < 0 || tasksSelected > authorization.maxTasks) {
    throw new Error('Invalid or out-of-scope supervised merge evidence')
  }
  if (typeof evidence.diffEvidenceRef !== 'string' ||
      !new RegExp(`^https://github\\.com/${escapeRegex(evidence.repository)}/pull/${evidence.prNumber}(?:/files|\\.diff)$`).test(evidence.diffEvidenceRef)) {
    throw new Error('Final diff evidence must identify the exact PR files or diff view')
  }
  assertEvidenceRef(evidence.impactEvidenceRef, evidence.repository)
  if (evidence.riskFindings.length > 0) throw new Error('High-risk findings always exclude supervised merging')
  const usage = evidence.resourceUsage
  if (!object(usage) || Object.keys(usage).some(key => !['ciRunsUsed', 'localBenchmarkMinutesUsed', 'paidWorkflowRuns', 'evidenceRef'].includes(key)) ||
      !Number.isSafeInteger(usage.ciRunsUsed) || usage.ciRunsUsed < 0 ||
      !Number.isFinite(usage.localBenchmarkMinutesUsed) || usage.localBenchmarkMinutesUsed < 0 ||
      usage.paidWorkflowRuns !== 0 || usage.ciRunsUsed > authorization.resourceBudget.maxCiRuns ||
      usage.localBenchmarkMinutesUsed > authorization.resourceBudget.maxLocalBenchmarkMinutes) {
    throw new Error('Resource usage is missing, paid, or exceeds the authorized run budget')
  }
  assertEvidenceRef(usage.evidenceRef, evidence.repository)

  for (const role of ['reviewer', 'qa']) {
    const assessment = evidence[role]
    if (!object(assessment) || Object.keys(assessment).some(key => !['passed', 'commitSha', 'evidenceRef'].includes(key)) ||
        assessment.passed !== true || assessment.commitSha !== evidence.headSha) {
      throw new Error(`A passing exact-head ${role} assessment is required`)
    }
    assertEvidenceRef(assessment.evidenceRef, evidence.repository)
  }
  if (!Array.isArray(evidence.specialistAssessments) || evidence.specialistAssessments.length > 6 ||
      evidence.specialistAssessments.some(item => !object(item) ||
        Object.keys(item).some(key => !['role', 'status', 'commitSha', 'evidenceRef'].includes(key)) ||
        !['security', 'ai_quality', 'performance', 'release_reliability', 'ui_ux', 'data_integrity'].includes(item.role) ||
        !['passed', 'not_required'].includes(item.status) || item.commitSha !== evidence.headSha)) {
    throw new Error('Relevant specialist assessments must be recorded against the exact PR head')
  }
  for (const assessment of evidence.specialistAssessments) assertEvidenceRef(assessment.evidenceRef, evidence.repository)
  for (const role of REQUIRED_SPECIALISTS[evidence.category]) {
    if (!evidence.specialistAssessments.some(item => item.role === role && item.status === 'passed')) {
      throw new Error(`A passing ${role} assessment is required for this change category`)
    }
  }

  const check = evidence.requiredCheck
  if (!object(check) || Object.keys(check).some(key => !['name', 'conclusion', 'headSha', 'baseSha', 'prNumber', 'runUrl'].includes(key)) ||
      check.name !== 'Required PR gate' || check.conclusion !== 'success' || check.headSha !== evidence.headSha ||
      check.baseSha !== evidence.baseSha || check.prNumber !== evidence.prNumber ||
      typeof check.runUrl !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/.test(check.runUrl)) {
    throw new Error('Required PR gate must pass for the exact head and base and be associated with this PR')
  }
  if (!object(evidence.reviews) || Object.keys(evidence.reviews).some(key => !['blocking', 'evidenceRef'].includes(key)) ||
      evidence.reviews.blocking !== false) throw new Error('Blocking review findings exclude supervised merging')
  assertEvidenceRef(evidence.reviews.evidenceRef, evidence.repository)
  if (!object(evidence.protections) || Object.keys(evidence.protections).some(key => !['verified', 'evidenceRef', 'rulesetRef'].includes(key)) ||
      evidence.protections.verified !== true) throw new Error('Current branch-protection evidence is required')
  assertEvidenceRef(evidence.protections.evidenceRef, evidence.repository)
  assertEvidenceRef(evidence.protections.rulesetRef, evidence.repository)
  if (!object(evidence.sideEffects) || Object.keys(evidence.sideEffects).some(key => ![
    'assessed', 'evidenceRef', 'productionDeployment', 'cloudSpend', 'destructive', 'unexpectedExternalSideEffects',
  ].includes(key)) || evidence.sideEffects.assessed !== true || evidence.sideEffects.productionDeployment !== false ||
      evidence.sideEffects.cloudSpend !== false || evidence.sideEffects.destructive !== false ||
      evidence.sideEffects.unexpectedExternalSideEffects !== false) {
    throw new Error('Deployment, spending, destructive, or unexpected external effects exclude supervised merging')
  }
  assertEvidenceRef(evidence.sideEffects.evidenceRef, evidence.repository)
  if (!object(evidence.mergeManager) || Object.keys(evidence.mergeManager).some(key => ![
    'passed', 'headSha', 'baseSha', 'diffSha256', 'diffInspected', 'evidenceRef',
  ].includes(key)) ||
      evidence.mergeManager.passed !== true || evidence.mergeManager.headSha !== evidence.headSha ||
      evidence.mergeManager.baseSha !== evidence.baseSha || evidence.mergeManager.diffSha256 !== evidence.diffSha256 ||
      evidence.mergeManager.diffInspected !== true) throw new Error('Merge Manager must independently inspect the final diff and current exact PR state')
  assertEvidenceRef(evidence.mergeManager.evidenceRef, evidence.repository)
  if (Date.parse(authorization.expiresAt) <= Date.parse(now)) throw new Error('Supervised run authorization has expired')
  return evidence
}

function evaluateSupervisedMerge({ mode, authorization, evidence, pilotId, maxCycles, cyclesStarted, tasksSelected, now = new Date() }) {
  if (!MODES.includes(mode)) return { eligible: false, reason: 'mode_invalid' }
  if (mode === 'manual') return { eligible: false, reason: 'manual_mode' }
  if (mode === FUTURE_ONLY_MODE) return { eligible: false, reason: 'fully_autonomous_disabled' }
  try {
    validateRunAuthorization(authorization, {
      runId: pilotId, repository: evidence?.repository, maxCycles, now,
    })
    if (authorization.status !== 'active') return { eligible: false, reason: 'authorization_revoked' }
    if (Date.parse(authorization.expiresAt) <= Date.parse(now)) return { eligible: false, reason: 'authorization_expired' }
    validateEligibilityEvidence(evidence, { authorization, pilotId, maxCycles, cyclesStarted, tasksSelected, now })
  } catch (error) {
    return { eligible: false, reason: classifyEligibilityError(error.message), message: error.message }
  }
  return { eligible: true, reason: 'eligible' }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function classifyEligibilityError(message) {
  if (/resource usage|budget/i.test(message)) return 'budget_exhausted'
  if (/expired/i.test(message)) return 'authorization_expired'
  if (/scope|out-of-scope|authorized repository|supervised run authorization/i.test(message)) return 'authorization_scope_mismatch'
  if (/high-risk|effect|deployment|spending|destructive|unexpected/i.test(message)) return 'high_risk_change'
  if (/protection/i.test(message)) return 'protection_unverified'
  if (/Required PR gate/i.test(message)) return 'required_check_unverified'
  if (/reviewer|qa/i.test(message)) return 'independent_assessment_missing'
  return 'evidence_invalid'
}

module.exports = {
  CATEGORIES, EXCLUDED_RISKS, MAX_TASKS, MODES, OBJECTIVES, POLICY_DIGEST, POLICY_VERSION, REQUIRED_SPECIALISTS,
  evaluateSupervisedMerge, validateEligibilityEvidence, validateRunAuthorization,
}
