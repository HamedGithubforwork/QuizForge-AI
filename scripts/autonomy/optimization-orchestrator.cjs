'use strict'

// Safe, deterministic state manager for Coordinator-led optimization cycles.
// This tool records work and chooses tasks; it never executes task commands,
// calls models, writes GitHub, commits, merges, deploys, or provisions resources.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const {
  CATEGORIES: MERGE_CATEGORIES,
  EXCLUDED_RISKS,
  OBJECTIVES: MERGE_OBJECTIVES,
  MODES: MERGE_MODES,
  POLICY_DIGEST: MERGE_POLICY_DIGEST,
  evaluateSupervisedMerge,
  validateEligibilityEvidence,
  validateRunAuthorization,
} = require('./supervised-merge-policy.cjs')

const SCHEMA_VERSION = 2
const MAX_CYCLES = 10
const MAX_EVENTS = 500
const EVENT_ARCHIVE_CHUNK = 250
const MAX_PILOT_SUMMARIES = 25
const PILOT_SUMMARY_ARCHIVE_CHUNK = 25
const MAX_RECOVERY_CASES = 10
const MAX_RECOVERY_ATTEMPTS = 2
const MAX_PRESERVATION_ARCHIVE_BYTES = 128 * 1024
const MAX_PRESERVED_SNAPSHOTS = MAX_RECOVERY_CASES
const MAX_PRESERVATION_ARCHIVES = MAX_RECOVERY_CASES
const MALFORMED_LOCK_RECOVERY_MS = 24 * 60 * 60 * 1000
const DOMAINS = Object.freeze([
  'local_ai', 'backend', 'frontend', 'desktop_ui', 'reliability',
  'security', 'performance', 'ci_efficiency',
])
const TASK_STATUSES = Object.freeze([
  'ready', 'selected', 'awaiting_approval', 'baseline_established', 'implementing', 'implemented',
  'tests_passed', 'reviewed', 'qa_passed', 'quality_security_passed',
  'validated', 'rejected', 'blocked',
])
const BLOCKERS = Object.freeze([
  'unavailable_evidence', 'tooling_unavailable', 'existing_pr',
  'benchmark_expensive', 'external_dependency', 'needs_user_authorization',
  'environment_failure', 'snapshot_history_full', 'other',
])
const RECOVERY_STRATEGIES = Object.freeze([
  'dependency_repair', 'configuration_repair', 'platform_adjustment',
  'ci_verification', 'alternative_tooling', 'other',
])
const RECOVERY_DIAGNOSIS_CODES = Object.freeze([
  'missing_dependency', 'environment_incompatible', 'configuration_invalid',
  'evidence_insufficient', 'upstream_unavailable', 'benchmark_over_budget',
  'existing_change_conflict', 'other',
])
const NON_RECOVERABLE_REASON_CODES = Object.freeze([
  'unsafe_operation', 'approval_required', 'resource_unavailable',
  'evidence_unavailable', 'external_dependency', 'other',
])
const REFERENCES = Object.freeze([
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[1-9][0-9]*$/,
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]{40}$/,
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/,
  /^docs\/[A-Za-z0-9_./-]+\.(?:md|json|ya?ml|txt)$/,
  /^(?:backend|frontend|desktop|scripts|\.github)\/[A-Za-z0-9_./-]+$/,
])
const ASSESSMENT_ROLES = Object.freeze(['reviewer', 'qa', 'quality', 'security'])
const AUDIT_DIMENSIONS = Object.freeze([
  'performance', 'memory', 'cpu', 'code_quality', 'security', 'reliability', 'backend',
  'local_ai', 'quiz_generation', 'grading', 'frontend_ux', 'desktop_ux', 'tests', 'gha_efficiency',
])
const AUDIT_ROLES = Object.freeze([
  'reviewer', 'qa', 'security_privacy_engineer', 'ai_quality_engineer',
  'performance_efficiency_engineer', 'ui_ux_engineer', 'release_reliability_engineer',
  'data_integrity_engineer',
])
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{1,79}$/
const INVOCATION_REFERENCE_PATTERN = /^\/?[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/

const DEFAULT_STATE_PATH = path.resolve(__dirname, '../../docs/autonomy/optimization-state.json')
const REPOSITORY_ROOT = path.resolve(__dirname, '../..')

function now() {
  return new Date().toISOString()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function onlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key))
}

function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now(),
    domains: [...DOMAINS],
    tasks: [],
    checkpoint: {
      pilotId: null,
      maxCycles: MAX_CYCLES,
      cyclesStarted: 0,
      cyclesValidated: 0,
      revision: 0,
      selectedTaskId: null,
      previousTaskId: null,
      preparedPilot: null,
      pilotHistory: [],
      archivedPilotHistory: [],
      eventArchives: [],
      optimizationGate: {
        status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
        stopReason: null, finalReport: null, auditHistory: [],
      },
      mergeMode: 'manual',
      mergeAuthorization: null,
      events: [],
    },
  }
}

function assertReference(reference) {
  if (typeof reference !== 'string' || reference.length > 240 ||
      !REFERENCES.some(pattern => pattern.test(reference))) {
    throw new Error('Invalid evidence reference; use an allowlisted GitHub URL or repository path')
  }
  return reference
}

function assertInvocationReference(reference) {
  if (typeof reference !== 'string' || !INVOCATION_REFERENCE_PATTERN.test(reference) ||
      reference.includes('..') || reference.includes('//') || /[\r\n]/.test(reference)) {
    throw new Error('Invalid actual agent invocation reference')
  }
}

function isValidAssessmentRecord(assessments) {
  if (!assessments || typeof assessments !== 'object' || Array.isArray(assessments) ||
      Object.keys(assessments).some(role => !ASSESSMENT_ROLES.includes(role))) return false
  try {
    for (const assessment of Object.values(assessments)) {
      if (assessment === null) continue
      const legacyKeys = ['passed', 'evidenceRef']
      const tracedKeys = [...legacyKeys, 'invocationRef', 'targetCommitSha']
      if ((!onlyKeys(assessment, legacyKeys) && !onlyKeys(assessment, tracedKeys)) ||
          typeof assessment.passed !== 'boolean') return false
      assertReference(assessment.evidenceRef)
      if (assessment.invocationRef !== undefined || assessment.targetCommitSha !== undefined) {
        assertInvocationReference(assessment.invocationRef)
        if (!/^[a-f0-9]{40}$/.test(assessment.targetCommitSha ?? '')) return false
      }
    }
  } catch {
    return false
  }
  return true
}

function validateTask(task) {
  const idPattern = /^[a-z0-9][a-z0-9-]{1,63}$/
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      !idPattern.test(task.id ?? '') || !DOMAINS.includes(task.domain) ||
      typeof task.title !== 'string' || task.title.length < 3 || task.title.length > 140 ||
      /[\r\n<>`]/.test(task.title) ||
      !Number.isInteger(task.impact) || task.impact < 1 || task.impact > 5 ||
      !Number.isInteger(task.effort) || task.effort < 1 || task.effort > 5 ||
      !Number.isInteger(task.risk) || task.risk < 1 || task.risk > 5 ||
      !Array.isArray(task.dependencies) ||
      task.dependencies.some(id => !idPattern.test(id)) ||
      !Array.isArray(task.evidenceRefs) || task.evidenceRefs.length > 12 ||
      !Array.isArray(task.testRefs) || task.testRefs.length > 12 ||
      !Array.isArray(task.benchmarkRefs) || task.benchmarkRefs.length > 12 ||
      (task.benchmarkCost !== undefined && !['local', 'expensive'].includes(task.benchmarkCost)) ||
      (task.benchmarkDirection !== undefined &&
        !['lower_is_better', 'higher_is_better'].includes(task.benchmarkDirection)) ||
      (task.metricName !== undefined &&
        (typeof task.metricName !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(task.metricName))) ||
      (task.investigationKey !== undefined && !idPattern.test(task.investigationKey)) ||
      (task.evidenceRevision !== undefined &&
        (!Number.isSafeInteger(task.evidenceRevision) || task.evidenceRevision < 0)) ||
      (task.priorBlockerEvidenceRevision !== undefined && task.priorBlockerEvidenceRevision !== null &&
        (!Number.isSafeInteger(task.priorBlockerEvidenceRevision) || task.priorBlockerEvidenceRevision < 0)) ||
      (task.recoveryHistory !== undefined && (!Array.isArray(task.recoveryHistory) ||
        task.recoveryHistory.length > MAX_RECOVERY_CASES))) {
    throw new Error('Task must match the structured optimization-task schema')
  }
  for (const ref of [...task.evidenceRefs, ...task.testRefs, ...task.benchmarkRefs]) {
    assertReference(ref)
  }
  if (task.dependencies.includes(task.id) || new Set(task.dependencies).size !== task.dependencies.length) {
    throw new Error('Task dependencies must be unique and cannot include the task itself')
  }
  if (task.status !== undefined && !TASK_STATUSES.includes(task.status)) {
    throw new Error('Invalid task status')
  }
  if (task.initialStatus !== undefined && !TASK_STATUSES.includes(task.initialStatus)) {
    throw new Error('Invalid immutable initial task status')
  }
  if (task.baseline !== undefined && task.baseline !== null) {
    if (!onlyKeys(task.baseline, ['metric', 'evidenceRef']) || !Number.isFinite(task.baseline.metric)) {
      throw new Error('Invalid baseline record')
    }
    assertReference(task.baseline.evidenceRef)
  }
  if (task.implementation !== undefined && task.implementation !== null) {
    if (!onlyKeys(task.implementation, ['branch', 'commitSha']) ||
        !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(task.implementation.branch ?? '') ||
        !/^[a-f0-9]{40}$/.test(task.implementation.commitSha ?? '')) {
      throw new Error('Invalid implementation record')
    }
  }
  if (task.testResult !== undefined && task.testResult !== null) {
    if (!onlyKeys(task.testResult, ['passed', 'evidenceRef']) || typeof task.testResult.passed !== 'boolean') {
      throw new Error('Invalid test result record')
    }
    assertReference(task.testResult.evidenceRef)
  }
  if (task.assessments !== undefined) {
    if (!task.assessments || typeof task.assessments !== 'object' || Array.isArray(task.assessments) ||
        Object.keys(task.assessments).some(role => !ASSESSMENT_ROLES.includes(role))) {
      throw new Error('Invalid assessment record')
    }
    for (const role of ASSESSMENT_ROLES) {
      const assessment = task.assessments[role]
      if (assessment !== undefined && assessment !== null) {
        const legacyKeys = ['passed', 'evidenceRef']
        const tracedKeys = [...legacyKeys, 'invocationRef', 'targetCommitSha']
        if ((!onlyKeys(assessment, legacyKeys) && !onlyKeys(assessment, tracedKeys)) ||
            typeof assessment.passed !== 'boolean') {
          throw new Error('Invalid role assessment result')
        }
        assertReference(assessment.evidenceRef)
        if (assessment.invocationRef !== undefined || assessment.targetCommitSha !== undefined) {
          assertInvocationReference(assessment.invocationRef)
          if (!/^[a-f0-9]{40}$/.test(assessment.targetCommitSha ?? '')) {
            throw new Error('Assessment invocation requires the exact target commit SHA')
          }
        }
      }
    }
  }
  if (task.assessmentProvenanceLegacy !== undefined &&
      (task.assessmentProvenanceLegacy !== true || task.status !== 'validated')) {
    throw new Error('Legacy assessment provenance is allowed only for previously validated records')
  }
  if (task.blocker !== undefined && task.blocker !== null) {
    if (!onlyKeys(task.blocker, ['code', 'evidenceRef', 'evidenceRevision', 'recordedAt']) ||
        !BLOCKERS.includes(task.blocker.code) ||
        !Number.isSafeInteger(task.blocker.evidenceRevision) || task.blocker.evidenceRevision < 0 ||
        typeof task.blocker.recordedAt !== 'string') throw new Error('Invalid blocker record')
    if (task.blocker.evidenceRef !== null) assertReference(task.blocker.evidenceRef)
  }
  const recoveryHistory = task.recoveryHistory ?? []
  const recoveryReferences = new Set()
  for (const recoveryCase of recoveryHistory) {
    validateRecoveryCase(task, recoveryCase)
    for (const reference of recoveryEvidenceReferences([recoveryCase])) {
      if (recoveryReferences.has(reference)) {
        throw new Error('Recovery evidence references must be unique across the task history')
      }
      recoveryReferences.add(reference)
    }
  }
  if (task.validation !== undefined && task.validation !== null) {
    const acceptedKeys = ['accepted', 'baselineMetric', 'resultMetric', 'regression', 'evidenceRef']
    const rejectedKeys = ['accepted', 'reasonCode', 'evidenceRef']
    if (task.validation.accepted === false) {
      if (!onlyKeys(task.validation, rejectedKeys) ||
          typeof task.validation.reasonCode !== 'string' || task.validation.reasonCode.length > 48) {
        throw new Error('Invalid rejection record')
      }
      if (task.validation.evidenceRef !== null) assertReference(task.validation.evidenceRef)
    } else {
      if (!onlyKeys(task.validation, acceptedKeys) ||
          task.validation.accepted !== true ||
          !Number.isFinite(task.validation.baselineMetric) ||
          !Number.isFinite(task.validation.resultMetric) ||
          typeof task.validation.regression !== 'boolean') throw new Error('Invalid benchmark record')
      assertReference(task.validation.evidenceRef)
    }
  }
  if (task.workPreserved !== undefined && task.workPreserved !== null) {
    const workPreservedKeys = ['baseline', 'implementation', 'testResult', 'assessments', 'validation', 'priorSnapshots']
    if (!onlyKeys(task.workPreserved, workPreservedKeys)) {
      throw new Error('Invalid preserved-work record')
    }
    const { priorSnapshots, ...currentSnapshot } = task.workPreserved
    validatePreservedSnapshot(currentSnapshot)
    if (priorSnapshots !== undefined && (!Array.isArray(priorSnapshots) ||
        priorSnapshots.length > MAX_PRESERVED_SNAPSHOTS)) {
      throw new Error('Preserved lifecycle snapshot history exceeds its bounded limit')
    }
    for (const snapshot of priorSnapshots ?? []) {
      validatePreservedSnapshot(snapshot)
    }
  }
  if (task.preservationDeferral !== undefined && task.preservationDeferral !== null) {
    const deferred = task.preservationDeferral
    if (!onlyKeys(deferred, ['reasonCode', 'lifecycleSnapshot', 'recordedAt']) ||
        deferred.reasonCode !== 'snapshot_history_full' ||
        typeof deferred.recordedAt !== 'string' || Number.isNaN(Date.parse(deferred.recordedAt))) {
      throw new Error('Invalid preservation deferral record')
    }
    validatePreservedSnapshot(deferred.lifecycleSnapshot)
    if (task.status !== 'blocked' || task.blocker?.code !== deferred.reasonCode) {
      throw new Error('Preservation deferrals must remain blocked until archived')
    }
    if (task.workPreserved?.priorSnapshots?.length !== MAX_PRESERVED_SNAPSHOTS) {
      throw new Error('Preservation deferral requires a full prior snapshot history')
    }
    let overflowRequired = false
    try {
      mergeWorkPreserved(task, deferred.lifecycleSnapshot)
    } catch (error) {
      if (!error.message.includes('bounded work history is full')) throw error
      overflowRequired = true
    }
    if (!overflowRequired) {
      throw new Error('Preservation deferral snapshot must exceed the bounded work-history capacity')
    }
  }
  const preservationArchiveRefs = task.preservationArchiveRefs ?? []
  if (!Array.isArray(preservationArchiveRefs) || preservationArchiveRefs.length > MAX_PRESERVATION_ARCHIVES ||
      new Set(preservationArchiveRefs).size !== preservationArchiveRefs.length) {
    throw new Error('Invalid or excessive lifecycle archive references')
  }
  preservationArchiveRefs.forEach(assertReference)
  for (const archiveReference of preservationArchiveRefs) {
    const digest = archiveReference.match(/^docs\/autonomy\/archives\/[a-z0-9][a-z0-9-]{1,63}-([a-f0-9]{64})\.json$/)?.[1]
    if (!digest || archiveReference !== preservationArchiveReference(task.id, digest)) {
      throw new Error('Preserved lifecycle archives must use task-scoped SHA-256 paths')
    }
  }
  return {
    id: task.id,
    domain: task.domain,
    title: task.title,
    impact: task.impact,
    effort: task.effort,
    risk: task.risk,
    dependencies: [...task.dependencies],
    evidenceRefs: [...task.evidenceRefs],
    testRefs: [...task.testRefs],
    benchmarkRefs: [...task.benchmarkRefs],
    benchmarkCost: task.benchmarkCost === 'expensive' ? 'expensive' : 'local',
    benchmarkDirection: task.benchmarkDirection ?? 'lower_is_better',
    metricName: task.metricName ?? task.id,
    status: task.status ?? 'ready',
    initialStatus: task.initialStatus ?? task.status ?? 'ready',
    investigationKey: task.investigationKey ?? task.id,
    baseline: task.baseline ?? null,
    implementation: task.implementation ?? null,
    testResult: task.testResult ?? null,
    assessments: task.assessments ?? Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null])),
    ...(task.assessmentProvenanceLegacy === true ? { assessmentProvenanceLegacy: true } : {}),
    validation: task.validation ?? null,
    blocker: task.blocker ?? null,
    workPreserved: task.workPreserved ?? null,
    preservationDeferral: task.preservationDeferral ?? null,
    preservationArchiveRefs: [...preservationArchiveRefs],
    evidenceRevision: Number.isSafeInteger(task.evidenceRevision) ? task.evidenceRevision : 0,
    priorBlockerEvidenceRevision: Number.isSafeInteger(task.priorBlockerEvidenceRevision)
      ? task.priorBlockerEvidenceRevision : null,
    recoveryHistory: clone(recoveryHistory),
  }
}

function validatePreservedSnapshot(snapshot) {
  if (!onlyKeys(snapshot, ['baseline', 'implementation', 'testResult', 'assessments', 'validation'])) {
    throw new Error('Invalid preserved lifecycle snapshot')
  }
  if (snapshot.baseline !== null) {
    const baseline = snapshot.baseline
    if (!onlyKeys(baseline, ['metric', 'evidenceRef']) || !Number.isFinite(baseline.metric)) {
      throw new Error('Invalid preserved baseline')
    }
    assertReference(baseline.evidenceRef)
  }
  if (snapshot.implementation !== null) {
    const implementation = snapshot.implementation
    if (!onlyKeys(implementation, ['branch', 'commitSha']) ||
        !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(implementation.branch ?? '') ||
        !/^[a-f0-9]{40}$/.test(implementation.commitSha ?? '')) {
      throw new Error('Invalid preserved implementation')
    }
  }
  if (snapshot.testResult !== undefined && snapshot.testResult !== null) {
    if (!onlyKeys(snapshot.testResult, ['passed', 'evidenceRef']) ||
        typeof snapshot.testResult.passed !== 'boolean') throw new Error('Invalid preserved test result')
    assertReference(snapshot.testResult.evidenceRef)
  }
  if (!onlyKeys(snapshot.assessments, ASSESSMENT_ROLES)) {
    throw new Error('Invalid preserved assessment or validation record')
  }
  for (const assessment of Object.values(snapshot.assessments)) {
    const legacyKeys = ['passed', 'evidenceRef']
    const tracedKeys = [...legacyKeys, 'invocationRef', 'targetCommitSha']
    if (assessment !== null &&
        ((!onlyKeys(assessment, legacyKeys) && !onlyKeys(assessment, tracedKeys)) ||
          typeof assessment.passed !== 'boolean')) {
      throw new Error('Invalid preserved assessment or validation record')
    }
    if (assessment !== null) {
      assertReference(assessment.evidenceRef)
      if (assessment.invocationRef !== undefined || assessment.targetCommitSha !== undefined) {
        assertInvocationReference(assessment.invocationRef)
        if (!/^[a-f0-9]{40}$/.test(assessment.targetCommitSha ?? '')) {
          throw new Error('Preserved assessment invocation requires the exact target commit SHA')
        }
      }
    }
  }
  if (snapshot.validation !== null && snapshot.validation !== undefined) {
    const rejectedKeys = ['accepted', 'reasonCode', 'evidenceRef']
    const acceptedKeys = ['accepted', 'baselineMetric', 'resultMetric', 'regression', 'evidenceRef']
    if (snapshot.validation.accepted === false) {
      if (!onlyKeys(snapshot.validation, rejectedKeys) || typeof snapshot.validation.reasonCode !== 'string' ||
          snapshot.validation.reasonCode.length > 48) {
        throw new Error('Invalid preserved assessment or validation record')
      }
      if (snapshot.validation.evidenceRef !== null) assertReference(snapshot.validation.evidenceRef)
    } else if (!onlyKeys(snapshot.validation, acceptedKeys) || snapshot.validation.accepted !== true ||
        !Number.isFinite(snapshot.validation.baselineMetric) || !Number.isFinite(snapshot.validation.resultMetric) ||
        typeof snapshot.validation.regression !== 'boolean') {
      throw new Error('Invalid preserved assessment or validation record')
    } else {
      assertReference(snapshot.validation.evidenceRef)
    }
  }
}

function validateRecoveryCase(task, recoveryCase) {
  if (!onlyKeys(recoveryCase, ['diagnosis', 'attempts', 'outcome']) ||
      !recoveryCase.diagnosis || !onlyKeys(recoveryCase.diagnosis, [
        'diagnosisCode', 'investigatorEvidenceRef', 'originalCheckRef', 'recoverable',
        'blockerCode', 'nonRecoverableReasonCode', 'recordedAt',
      ]) || !RECOVERY_DIAGNOSIS_CODES.includes(recoveryCase.diagnosis.diagnosisCode) ||
      typeof recoveryCase.diagnosis.recoverable !== 'boolean' ||
      !BLOCKERS.includes(recoveryCase.diagnosis.blockerCode) ||
      typeof recoveryCase.diagnosis.recordedAt !== 'string' ||
      Number.isNaN(Date.parse(recoveryCase.diagnosis.recordedAt)) ||
      !Array.isArray(recoveryCase.attempts) || recoveryCase.attempts.length > MAX_RECOVERY_ATTEMPTS ||
      !['in_progress', 'recovered', 'blocked'].includes(recoveryCase.outcome)) {
    throw new Error('Invalid recovery diagnosis record')
  }
  assertReference(recoveryCase.diagnosis.investigatorEvidenceRef)
  assertReference(recoveryCase.diagnosis.originalCheckRef)
  if (![...task.testRefs, ...task.benchmarkRefs].includes(recoveryCase.diagnosis.originalCheckRef)) {
    throw new Error('Recovery diagnosis must name an allowlisted original check')
  }
  if (recoveryCase.diagnosis.recoverable) {
    if (recoveryCase.diagnosis.nonRecoverableReasonCode !== undefined) {
      throw new Error('Recoverable diagnosis cannot contain a non-recoverable reason code')
    }
  } else if (!NON_RECOVERABLE_REASON_CODES.includes(recoveryCase.diagnosis.nonRecoverableReasonCode) ||
      recoveryCase.attempts.length !== 0 ||
      recoveryCase.outcome !== 'blocked') {
    throw new Error('Non-recoverable diagnoses require an allowlisted reason code and cannot have recovery attempts')
  }
  const strategies = new Set()
  const attemptEvidence = new Set([recoveryCase.diagnosis.investigatorEvidenceRef])
  for (const attempt of recoveryCase.attempts) {
    if (!onlyKeys(attempt, [
      'strategy', 'evidenceRef', 'checkRef', 'verificationRef', 'result', 'recordedAt',
    ]) || !RECOVERY_STRATEGIES.includes(attempt.strategy) ||
        !['passed', 'failed'].includes(attempt.result) ||
        typeof attempt.recordedAt !== 'string' || Number.isNaN(Date.parse(attempt.recordedAt)) ||
        attempt.checkRef !== recoveryCase.diagnosis.originalCheckRef || strategies.has(attempt.strategy)) {
      throw new Error('Invalid or unverifiable recovery attempt')
    }
    assertReference(attempt.evidenceRef)
    assertReference(attempt.checkRef)
    assertReference(attempt.verificationRef)
    if (attempt.evidenceRef === attempt.verificationRef || attemptEvidence.has(attempt.evidenceRef) ||
        attemptEvidence.has(attempt.verificationRef)) {
      throw new Error('Recovery attempts require distinct evidence and verification references')
    }
    strategies.add(attempt.strategy)
    attemptEvidence.add(attempt.evidenceRef)
    attemptEvidence.add(attempt.verificationRef)
  }
  if (recoveryCase.diagnosis.recoverable && recoveryCase.outcome === 'recovered' &&
      (recoveryCase.attempts.length === 0 || recoveryCase.attempts.at(-1).result !== 'passed')) {
    throw new Error('Recovery cannot be marked successful without the original check passing')
  }
  if (recoveryCase.diagnosis.recoverable && recoveryCase.outcome === 'blocked' &&
      (recoveryCase.attempts.length !== MAX_RECOVERY_ATTEMPTS ||
        recoveryCase.attempts.some(attempt => attempt.result !== 'failed'))) {
    throw new Error('A recoverable task can be blocked only after two failed recovery attempts')
  }
  if (recoveryCase.diagnosis.recoverable && recoveryCase.outcome === 'in_progress' &&
      (recoveryCase.attempts.length >= MAX_RECOVERY_ATTEMPTS ||
        recoveryCase.attempts.some(attempt => attempt.result === 'passed'))) {
    throw new Error('Recovery case outcome does not match its attempts')
  }
}

function recoveryEvidenceReferences(recoveryHistory) {
  return new Set(recoveryHistory.flatMap(recoveryCase => [
    recoveryCase.diagnosis.investigatorEvidenceRef,
    ...recoveryCase.attempts.flatMap(attempt => [attempt.evidenceRef, attempt.verificationRef]),
  ]))
}

function validatePreparedPilot(prepared) {
  if (!onlyKeys(prepared, ['pilotId', 'maxCycles', 'preparedAt']) ||
      !/^[a-z0-9][a-z0-9-]{1,40}$/.test(prepared.pilotId ?? '') ||
      prepared.maxCycles !== MAX_CYCLES || typeof prepared.preparedAt !== 'string' ||
      Number.isNaN(Date.parse(prepared.preparedAt))) {
    throw new Error('Prepared pilot must have a unique ID and ten-task budget')
  }
}

function validatePilotStartAuthorization(attestation, prepared) {
  if (!onlyKeys(attestation, [
    'pilotId', 'maxCycles', 'approverIdentity', 'approvalEvidenceRef', 'mergeMode', 'mergeAuthorization',
  ]) || attestation.pilotId !== prepared.pilotId || attestation.maxCycles !== prepared.maxCycles ||
      typeof attestation.approverIdentity !== 'string' || !IDENTITY_PATTERN.test(attestation.approverIdentity)) {
    throw new Error('Pilot start authorization must explicitly match the prepared pilot ID and cycle budget')
  }
  const mergeMode = attestation.mergeMode ?? 'manual'
  if (!MERGE_MODES.includes(mergeMode) || mergeMode === 'fully_autonomous') {
    throw new Error('Fully Autonomous mode is future-only and cannot be activated')
  }
  assertReference(attestation.approvalEvidenceRef)
  const normalized = {
    pilotId: attestation.pilotId,
    maxCycles: attestation.maxCycles,
    approverIdentity: attestation.approverIdentity,
    approvalEvidenceRef: attestation.approvalEvidenceRef,
  }
  if (mergeMode === 'supervised_autonomous') {
    validateRunAuthorization(attestation.mergeAuthorization, {
      runId: prepared.pilotId,
      repository: attestation.mergeAuthorization?.repository,
      maxCycles: prepared.maxCycles,
    })
    if (attestation.mergeAuthorization.authorizedBy !== attestation.approverIdentity) {
      throw new Error('The Coordinator-verified start claim must match the run authorization identity')
    }
    normalized.mergeMode = mergeMode
    normalized.mergeAuthorization = clone(attestation.mergeAuthorization)
  } else if (attestation.mergeAuthorization !== undefined) {
    throw new Error('Manual mode cannot carry a supervised merge authorization')
  }
  return normalized
}

function mergeEvidenceUrl(reference, repository) {
  return typeof reference === 'string' && reference.length <= 320 &&
    reference.startsWith(`https://github.com/${repository}/`) &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull\/[1-9][0-9]*(?:\/files|\.diff)?|issues\/[1-9][0-9]*|commit\/[a-f0-9]{40}|actions\/runs\/[1-9][0-9]*|rulesets\/[0-9]+)$/.test(reference)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digestCandidate(evidence, outcome, reason) {
  return crypto.createHash('sha256').update(canonicalJson({ evidence, outcome, reason })).digest('hex')
}

function candidateEvidence(record) {
  return Object.fromEntries([
    'repository', 'runId', 'taskId', 'objective', 'policyDigest', 'prNumber', 'prUrl', 'prCreatedAt', 'headSha',
    'baseSha', 'category', 'diffSha256', 'diffEvidenceRef', 'impactEvidenceRef', 'riskFindings',
    'resourceUsage', 'reviewer', 'qa', 'specialistAssessments', 'requiredCheck', 'reviews',
    'protections', 'sideEffects', 'mergeManager',
  ].map(key => [key, record[key]]))
}

function validateMergeDecisionRecord(record, eventPilotId, authorization, cyclesStarted, tasksSelected, selectedInRun) {
  const keys = [
    'authorizationId', 'policyVersion', 'policyDigest', 'repository', 'runId', 'taskId', 'objective', 'prNumber',
    'prUrl', 'prCreatedAt', 'headSha', 'baseSha', 'category', 'diffSha256', 'diffEvidenceRef', 'impactEvidenceRef',
    'riskFindings', 'resourceUsage', 'outcome', 'reasonCode', 'decisionDigest', 'reviewer', 'qa', 'specialistAssessments',
    'requiredCheck', 'reviews', 'protections', 'sideEffects', 'mergeManager', 'decidedAt', 'evidenceRefs',
  ]
  if (!onlyKeys(record, keys) || keys.some(key => !Object.hasOwn(record, key)) ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(record.authorizationId ?? '') ||
      record.policyVersion !== 'supervised-merge-v1' || record.policyDigest !== MERGE_POLICY_DIGEST ||
      record.policyDigest !== authorization?.policyDigest || record.authorizationId !== authorization?.authorizationId ||
      typeof record.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
      !/^[a-z0-9][a-z0-9-]{1,40}$/.test(record.runId ?? '') ||
      record.runId !== eventPilotId ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(record.taskId ?? '') ||
      (record.prNumber !== null && (!Number.isInteger(record.prNumber) || record.prNumber < 1)) ||
      (record.prNumber === null ? record.prUrl !== null : record.prUrl !== `https://github.com/${record.repository}/pull/${record.prNumber}`) ||
      (record.prCreatedAt !== null && (typeof record.prCreatedAt !== 'string' || Number.isNaN(Date.parse(record.prCreatedAt)))) ||
      (record.headSha !== null && !/^[a-f0-9]{40}$/.test(record.headSha)) ||
      (record.baseSha !== null && !/^[a-f0-9]{40}$/.test(record.baseSha)) ||
      !['eligible', 'rejected'].includes(record.outcome) ||
      !['eligible', 'manual_mode', 'fully_autonomous_disabled', 'authorization_expired',
        'authorization_revoked', 'authorization_scope_mismatch', 'high_risk_change',
        'protection_unverified', 'required_check_unverified', 'independent_assessment_missing',
        'evidence_invalid', 'budget_exhausted'].includes(record.reasonCode) ||
      typeof record.decidedAt !== 'string' || Number.isNaN(Date.parse(record.decidedAt)) ||
      !/^[a-f0-9]{64}$/.test(record.decisionDigest ?? '') ||
      !Array.isArray(record.riskFindings) || !Array.isArray(record.specialistAssessments) ||
      !Array.isArray(record.evidenceRefs) || record.evidenceRefs.length > 24) {
    throw new Error('Invalid supervised merge decision audit record')
  }
  if (record.decisionDigest !== digestCandidate(candidateEvidence(record), record.outcome, record.reasonCode)) {
    throw new Error('Supervised merge decision digest does not match its persisted evidence')
  }
  if (record.resourceUsage !== null && (!onlyKeys(record.resourceUsage,
    ['ciRunsUsed', 'localBenchmarkMinutesUsed', 'paidWorkflowRuns', 'evidenceRef']) ||
      !Number.isSafeInteger(record.resourceUsage.ciRunsUsed) || record.resourceUsage.ciRunsUsed < 0 ||
      !Number.isFinite(record.resourceUsage.localBenchmarkMinutesUsed) || record.resourceUsage.localBenchmarkMinutesUsed < 0 ||
      !Number.isSafeInteger(record.resourceUsage.paidWorkflowRuns) || record.resourceUsage.paidWorkflowRuns < 0)) {
    throw new Error('Invalid supervised merge resource usage record')
  }
  if (record.resourceUsage?.evidenceRef) assertReference(record.resourceUsage.evidenceRef)
  if (record.diffEvidenceRef !== null && !mergeEvidenceUrl(record.diffEvidenceRef, record.repository)) {
    throw new Error('Invalid final diff evidence reference')
  }
  if (record.impactEvidenceRef !== null) assertReference(record.impactEvidenceRef)
  record.evidenceRefs.forEach(assertReference)
  if (record.outcome === 'eligible' && (record.reasonCode !== 'eligible' ||
      record.riskFindings.length !== 0 || record.reviewer?.passed !== true || record.qa?.passed !== true ||
      record.requiredCheck?.conclusion !== 'success' || record.protections?.verified !== true ||
      record.sideEffects?.unexpectedExternalSideEffects !== false || record.mergeManager?.passed !== true ||
      !record.resourceUsage || record.resourceUsage.paidWorkflowRuns !== 0 ||
      typeof record.category !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(record.category) ||
      !/^[a-f0-9]{64}$/.test(record.diffSha256 ?? '') || !/^[a-f0-9]{40}$/.test(record.headSha ?? '') ||
      !/^[a-f0-9]{40}$/.test(record.baseSha ?? ''))) {
    throw new Error('Eligible merge audit lacks required independent evidence')
  }
  if (record.outcome === 'eligible') {
    if (!selectedInRun) throw new Error('Eligible merge decisions must belong to a task selected in the authorized run')
    const evidence = candidateEvidence(record)
    validateEligibilityEvidence(evidence, {
      authorization, pilotId: eventPilotId, maxCycles: authorization.maxCycles,
      cyclesStarted, tasksSelected, now: new Date(record.decidedAt),
    })
  }
}

function validateMergeResultRecord(record) {
  const keys = [
    'authorizationId', 'decisionDigest', 'repository', 'runId', 'taskId', 'prNumber', 'headSha', 'baseSha',
    'mergeCommitSha', 'mergeEvidenceRef', 'mergedAt', 'githubMessage',
  ]
  if (!onlyKeys(record, keys) || keys.some(key => !Object.hasOwn(record, key)) ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(record.authorizationId ?? '') ||
      typeof record.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
      !/^[a-z0-9][a-z0-9-]{1,40}$/.test(record.runId ?? '') ||
      !/^[a-f0-9]{64}$/.test(record.decisionDigest ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(record.taskId ?? '') ||
      !Number.isInteger(record.prNumber) || record.prNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(record.headSha ?? '') || !/^[a-f0-9]{40}$/.test(record.baseSha ?? '') ||
      !/^[a-f0-9]{40}$/.test(record.mergeCommitSha ?? '') ||
      record.mergeEvidenceRef !== `https://github.com/${record.repository}/commit/${record.mergeCommitSha}` ||
      typeof record.mergedAt !== 'string' || Number.isNaN(Date.parse(record.mergedAt)) ||
      typeof record.githubMessage !== 'string' || record.githubMessage.length < 1 || record.githubMessage.length > 160 ||
      /[\r\n<>]/.test(record.githubMessage)) {
    throw new Error('Invalid structured GitHub merge response record')
  }
}

function sanitizeMergeDecisionRecord(state, input, result, decisionDigest) {
  const authorization = state.checkpoint.mergeAuthorization
  const repo = typeof input.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)
    ? input.repository : authorization.repository
  const number = Number.isInteger(input.prNumber) && input.prNumber > 0 ? input.prNumber : null
  const safeRef = ref => mergeEvidenceUrl(ref, repo) ? ref : null
  const assessment = value => ({
    passed: typeof value?.passed === 'boolean' ? value.passed : null,
    commitSha: /^[a-f0-9]{40}$/.test(value?.commitSha ?? '') ? value.commitSha : null,
    evidenceRef: safeRef(value?.evidenceRef),
  })
  const specialistAssessments = Array.isArray(input.specialistAssessments)
    ? input.specialistAssessments.filter(item => item && [
      'security', 'ai_quality', 'performance', 'release_reliability', 'ui_ux', 'data_integrity',
    ].includes(item.role)).slice(0, 6).map(item => ({
      role: item.role,
      status: ['passed', 'not_required'].includes(item.status) ? item.status : 'not_required',
      commitSha: /^[a-f0-9]{40}$/.test(item.commitSha ?? '') ? item.commitSha : null,
      evidenceRef: safeRef(item.evidenceRef),
    })) : []
  const check = input.requiredCheck
  const reviews = input.reviews
  const protections = input.protections
  const sideEffects = input.sideEffects
  const manager = input.mergeManager
  const usage = input.resourceUsage
  const usageRefIsSafe = (() => { try { assertReference(usage?.evidenceRef); return true } catch { return false } })()
  const resourceUsage = usage && Number.isSafeInteger(usage.ciRunsUsed) && usage.ciRunsUsed >= 0 &&
    Number.isFinite(usage.localBenchmarkMinutesUsed) && usage.localBenchmarkMinutesUsed >= 0 &&
    Number.isSafeInteger(usage.paidWorkflowRuns) && usage.paidWorkflowRuns >= 0 && usageRefIsSafe
    ? { ciRunsUsed: usage.ciRunsUsed, localBenchmarkMinutesUsed: usage.localBenchmarkMinutesUsed,
      paidWorkflowRuns: usage.paidWorkflowRuns, evidenceRef: usage.evidenceRef }
    : null
  const refs = [input.diffEvidenceRef, input.impactEvidenceRef, input.reviewer?.evidenceRef, input.qa?.evidenceRef,
    ...specialistAssessments.map(item => item.evidenceRef), resourceUsage?.evidenceRef, check?.runUrl, reviews?.evidenceRef,
    protections?.evidenceRef, protections?.rulesetRef, sideEffects?.evidenceRef, manager?.evidenceRef]
    .filter(ref => {
      try { assertReference(ref); return true } catch { return false }
    }).slice(0, 24)
  const riskFindings = Array.isArray(input.riskFindings)
    ? input.riskFindings.map(item => EXCLUDED_RISKS.includes(item) ? item : 'uncertain').slice(0, 24)
    : []
  return {
    authorizationId: authorization.authorizationId,
    policyVersion: authorization.policyVersion,
    policyDigest: authorization.policyDigest,
    repository: repo,
    runId: state.checkpoint.pilotId,
    taskId: input.taskId,
    objective: MERGE_OBJECTIVES.includes(input.objective) ? input.objective : null,
    prNumber: number,
    prUrl: number === null ? null : `https://github.com/${repo}/pull/${number}`,
    prCreatedAt: typeof input.prCreatedAt === 'string' && !Number.isNaN(Date.parse(input.prCreatedAt))
      ? input.prCreatedAt : null,
    headSha: /^[a-f0-9]{40}$/.test(input.headSha ?? '') ? input.headSha : null,
    baseSha: /^[a-f0-9]{40}$/.test(input.baseSha ?? '') ? input.baseSha : null,
    category: MERGE_CATEGORIES.includes(input.category) ? input.category : null,
    diffSha256: /^[a-f0-9]{64}$/.test(input.diffSha256 ?? '') ? input.diffSha256 : null,
    diffEvidenceRef: safeRef(input.diffEvidenceRef),
    impactEvidenceRef: safeRef(input.impactEvidenceRef),
    riskFindings,
    decisionDigest,
    resourceUsage,
    outcome: result.eligible ? 'eligible' : 'rejected',
    reasonCode: result.reason,
    reviewer: assessment(input.reviewer),
    qa: assessment(input.qa),
    specialistAssessments,
    requiredCheck: check && typeof check === 'object' ? {
      name: check.name === 'Required PR gate' ? check.name : null,
      conclusion: ['success', 'failure', 'cancelled', 'skipped', 'pending'].includes(check.conclusion) ? check.conclusion : null,
      headSha: /^[a-f0-9]{40}$/.test(check.headSha ?? '') ? check.headSha : null,
      baseSha: /^[a-f0-9]{40}$/.test(check.baseSha ?? '') ? check.baseSha : null,
      prNumber: Number.isInteger(check.prNumber) ? check.prNumber : null,
      runUrl: safeRef(check.runUrl),
    } : null,
    reviews: reviews && typeof reviews === 'object' ? {
      blocking: typeof reviews.blocking === 'boolean' ? reviews.blocking : null,
      evidenceRef: safeRef(reviews.evidenceRef),
    } : null,
    protections: protections && typeof protections === 'object' ? {
      verified: typeof protections.verified === 'boolean' ? protections.verified : null,
      evidenceRef: safeRef(protections.evidenceRef),
      rulesetRef: safeRef(protections.rulesetRef),
    } : null,
    sideEffects: sideEffects && typeof sideEffects === 'object' ? {
      assessed: typeof sideEffects.assessed === 'boolean' ? sideEffects.assessed : null,
      productionDeployment: typeof sideEffects.productionDeployment === 'boolean' ? sideEffects.productionDeployment : null,
      cloudSpend: typeof sideEffects.cloudSpend === 'boolean' ? sideEffects.cloudSpend : null,
      destructive: typeof sideEffects.destructive === 'boolean' ? sideEffects.destructive : null,
      unexpectedExternalSideEffects: typeof sideEffects.unexpectedExternalSideEffects === 'boolean' ? sideEffects.unexpectedExternalSideEffects : null,
      evidenceRef: safeRef(sideEffects.evidenceRef),
    } : null,
    mergeManager: manager && typeof manager === 'object' ? {
      passed: typeof manager.passed === 'boolean' ? manager.passed : null,
      headSha: /^[a-f0-9]{40}$/.test(manager.headSha ?? '') ? manager.headSha : null,
      baseSha: /^[a-f0-9]{40}$/.test(manager.baseSha ?? '') ? manager.baseSha : null,
      diffSha256: /^[a-f0-9]{64}$/.test(manager.diffSha256 ?? '') ? manager.diffSha256 : null,
      diffInspected: typeof manager.diffInspected === 'boolean' ? manager.diffInspected : null,
      evidenceRef: safeRef(manager.evidenceRef),
    } : null,
    decidedAt: now(),
    evidenceRefs: refs,
  }
}

function hasActionableRestartEvidence(checkpoint, tasks) {
  const priorExhaustion = checkpoint.optimizationGate.auditHistory.at(-1)
  if (priorExhaustion?.auditStatus !== 'OPTIMIZATION_EXHAUSTED') return false
  return checkpoint.events.some(event => {
    if (event.type !== 'optimization_resumed' || event.reasonCode !== 'new_actionable_task' || !event.taskId ||
        Date.parse(event.at) <= Date.parse(priorExhaustion.recordedAt)) return false
    const task = tasks.find(item => item.id === event.taskId)
    return task && ['ready', 'selected', 'baseline_established', 'implementing', 'implemented',
      'tests_passed', 'reviewed', 'qa_passed', 'quality_security_passed'].includes(task.status)
  })
}

function validatePilotSummary(summary) {
  if (!onlyKeys(summary, [
    'pilotId', 'maxCycles', 'cyclesStarted', 'cyclesValidated', 'gateStatus',
    'stopReason', 'startedAt', 'completedAt',
  ]) || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(summary.pilotId ?? '') ||
      !Number.isInteger(summary.maxCycles) || summary.maxCycles < 1 || summary.maxCycles > MAX_CYCLES ||
      !Number.isInteger(summary.cyclesStarted) || summary.cyclesStarted < 0 ||
      summary.cyclesStarted > summary.maxCycles || !Number.isInteger(summary.cyclesValidated) ||
      summary.cyclesValidated < 0 || summary.cyclesValidated > summary.cyclesStarted ||
      !['ACTIVE', 'BLOCKED', 'STOPPED', 'OPTIMIZATION_EXHAUSTED'].includes(summary.gateStatus) ||
      (summary.stopReason !== null && !['budget', 'security', 'correctness', 'approval'].includes(summary.stopReason)) ||
      (summary.startedAt !== null && (typeof summary.startedAt !== 'string' || Number.isNaN(Date.parse(summary.startedAt)))) ||
      typeof summary.completedAt !== 'string' || Number.isNaN(Date.parse(summary.completedAt))) {
    throw new Error('Invalid prior pilot summary')
  }
}

function validateState(state) {
  if (state?.schemaVersion === 1 && Array.isArray(state.tasks)) {
    // Preserve completed historical results without inventing invocation IDs.
    // In-progress, untraceable reviews remain in the event history, but the
    // task returns to tests_passed so reviewers must assess the current commit.
    for (const task of state.tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue
      if (task.assessments !== undefined && !isValidAssessmentRecord(task.assessments)) continue
      const hasUntraceableAssessment = Object.values(task.assessments ?? {})
        .some(assessment => assessment && !assessment.invocationRef)
      if (task.status === 'validated') {
        task.assessmentProvenanceLegacy = true
      } else if (hasUntraceableAssessment &&
          ['reviewed', 'qa_passed', 'quality_security_passed'].includes(task.status)) {
        task.status = 'tests_passed'
        task.assessments = Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null]))
        task.validation = null
      } else if (hasUntraceableAssessment && !['blocked', 'rejected'].includes(task.status)) {
        task.assessments = Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null]))
      }
    }
    state.schemaVersion = SCHEMA_VERSION
  }
  if (!state || state.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(state.domains) || state.domains.length !== DOMAINS.length ||
      DOMAINS.some(domain => !state.domains.includes(domain)) ||
      !Array.isArray(state.tasks) || !state.checkpoint ||
      !Array.isArray(state.checkpoint.events) || state.checkpoint.events.length > MAX_EVENTS ||
      !Number.isInteger(state.checkpoint.maxCycles) || state.checkpoint.maxCycles < 1 ||
      state.checkpoint.maxCycles > MAX_CYCLES ||
      !Number.isInteger(state.checkpoint.cyclesStarted) || state.checkpoint.cyclesStarted < 0 ||
      state.checkpoint.cyclesStarted > state.checkpoint.maxCycles ||
      !Number.isInteger(state.checkpoint.cyclesValidated) || state.checkpoint.cyclesValidated < 0 ||
      state.checkpoint.cyclesValidated > state.checkpoint.cyclesStarted) {
    throw new Error('Invalid optimization state file')
  }
  const checkpoint = state.checkpoint
  checkpoint.revision ??= 0
  checkpoint.preparedPilot ??= null
  checkpoint.pilotHistory ??= []
  checkpoint.archivedPilotHistory ??= []
  checkpoint.eventArchives ??= []
  checkpoint.mergeMode ??= 'manual'
  checkpoint.mergeAuthorization ??= null
  if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0 ||
      !onlyKeys(checkpoint, [
        'pilotId', 'maxCycles', 'cyclesStarted', 'cyclesValidated', 'revision',
        'selectedTaskId', 'previousTaskId', 'preparedPilot', 'pilotHistory',
        'archivedPilotHistory', 'eventArchives', 'optimizationGate', 'mergeMode',
        'mergeAuthorization', 'events',
      ])) {
    throw new Error('Invalid optimization checkpoint revision or fields')
  }
  if (!Array.isArray(checkpoint.pilotHistory) || checkpoint.pilotHistory.length > MAX_PILOT_SUMMARIES ||
      !Array.isArray(checkpoint.archivedPilotHistory) ||
      checkpoint.archivedPilotHistory.some(chunk => !Array.isArray(chunk) ||
        chunk.length === 0 || chunk.length > PILOT_SUMMARY_ARCHIVE_CHUNK) ||
      !Array.isArray(checkpoint.eventArchives) ||
      checkpoint.eventArchives.some(chunk => !Array.isArray(chunk) || chunk.length === 0 || chunk.length > MAX_EVENTS)) {
    throw new Error('Invalid archived pilot or event history')
  }
  for (const summary of [...checkpoint.archivedPilotHistory.flat(), ...checkpoint.pilotHistory]) {
    validatePilotSummary(summary)
  }
  if (checkpoint.preparedPilot !== null) validatePreparedPilot(checkpoint.preparedPilot)
  if (!MERGE_MODES.includes(checkpoint.mergeMode) || checkpoint.mergeMode === 'fully_autonomous' ||
      (checkpoint.mergeMode === 'manual' && checkpoint.mergeAuthorization !== null) ||
      (checkpoint.mergeMode === 'supervised_autonomous' && (!checkpoint.pilotId || !checkpoint.mergeAuthorization))) {
    throw new Error('Invalid or inactive merge operating mode')
  }
  if (checkpoint.mergeAuthorization !== null) {
    validateRunAuthorization(checkpoint.mergeAuthorization, {
      runId: checkpoint.pilotId,
      repository: checkpoint.mergeAuthorization.repository,
      maxCycles: checkpoint.maxCycles,
    })
  }
  const seenPilotIds = new Set()
  for (const summary of [...checkpoint.archivedPilotHistory.flat(), ...checkpoint.pilotHistory]) {
    if (seenPilotIds.has(summary.pilotId)) throw new Error('Duplicate pilot history ID')
    seenPilotIds.add(summary.pilotId)
  }
  if (checkpoint.pilotId && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(checkpoint.pilotId)) {
    throw new Error('Invalid active pilot ID')
  }
  if (checkpoint.preparedPilot && (checkpoint.preparedPilot.pilotId === checkpoint.pilotId ||
      seenPilotIds.has(checkpoint.preparedPilot.pilotId))) {
    throw new Error('Prepared pilot ID must be unique across checkpoint history')
  }
  if (state.checkpoint.optimizationGate === undefined) {
    state.checkpoint.optimizationGate = {
      status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
      stopReason: null, finalReport: null,
    }
  }
  const gate = state.checkpoint.optimizationGate
  if (gate.lastAuditedDimensions === undefined) gate.lastAuditedDimensions = []
  if (gate.stopReason === undefined) gate.stopReason = null
  if (gate.finalReport === undefined) gate.finalReport = null
  if (gate.auditHistory === undefined) gate.auditHistory = []
  if (!onlyKeys(gate, ['status', 'consecutiveCleanAudits', 'lastAuditRefs', 'lastAuditedDimensions', 'stopReason', 'finalReport', 'auditHistory']) ||
      !['ACTIVE', 'BLOCKED', 'STOPPED', 'OPTIMIZATION_EXHAUSTED'].includes(gate.status) ||
      !Number.isInteger(gate.consecutiveCleanAudits) || gate.consecutiveCleanAudits < 0 ||
      !Array.isArray(gate.lastAuditRefs) || gate.lastAuditRefs.length > 12 ||
      !Array.isArray(gate.lastAuditedDimensions) ||
      gate.lastAuditedDimensions.some(d => !AUDIT_DIMENSIONS.includes(d)) ||
      !Array.isArray(gate.auditHistory) || gate.auditHistory.length > 100 ||
      (gate.status === 'OPTIMIZATION_EXHAUSTED' &&
       (gate.consecutiveCleanAudits < 2 || AUDIT_DIMENSIONS.some(d => !gate.lastAuditedDimensions.includes(d)))) ||
      (gate.status === 'STOPPED' && !['budget', 'security', 'correctness'].includes(gate.stopReason)) ||
      (gate.status === 'BLOCKED' && gate.stopReason !== null && gate.stopReason !== 'approval') ||
      (gate.status !== 'STOPPED' && gate.status !== 'BLOCKED' && gate.stopReason !== null) ||
      (gate.status === 'OPTIMIZATION_EXHAUSTED' && !validFinalReport(gate.finalReport)) ||
      (gate.status !== 'OPTIMIZATION_EXHAUSTED' && gate.finalReport !== null)) {
    throw new Error('Invalid optimization exhaustion gate')
  }
  gate.lastAuditRefs.forEach(assertReference)
  validateAuditHistory(gate.auditHistory)
  if (gate.status === 'OPTIMIZATION_EXHAUSTED' && !hasTwoCleanAudits(gate.auditHistory)) {
    throw new Error('Exhaustion requires two persisted complete clean audits')
  }
  const seen = new Set()
  const investigations = new Set()
  for (const task of state.tasks) {
    const normalizedTask = validateTask(task)
    const recognized = Object.keys(normalizedTask)
    if (Object.keys(task).some(key => !recognized.includes(key))) {
      throw new Error(`Stored task ${task.id ?? '(unknown)'} contains unrecognized or noncanonical fields`)
    }
    // Missing metricName/testResult are migrated in memory for older checkpoints.
    Object.assign(task, normalizedTask)
    validateLifecycle(task)
    if (seen.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
    if (investigations.has(task.investigationKey)) {
      throw new Error(`Duplicate investigation key: ${task.investigationKey}`)
    }
    seen.add(task.id)
    investigations.add(task.investigationKey)
  }
  if (checkpoint.preparedPilot) {
    const initialPilot = !checkpoint.pilotId && checkpoint.pilotHistory.length === 0 &&
      checkpoint.archivedPilotHistory.length === 0 && checkpoint.cyclesStarted === 0 &&
      ![...checkpoint.eventArchives.flat(), ...checkpoint.events]
        .some(event => event.type === 'pilot_started')
    const mayPrepare = initialPilot || (checkpoint.pilotId && checkpoint.selectedTaskId === null && (
      (gate.status === 'STOPPED' && gate.stopReason === 'budget') ||
      (gate.status === 'ACTIVE' && hasActionableRestartEvidence(checkpoint, state.tasks))
    ))
    if (!mayPrepare) throw new Error('Pending pilot lacks a valid terminal or independently reopened checkpoint')
  }
  const eventTypes = new Set([
    'pilot_started', 'pilot_prepared', 'task_discovered', 'selected', 'baseline', 'implemented',
    'tests_passed', 'reviewer_passed', 'qa_passed', 'quality_passed', 'security_passed',
    'tests_failed', 'recovery_diagnosed', 'recovery_attempted', 'recovery_recovered',
    'preservation_archived',
    'validated', 'rejected', 'blocked', 'new_evidence', 'approval_recorded', 'optimization_resumed',
    'audit_completed', 'gate_stopped', 'stop_released', 'supervised_merge_revoked',
    'supervised_merge_decision', 'supervised_merge_completed', 'supervised_task_limit_reached',
  ])
  const eventKeys = [
    'at', 'type', 'pilotId', 'maxCycles', 'taskId', 'cycle', 'domain', 'metric',
    'evidenceRef', 'branch', 'commitSha', 'invocationRef', 'assessmentCommitSha', 'reasonCode', 'blockerCode',
    'evidenceRevision', 'resultMetric', 'recoveryCaseIndex', 'recoveryStrategy', 'recoveryResult',
    'initialStatus',
    'auditStatus', 'consecutiveCleanAudits', 'actionableCount', 'blockedCount', 'auditedDimensions', 'specialistRoles',
    'auditId', 'auditEvidenceRefs', 'specialistAssessments', 'awaitingApprovalCount',
    'approverIdentity', 'approverRole', 'approvalEvidenceRef', 'authorizedScopeRef', 'scopeCommitSha',
    'remediationEvidenceRef', 'approvals', 'pilotStartAuthorization',
    'archivedSnapshotCount', 'mergeRecord',
  ]
  const allEvents = [...checkpoint.eventArchives.flat(), ...checkpoint.events]
  const authorizationByPilot = new Map(allEvents.filter(event => event.type === 'pilot_started' &&
    event.pilotStartAuthorization?.mergeAuthorization).map(event => [
    event.pilotId, event.pilotStartAuthorization.mergeAuthorization,
  ]))
  const preparedPilotIds = new Set(allEvents.filter(event => event.type === 'pilot_prepared').map(event => event.pilotId))
  for (let eventIndex = 0; eventIndex < allEvents.length; eventIndex += 1) {
    const event = allEvents[eventIndex]
    if (!onlyKeys(event, eventKeys) || !eventTypes.has(event.type) ||
        typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) {
      throw new Error('Invalid checkpoint event')
    }
    if (event.taskId && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(event.taskId)) {
      throw new Error('Invalid task ID in checkpoint event')
    }
    if (event.pilotId !== undefined && event.pilotId !== null &&
        !/^[a-z0-9][a-z0-9-]{1,40}$/.test(event.pilotId)) {
      throw new Error('Invalid pilot ID in checkpoint event')
    }
    if (event.type === 'pilot_prepared' &&
        (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(event.pilotId ?? '') || event.maxCycles !== MAX_CYCLES)) {
      throw new Error('Prepared pilot event must carry the unique ten-task pilot configuration')
    }
    if (event.pilotStartAuthorization !== undefined) {
      if (event.type !== 'pilot_started') throw new Error('Pilot start authorization is only valid on a pilot start event')
      validatePilotStartAuthorization(event.pilotStartAuthorization, {
        pilotId: event.pilotId, maxCycles: event.maxCycles,
      })
    }
    if (event.type === 'supervised_merge_revoked') {
      if (!onlyKeys(event.mergeRecord, ['authorizationId', 'evidenceRef', 'revokedAt']) ||
          !/^[a-z0-9][a-z0-9-]{2,63}$/.test(event.mergeRecord.authorizationId ?? '') ||
          typeof event.mergeRecord.revokedAt !== 'string' || Number.isNaN(Date.parse(event.mergeRecord.revokedAt))) {
        throw new Error('Invalid supervised merge revocation record')
      }
      assertReference(event.mergeRecord.evidenceRef)
    } else if (event.type === 'supervised_merge_decision') {
      const priorSelections = allEvents.slice(0, eventIndex).filter(candidate => candidate.type === 'selected' &&
        candidate.pilotId === event.pilotId)
      if (event.taskId !== event.mergeRecord?.taskId) throw new Error('Supervised decision event task must match its audit record')
      const latestImplementation = allEvents.slice(0, eventIndex).findLast(candidate => candidate.type === 'implemented' &&
        candidate.pilotId === event.pilotId && candidate.taskId === event.taskId)
      if (event.mergeRecord?.outcome === 'eligible' && latestImplementation?.commitSha !== event.mergeRecord.headSha) {
        throw new Error('Eligible merge decision must match the selected task implementation commit')
      }
      validateMergeDecisionRecord(event.mergeRecord, event.pilotId,
        authorizationByPilot.get(event.pilotId), priorSelections.length,
        new Set(priorSelections.map(candidate => candidate.taskId)).size,
        priorSelections.some(candidate => candidate.taskId === event.taskId))
    } else if (event.type === 'supervised_merge_completed') {
      validateMergeResultRecord(event.mergeRecord)
      if (event.taskId !== event.mergeRecord?.taskId) throw new Error('Supervised merge result event task must match its audit record')
      const authorization = authorizationByPilot.get(event.pilotId)
      const priorDecisions = allEvents.slice(0, eventIndex).filter(candidate =>
        candidate.type === 'supervised_merge_decision' && candidate.pilotId === event.pilotId &&
        candidate.taskId === event.taskId && candidate.mergeRecord.prNumber === event.mergeRecord.prNumber)
      const latestDecision = priorDecisions.at(-1)
      const revocation = allEvents.find(candidate => candidate.type === 'supervised_merge_revoked' &&
        candidate.pilotId === event.pilotId && candidate.mergeRecord.authorizationId === event.mergeRecord.authorizationId)
      const mergedAt = Date.parse(event.mergeRecord.mergedAt)
      if (!authorization || authorization.authorizationId !== event.mergeRecord.authorizationId ||
          !latestDecision || latestDecision.mergeRecord.outcome !== 'eligible' ||
          latestDecision.mergeRecord.decisionDigest !== event.mergeRecord.decisionDigest ||
          latestDecision.mergeRecord.headSha !== event.mergeRecord.headSha ||
          latestDecision.mergeRecord.baseSha !== event.mergeRecord.baseSha ||
          mergedAt <= Date.parse(latestDecision.at) || mergedAt > Date.parse(authorization.expiresAt) ||
          mergedAt > Date.parse(event.at) || (revocation && mergedAt >= Date.parse(revocation.mergeRecord.revokedAt))) {
        throw new Error('Historical merge result must follow its latest eligible decision and precede expiry, revocation, and checkpoint recording')
      }
    } else if (event.type === 'supervised_task_limit_reached') {
      if (!onlyKeys(event.mergeRecord, ['authorizationId', 'maxTasks', 'tasksSelected']) ||
          !/^[a-z0-9][a-z0-9-]{2,63}$/.test(event.mergeRecord.authorizationId ?? '') ||
          !Number.isInteger(event.mergeRecord.maxTasks) || event.mergeRecord.maxTasks < 1 ||
          !Number.isInteger(event.mergeRecord.tasksSelected) || event.mergeRecord.tasksSelected !== event.mergeRecord.maxTasks) {
        throw new Error('Invalid supervised task authorization limit record')
      }
    } else if (event.mergeRecord !== undefined) {
      throw new Error('Merge audit record is only valid on supervised merge events')
    }
    if (event.type === 'pilot_started' && preparedPilotIds.has(event.pilotId) &&
        event.pilotStartAuthorization === undefined) {
      throw new Error('A prepared pilot start event must preserve its scoped authorization attestation')
    }
    if (event.type === 'recovery_diagnosed' &&
        (!Number.isSafeInteger(event.recoveryCaseIndex) || event.recoveryCaseIndex < 0)) {
      throw new Error('Recovery diagnosis event requires a case index')
    }
    if (event.type === 'recovery_attempted' &&
        (!Number.isSafeInteger(event.recoveryCaseIndex) || event.recoveryCaseIndex < 0 ||
          !RECOVERY_STRATEGIES.includes(event.recoveryStrategy) ||
          !['passed', 'failed'].includes(event.recoveryResult))) {
      throw new Error('Recovery attempt event is invalid')
    }
    if (event.type === 'preservation_archived' &&
        (!event.taskId || !Number.isSafeInteger(event.archivedSnapshotCount) || event.archivedSnapshotCount < 1 ||
          !/^docs\/autonomy\/archives\/[a-z0-9][a-z0-9-]{1,63}-[a-f0-9]{64}\.json$/.test(event.evidenceRef ?? '') ||
          event.evidenceRef !== preservationArchiveReference(
            event.taskId, event.evidenceRef.match(/-([a-f0-9]{64})\.json$/)?.[1]))) {
      throw new Error('Lifecycle archive event requires task and snapshot count')
    }
    if (event.initialStatus !== undefined && (event.type !== 'task_discovered' ||
        !['ready', 'awaiting_approval'].includes(event.initialStatus))) {
      throw new Error('Invalid initial task status in discovery event')
    }
    if (event.domain && !DOMAINS.includes(event.domain)) throw new Error('Invalid domain in checkpoint event')
    if (event.blockerCode && !BLOCKERS.includes(event.blockerCode)) throw new Error('Invalid blocker in checkpoint event')
    if (event.evidenceRef) assertReference(event.evidenceRef)
    if (event.invocationRef !== undefined || event.assessmentCommitSha !== undefined) {
      assertInvocationReference(event.invocationRef)
      if (!/^[a-f0-9]{40}$/.test(event.assessmentCommitSha ?? '') ||
          !['reviewer_passed', 'qa_passed', 'quality_passed', 'security_passed',
            'reviewer_rejected', 'qa_rejected', 'quality_rejected', 'security_rejected'].includes(event.type)) {
        throw new Error('Assessment event invocation provenance is invalid')
      }
    }
    if (event.reviewerEvidenceRef) assertReference(event.reviewerEvidenceRef)
    if (event.qaEvidenceRef) assertReference(event.qaEvidenceRef)
    if (event.securityEvidenceRef) assertReference(event.securityEvidenceRef)
    if (event.aiQualityEvidenceRef) assertReference(event.aiQualityEvidenceRef)
    if (event.approvalEvidenceRef) assertReference(event.approvalEvidenceRef)
    if (event.authorizedScopeRef) assertReference(event.authorizedScopeRef)
    if (event.remediationEvidenceRef) assertReference(event.remediationEvidenceRef)
    if (event.branch && !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(event.branch)) {
      throw new Error('Invalid branch in checkpoint event')
    }
    if (event.commitSha && !/^[a-f0-9]{40}$/.test(event.commitSha)) {
      throw new Error('Invalid commit SHA in checkpoint event')
    }
    if (event.scopeCommitSha && !/^[a-f0-9]{40}$/.test(event.scopeCommitSha)) {
      throw new Error('Invalid attested scope commit SHA in checkpoint event')
    }
    if (event.auditStatus && !['ACTIVE', 'BLOCKED', 'STOPPED', 'OPTIMIZATION_EXHAUSTED'].includes(event.auditStatus)) {
      throw new Error('Invalid exhaustion audit status')
    }
    if (event.type === 'audit_completed' || (event.type === 'gate_stopped' && event.auditId !== undefined)) {
      if (!Array.isArray(event.auditedDimensions) || event.auditedDimensions.length !== AUDIT_DIMENSIONS.length ||
          AUDIT_DIMENSIONS.some(d => !event.auditedDimensions.includes(d)) ||
          !Array.isArray(event.specialistRoles) || event.specialistRoles.length !== AUDIT_ROLES.length ||
          AUDIT_ROLES.some(role => !event.specialistRoles.includes(role)) ||
          !/^[a-z0-9][a-z0-9-]{2,63}$/.test(event.auditId ?? '') ||
          !Array.isArray(event.auditEvidenceRefs) || event.auditEvidenceRefs.length === 0 ||
          !Number.isSafeInteger(event.awaitingApprovalCount) || event.awaitingApprovalCount < 0) {
        throw new Error('Incomplete or invalid audit dimensions or roles in event')
      }
      event.auditEvidenceRefs.forEach(assertReference)
      validateSpecialistAssessments(event.specialistAssessments)
    } else if (event.type === 'gate_stopped') {
      if (!['budget', 'security', 'correctness'].includes(event.reasonCode)) {
        throw new Error('Gate stop event requires an allowlisted stop reason')
      }
    } else if (event.type === 'stop_released') {
      validateStopReleaseAttestation({
        reasonCode: event.reasonCode, remediationEvidenceRef: event.evidenceRef,
        authorizedScopeRef: event.authorizedScopeRef, scopeCommitSha: event.scopeCommitSha,
        approvals: event.approvals,
      })
    } else if (event.type === 'approval_recorded') {
      validateApprovalAttestation({
        approverIdentity: event.approverIdentity,
        approverRole: event.approverRole,
        approvalEvidenceRef: event.approvalEvidenceRef,
        authorizedScopeRef: event.authorizedScopeRef,
        scopeCommitSha: event.scopeCommitSha,
      })
    } else if (event.auditedDimensions !== undefined || event.specialistRoles !== undefined) {
      throw new Error('Incomplete or invalid audit dimensions in event')
    }
    for (const countKey of ['consecutiveCleanAudits', 'actionableCount', 'blockedCount']) {
      if (event[countKey] !== undefined && (!Number.isSafeInteger(event[countKey]) || event[countKey] < 0)) {
        throw new Error('Invalid exhaustion audit count')
      }
    }
    if (event.type !== 'approval_recorded' &&
        ['approverIdentity', 'approverRole', 'approvalEvidenceRef'].some(key => event[key] !== undefined)) {
      throw new Error('Approval attestation fields are only valid on approval events')
    }
    if (!['approval_recorded', 'stop_released'].includes(event.type) &&
        ['authorizedScopeRef', 'scopeCommitSha'].some(key => event[key] !== undefined)) {
      throw new Error('Scope attestation fields are only valid on approval or stop-release events')
    }
    if (event.type !== 'stop_released' && event.approvals !== undefined) {
      throw new Error('Release approval set is only valid on stop-release events')
    }
  }
  const currentPilotStart = checkpoint.pilotId && allEvents.findLast(event =>
    event.type === 'pilot_started' && event.pilotId === checkpoint.pilotId)
  if (checkpoint.mergeMode === 'supervised_autonomous') {
    const startedAuthorization = currentPilotStart?.pilotStartAuthorization?.mergeAuthorization
    if (!startedAuthorization || startedAuthorization.authorizationId !== checkpoint.mergeAuthorization.authorizationId) {
      throw new Error('Supervised merge authorization must be preserved by the active pilot start event')
    }
    const currentScope = { ...checkpoint.mergeAuthorization, status: 'active', revokedAt: null, revocationEvidenceRef: null }
    if (JSON.stringify(currentScope) !== JSON.stringify(startedAuthorization)) {
      throw new Error('Supervised merge authorization scope cannot be changed during a run')
    }
    const revocations = allEvents.filter(event => event.type === 'supervised_merge_revoked' &&
      event.pilotId === checkpoint.pilotId && event.mergeRecord.authorizationId === checkpoint.mergeAuthorization.authorizationId)
    if ((checkpoint.mergeAuthorization.status === 'revoked') !== (revocations.length === 1)) {
      throw new Error('Supervised merge revocation state must match its append-only audit event')
    }
    if (revocations.length === 1 && (revocations[0].mergeRecord.revokedAt !== checkpoint.mergeAuthorization.revokedAt ||
        revocations[0].mergeRecord.evidenceRef !== checkpoint.mergeAuthorization.revocationEvidenceRef)) {
      throw new Error('Supervised merge revocation details must match the append-only audit event')
    }
    const decisions = allEvents.filter(event => event.type === 'supervised_merge_decision' &&
      event.pilotId === checkpoint.pilotId && event.mergeRecord.authorizationId === checkpoint.mergeAuthorization.authorizationId)
    const results = allEvents.filter(event => event.type === 'supervised_merge_completed' &&
      event.pilotId === checkpoint.pilotId && event.mergeRecord.authorizationId === checkpoint.mergeAuthorization.authorizationId)
    if (results.some(result => !decisions.some(decision => decision.mergeRecord.outcome === 'eligible' &&
        decision.mergeRecord.decisionDigest === result.mergeRecord.decisionDigest &&
        decision.mergeRecord.taskId === result.mergeRecord.taskId &&
        decision.mergeRecord.prNumber === result.mergeRecord.prNumber &&
        decision.mergeRecord.headSha === result.mergeRecord.headSha &&
        decision.mergeRecord.baseSha === result.mergeRecord.baseSha))) {
      throw new Error('A merge result must match a prior eligible decision for the same PR head and base')
    }
  } else if (checkpoint.mergeAuthorization !== null) {
    throw new Error('Manual mode cannot retain supervised authorization')
  }
  const preservationArchiveEvents = allEvents.filter(event => event.type === 'preservation_archived')
  for (const task of state.tasks) {
    const taskEvents = preservationArchiveEvents.filter(event => event.taskId === task.id)
    if (taskEvents.length !== task.preservationArchiveRefs.length ||
        taskEvents.some((event, index) => event.evidenceRef !== task.preservationArchiveRefs[index])) {
      throw new Error(`Task ${task.id} archive references do not match persisted archive events`)
    }
  }
  if (preservationArchiveEvents.some(event => !state.tasks.some(task => task.id === event.taskId))) {
    throw new Error('Lifecycle archive event references an unknown task')
  }
  const persistedAuditEvents = allEvents.filter(event =>
    event.type === 'audit_completed' || (event.type === 'gate_stopped' && event.auditId !== undefined))
  if (persistedAuditEvents.length !== gate.auditHistory.length) {
    throw new Error('Persisted audit events do not match audit history')
  }
  for (const audit of gate.auditHistory) {
    const event = persistedAuditEvents.find(item => item.auditId === audit.auditId)
    if (!event || event.auditStatus !== audit.auditStatus || event.actionableCount !== audit.actionableCount ||
        event.blockedCount !== audit.blockedCount || event.awaitingApprovalCount !== audit.awaitingApprovalCount ||
        JSON.stringify(event.auditedDimensions) !== JSON.stringify(audit.auditedDimensions) ||
        JSON.stringify(event.auditEvidenceRefs) !== JSON.stringify(audit.evidenceRefs) ||
        JSON.stringify(event.specialistAssessments) !== JSON.stringify(audit.specialistAssessments)) {
      throw new Error('Persisted audit event evidence differs from audit history')
    }
  }
  if (gate.status === 'OPTIMIZATION_EXHAUSTED' &&
      JSON.stringify(gate.finalReport.audits) !== JSON.stringify(gate.auditHistory)) {
    throw new Error('Exhaustion report does not preserve complete audit history')
  }
  const discoveryByTask = new Map()
  const approvalsByTask = new Map()
  for (const [index, event] of allEvents.entries()) {
    if (event.type === 'task_discovered' && event.taskId) {
      if (discoveryByTask.has(event.taskId)) throw new Error(`Duplicate task discovery event: ${event.taskId}`)
      discoveryByTask.set(event.taskId, {
        index, domain: event.domain, initialStatus: event.initialStatus ?? 'ready',
        hasInitialStatus: event.initialStatus !== undefined,
      })
    }
    if (event.type === 'approval_recorded' && event.taskId) {
      if (!approvalsByTask.has(event.taskId)) approvalsByTask.set(event.taskId, [])
      approvalsByTask.get(event.taskId).push(index)
    }
  }
  for (const task of state.tasks) {
    const discovered = discoveryByTask.get(task.id)
    if (!discovered) throw new Error(`Task ${task.id} lacks a task_discovered event`)
    if (discovered.domain !== task.domain) throw new Error(`Task ${task.id} domain differs from its discovery event`)
  }
  for (const [taskId, indices] of approvalsByTask) {
    const discovered = discoveryByTask.get(taskId)
    if (!discovered || discovered.initialStatus !== 'awaiting_approval' ||
        indices.some(index => index <= discovered.index)) {
      throw new Error(`Approval event does not release a previously discovered awaiting-approval task: ${taskId}`)
    }
  }
  for (const [taskId, discovered] of discoveryByTask) {
    const task = state.tasks.find(candidate => candidate.id === taskId)
    if (task && discovered.hasInitialStatus && discovered.initialStatus !== task.initialStatus) {
      throw new Error(`Task ${taskId} initial status differs from its discovery event`)
    }
    if (discovered.initialStatus !== 'awaiting_approval') continue
    const approvals = approvalsByTask.get(taskId) ?? []
    if (!task) throw new Error(`Discovered approval task is missing: ${taskId}`)
    if (approvals.length > 1) throw new Error(`Duplicate approval transition: ${taskId}`)
    if (approvals.length === 0 && task.status !== 'awaiting_approval') {
      throw new Error(`Awaiting-approval task ${taskId} changed status without structured approval evidence`)
    }
    if (approvals.length === 1 && task.status === 'awaiting_approval') {
      throw new Error(`Approved task ${taskId} cannot return to awaiting_approval`)
    }
  }
  for (const task of state.tasks.filter(candidate => candidate.initialStatus === 'awaiting_approval')) {
    const discovered = discoveryByTask.get(task.id)
    const approvals = approvalsByTask.get(task.id) ?? []
    if (!discovered || discovered.initialStatus !== 'awaiting_approval' ||
        (task.status !== 'awaiting_approval' && approvals.length !== 1)) {
      throw new Error(`Task ${task.id} lacks its original approval discovery or approval evidence`)
    }
  }
  if (gate.status === 'OPTIMIZATION_EXHAUSTED') {
    const expectedReport = buildFinalReport(state, [], gate.auditHistory.at(-1).specialistAssessments)
    if (JSON.stringify(expectedReport) !== JSON.stringify(gate.finalReport)) {
      throw new Error('Exhaustion report does not match the persisted backlog and audit evidence')
    }
  }
  for (const task of state.tasks) {
    for (const dependency of task.dependencies) {
      if (!seen.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${task.id}`)
    }
  }
  if (state.checkpoint.selectedTaskId && !seen.has(state.checkpoint.selectedTaskId)) {
    throw new Error('Checkpoint points at a missing selected task')
  }
  if (state.checkpoint.selectedTaskId && ![
    'selected', 'baseline_established', 'implementing', 'implemented', 'tests_passed', 'reviewed',
    'qa_passed', 'quality_security_passed',
  ].includes(state.tasks.find(task => task.id === state.checkpoint.selectedTaskId)?.status)) {
    throw new Error('Checkpoint selected task is not in an active lifecycle state')
  }
  return state
}

function validateLifecycle(task) {
  const successful = ['baseline_established', 'implementing', 'implemented', 'tests_passed',
    'reviewed', 'qa_passed', 'quality_security_passed', 'validated']
  if (successful.includes(task.status) && !task.baseline) throw new Error(`Task ${task.id} lifecycle lacks baseline`)
  if (['implementing', 'implemented', 'tests_passed', 'reviewed', 'qa_passed',
    'quality_security_passed', 'validated'].includes(task.status) && !task.implementation) {
    throw new Error(`Task ${task.id} lifecycle lacks implementation`)
  }
  if (['tests_passed', 'reviewed', 'qa_passed', 'quality_security_passed', 'validated'].includes(task.status) &&
      task.testResult?.passed !== true) throw new Error(`Task ${task.id} lifecycle lacks passing tests`)
  if (['reviewed', 'qa_passed', 'quality_security_passed', 'validated'].includes(task.status) &&
      (task.assessments.reviewer?.passed !== true || task.assessments.qa?.passed !== true)) {
    throw new Error(`Task ${task.id} lifecycle lacks Reviewer and QA passes`)
  }
  if (['reviewed', 'qa_passed', 'quality_security_passed', 'validated'].includes(task.status) &&
      task.assessmentProvenanceLegacy !== true &&
      ['reviewer', 'qa'].some(role => !task.assessments[role]?.invocationRef ||
        task.assessments[role]?.targetCommitSha !== task.implementation.commitSha)) {
    throw new Error(`Task ${task.id} lifecycle lacks traceable Reviewer and QA invocations for its implementation commit`)
  }
  if (['quality_security_passed', 'validated'].includes(task.status) &&
      (task.assessments.quality?.passed !== true || task.assessments.security?.passed !== true)) {
    throw new Error(`Task ${task.id} lifecycle lacks quality and security passes`)
  }
  if (['quality_security_passed', 'validated'].includes(task.status) &&
      task.assessmentProvenanceLegacy !== true &&
      ['quality', 'security'].some(role => !task.assessments[role]?.invocationRef ||
        task.assessments[role]?.targetCommitSha !== task.implementation.commitSha)) {
    throw new Error(`Task ${task.id} lifecycle lacks traceable quality/security invocations for its implementation commit`)
  }
  if (task.status === 'validated') {
    const v = task.validation
    const improved = v && (task.benchmarkDirection === 'lower_is_better'
      ? v.resultMetric < v.baselineMetric : v.resultMetric > v.baselineMetric)
    if (!v || v.accepted !== true || v.regression !== false || !improved ||
        v.baselineMetric !== task.baseline.metric) {
      throw new Error(`Task ${task.id} validated state lacks accepted measurable improvement`)
    }
  }
  if (task.status === 'rejected' && task.validation?.accepted !== false) {
    throw new Error(`Task ${task.id} rejected state lacks rejection record`)
  }
  if (task.status === 'blocked' && (!task.blocker || !task.workPreserved)) {
    throw new Error(`Task ${task.id} blocked state lacks blocker or preserved work`)
  }
  if (task.status === 'blocked') {
    const preservedSnapshot = task.preservationDeferral?.lifecycleSnapshot ?? task.workPreserved
    if (JSON.stringify(preservedSnapshot.baseline) !== JSON.stringify(task.baseline) ||
        JSON.stringify(preservedSnapshot.implementation) !== JSON.stringify(task.implementation) ||
        JSON.stringify(preservedSnapshot.assessments) !== JSON.stringify(task.assessments) ||
        JSON.stringify(preservedSnapshot.validation) !== JSON.stringify(task.validation) ||
        (preservedSnapshot.testResult !== undefined &&
         JSON.stringify(preservedSnapshot.testResult) !== JSON.stringify(task.testResult))) {
      throw new Error(`Task ${task.id} blocked state does not match preserved work`)
    }
  }
  if (task.status !== 'blocked' && task.blocker !== null) throw new Error(`Task ${task.id} has stale blocker`)
  if (task.status === 'selected' &&
      (task.baseline || task.implementation || task.testResult || task.validation)) {
    throw new Error(`Task ${task.id} selected state has premature lifecycle evidence`)
  }
}

function validateSpecialistAssessments(assessments) {
  if (!Array.isArray(assessments) || assessments.length !== AUDIT_ROLES.length) {
    throw new Error('Audit requires one allowlisted independent finding for every required specialist role')
  }
  const byRole = new Map()
  for (const item of assessments) {
    if (!onlyKeys(item, ['role', 'finding', 'evidenceRef', 'confirmsRole']) || !AUDIT_ROLES.includes(item.role) ||
        !['clear', 'improvement_identified', 'improvement_confirmed', 'blocked'].includes(item.finding) || byRole.has(item.role)) {
      throw new Error('Invalid independent specialist assessment')
    }
    assertReference(item.evidenceRef)
    if (item.confirmsRole !== undefined &&
        (!AUDIT_ROLES.includes(item.confirmsRole) || item.confirmsRole === item.role)) {
      throw new Error('Specialist confirmation must come from a distinct allowlisted role')
    }
    byRole.set(item.role, item)
  }
  if (AUDIT_ROLES.some(role => !byRole.has(role))) {
    throw new Error('Audit requires one allowlisted independent finding for every required specialist role')
  }
  for (const item of assessments.filter(x => x.finding === 'improvement_confirmed')) {
    if (!item.confirmsRole || !assessments.some(other => other.role === item.confirmsRole &&
        other.finding === 'improvement_identified')) {
      throw new Error('Improvement confirmation must identify a distinct role finding')
    }
  }
  return true
}

function validateStopApprovals(reasonCode, approvals) {
  const expectedRoles = reasonCode === 'security'
    ? ['reviewer', 'qa', 'security_privacy_engineer']
    : ['reviewer', 'qa', 'security_privacy_engineer', 'ai_quality_engineer']
  if (!Array.isArray(approvals) || approvals.length !== expectedRoles.length) {
    throw new Error('Stop release has an incomplete approval set')
  }
  const roles = new Set()
  const identities = new Set()
  const refs = new Set()
  for (const approval of approvals) {
    if (!onlyKeys(approval, ['role', 'identity', 'evidenceRef']) ||
        !expectedRoles.includes(approval.role) || typeof approval.identity !== 'string' ||
        !IDENTITY_PATTERN.test(approval.identity) ||
        roles.has(approval.role)) throw new Error('Invalid stop release approver attestation')
    assertReference(approval.evidenceRef)
    if (identities.has(approval.identity) || refs.has(approval.evidenceRef)) {
      throw new Error('Stop release approvals require distinct identities and evidence')
    }
    identities.add(approval.identity)
    refs.add(approval.evidenceRef)
    roles.add(approval.role)
  }
  if (expectedRoles.some(role => !roles.has(role))) throw new Error('Stop release lacks required role approvals')
}

function validateStopReleaseAttestation(release) {
  if (!['security', 'correctness'].includes(release.reasonCode) ||
      !/^[a-f0-9]{40}$/.test(release.scopeCommitSha ?? '') || !Array.isArray(release.approvals)) {
    throw new Error('Stop release requires a valid reason and exact reviewed commit SHA')
  }
  assertReference(release.remediationEvidenceRef)
  assertReference(release.authorizedScopeRef)
  validateStopApprovals(release.reasonCode, release.approvals)
  const refs = [release.remediationEvidenceRef, release.authorizedScopeRef,
    ...release.approvals.map(item => item.evidenceRef)]
  if (new Set(refs).size !== refs.length) {
    throw new Error('Stop release requires distinct scope and evidence references')
  }
  return release
}

function validateApprovalAttestation(attestation) {
  if (!onlyKeys(attestation, ['approverIdentity', 'approverRole', 'approvalEvidenceRef',
    'authorizedScopeRef', 'scopeCommitSha']) ||
      typeof attestation.approverIdentity !== 'string' || !IDENTITY_PATTERN.test(attestation.approverIdentity) ||
      !AUDIT_ROLES.includes(attestation.approverRole) ||
      !/^[a-f0-9]{40}$/.test(attestation.scopeCommitSha ?? '')) {
    throw new Error('Approval requires identity, role, authorized scope, and exact commit SHA metadata')
  }
  assertReference(attestation.approvalEvidenceRef)
  assertReference(attestation.authorizedScopeRef)
  if (attestation.approvalEvidenceRef === attestation.authorizedScopeRef) {
    throw new Error('Approval evidence and authorized scope must be distinct references')
  }
  return attestation
}

function validateAuditHistory(history) {
  const ids = new Set()
  for (const audit of history) {
    if (!onlyKeys(audit, ['auditId', 'recordedAt', 'auditStatus', 'actionableCount', 'blockedCount',
      'awaitingApprovalCount', 'auditedDimensions', 'evidenceRefs', 'specialistAssessments']) ||
        !/^[a-z0-9][a-z0-9-]{2,63}$/.test(audit.auditId ?? '') || ids.has(audit.auditId) ||
        typeof audit.recordedAt !== 'string' || Number.isNaN(Date.parse(audit.recordedAt)) ||
        !['ACTIVE', 'BLOCKED', 'STOPPED', 'OPTIMIZATION_EXHAUSTED'].includes(audit.auditStatus) ||
        !['actionableCount', 'blockedCount', 'awaitingApprovalCount'].every(key =>
          Number.isSafeInteger(audit[key]) && audit[key] >= 0) ||
        !Array.isArray(audit.auditedDimensions) || audit.auditedDimensions.length !== AUDIT_DIMENSIONS.length ||
        AUDIT_DIMENSIONS.some(d => !audit.auditedDimensions.includes(d)) ||
        !Array.isArray(audit.evidenceRefs) || audit.evidenceRefs.length === 0 || audit.evidenceRefs.length > 12) {
      throw new Error('Invalid or duplicate persisted audit record')
    }
    audit.evidenceRefs.forEach(assertReference)
    validateSpecialistAssessments(audit.specialistAssessments)
    ids.add(audit.auditId)
  }
}

function auditIsClean(audit) {
  return ['ACTIVE', 'OPTIMIZATION_EXHAUSTED'].includes(audit.auditStatus) &&
    audit.actionableCount === 0 && audit.blockedCount === 0 && audit.awaitingApprovalCount === 0 &&
    audit.specialistAssessments.every(item => item.finding === 'clear')
}

function hasUnconfirmedImprovement(assessments) {
  return assessments.some(item => item.finding === 'improvement_identified' &&
    !assessments.some(other => other.role !== item.role && other.finding === 'improvement_confirmed' &&
      other.confirmsRole === item.role))
}

function hasTwoCleanAudits(history) {
  return history.length >= 2 && history.at(-1).auditStatus === 'OPTIMIZATION_EXHAUSTED' &&
    auditIsClean(history.at(-1)) && auditIsClean(history.at(-2))
}

function validFinalReport(report) {
  const keys = ['cyclesCompleted', 'backlogCounts', 'validatedImprovements', 'rejectedItems', 'blockedItems',
    'awaitingApprovalItems', 'specialistFindings', 'auditDimensions', 'auditEvidenceRefs', 'audits', 'restartCriteria']
  if (!onlyKeys(report, keys) || !Number.isInteger(report.cyclesCompleted) || report.cyclesCompleted < 0 ||
      report.cyclesCompleted > MAX_CYCLES ||
      !onlyKeys(report.backlogCounts, ['actionable', 'awaiting_approval', 'blocked', 'completed', 'rejected']) ||
      Object.values(report.backlogCounts).some(count => !Number.isSafeInteger(count) || count < 0) ||
      report.backlogCounts.actionable !== 0 ||
      JSON.stringify(report.auditDimensions) !== JSON.stringify(AUDIT_DIMENSIONS) ||
      !Array.isArray(report.auditEvidenceRefs) || report.auditEvidenceRefs.length === 0 ||
      !Array.isArray(report.validatedImprovements) || !Array.isArray(report.rejectedItems) ||
      !Array.isArray(report.blockedItems) || !Array.isArray(report.awaitingApprovalItems) ||
      !Array.isArray(report.specialistFindings) || report.specialistFindings.length !== AUDIT_ROLES.length ||
      !Array.isArray(report.audits) || report.audits.length < 2 ||
      !Array.isArray(report.restartCriteria) ||
      report.restartCriteria.length === 0) return false
  try {
    validateAuditHistory(report.audits)
    if (!hasTwoCleanAudits(report.audits)) throw new Error()
    report.auditEvidenceRefs.forEach(assertReference)
    const findingRoles = new Set()
    report.specialistFindings.forEach(finding => {
      if (!onlyKeys(finding, ['role', 'finding', 'evidenceRef', 'confirmsRole']) || !AUDIT_ROLES.includes(finding.role) ||
          !['clear', 'improvement_identified', 'improvement_confirmed', 'blocked'].includes(finding.finding) || findingRoles.has(finding.role)) throw new Error()
      assertReference(finding.evidenceRef)
      findingRoles.add(finding.role)
    })
    if (AUDIT_ROLES.some(role => !findingRoles.has(role))) throw new Error()
    const records = [report.validatedImprovements, report.rejectedItems, report.blockedItems,
      report.awaitingApprovalItems]
    records.flat().forEach(record => {
      if (typeof record.taskId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(record.taskId)) throw new Error()
      const allowed = record.metricName !== undefined
        ? ['taskId', 'metricName', 'baselineMetric', 'resultMetric', 'evidenceRef']
        : record.role !== undefined ? ['taskId', 'role', 'passed', 'evidenceRef']
          : record.blockerCode !== undefined ? ['taskId', 'blockerCode', 'evidenceRef']
            : record.reasonCode !== undefined ? ['taskId', 'reasonCode', 'evidenceRef'] : []
      if (!allowed.length || !onlyKeys(record, allowed)) throw new Error()
      if (record.evidenceRef !== null) assertReference(record.evidenceRef)
    })
  } catch { return false }
  return report.restartCriteria.every(item =>
    ['new_actionable_task', 'distinct_blocker_evidence', 'credible_specialist_improvement',
      'required_approval', 'safe_scope_after_stop'].includes(item))
}

function buildFinalReport(state, auditEvidenceRefs, specialistAssessments) {
  const tasks = state.tasks
  const evidenceOf = task => task.validation?.evidenceRef ?? task.blocker?.evidenceRef ??
    Object.values(task.assessments ?? {}).find(item => item?.evidenceRef)?.evidenceRef ?? null
  return {
    cyclesCompleted: state.checkpoint.cyclesStarted - (state.checkpoint.selectedTaskId ? 1 : 0),
    backlogCounts: {
      actionable: actionableTasks(state).length,
      awaiting_approval: tasks.filter(t => t.status === 'awaiting_approval').length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
      completed: tasks.filter(t => t.status === 'validated').length,
      rejected: tasks.filter(t => t.status === 'rejected').length,
    },
    validatedImprovements: tasks.filter(t => t.status === 'validated').map(t => ({
      taskId: t.id, metricName: t.metricName, baselineMetric: t.validation.baselineMetric,
      resultMetric: t.validation.resultMetric, evidenceRef: t.validation.evidenceRef,
    })),
    rejectedItems: tasks.filter(t => t.status === 'rejected').map(t => ({
      taskId: t.id, reasonCode: t.validation?.reasonCode ?? 'unspecified', evidenceRef: evidenceOf(t),
    })),
    blockedItems: tasks.filter(t => t.status === 'blocked').map(t => ({
      taskId: t.id, blockerCode: t.blocker.code, evidenceRef: evidenceOf(t),
    })),
    awaitingApprovalItems: tasks.filter(t => t.status === 'awaiting_approval').map(t => ({
      taskId: t.id, reasonCode: 'awaiting_approval', evidenceRef: evidenceOf(t),
    })),
    specialistFindings: specialistAssessments.map(item => ({ ...item })),
    auditDimensions: [...AUDIT_DIMENSIONS],
    auditEvidenceRefs: state.checkpoint.optimizationGate.auditHistory.flatMap(audit => audit.evidenceRefs),
    audits: clone(state.checkpoint.optimizationGate.auditHistory),
    restartCriteria: ['new_actionable_task', 'distinct_blocker_evidence',
      'credible_specialist_improvement', 'required_approval', 'safe_scope_after_stop'],
  }
}

function taskValue(task) {
  // Impact and confidence are benefits; effort and risk reduce the score.
  return (task.impact * 10) + (Math.max(0, 5 - task.risk) * 2) - (task.effort * 3)
}

function dependenciesValidated(state, task) {
  const byId = new Map(state.tasks.map(item => [item.id, item]))
  return task.dependencies.every(id => byId.get(id)?.status === 'validated')
}

function selectNextTask(state, { excludeTaskIds = [] } = {}) {
  if (state.checkpoint.optimizationGate?.status === 'OPTIMIZATION_EXHAUSTED' ||
      state.checkpoint.optimizationGate?.status === 'BLOCKED' ||
      state.checkpoint.optimizationGate?.status === 'STOPPED') return null
  const excluded = new Set(excludeTaskIds)
  const previousId = state.checkpoint.previousTaskId
  const blockedIds = new Set(state.tasks.filter(task => task.status === 'blocked').map(task => task.id))
  const candidates = actionableTasks(state).filter(task =>
    !excluded.has(task.id) &&
    !(task.id === previousId &&
      task.evidenceRevision <= (task.priorBlockerEvidenceRevision ?? task.evidenceRevision)) &&
    !task.dependencies.some(id => blockedIds.has(id)) && dependenciesValidated(state, task))
  candidates.sort((a, b) => taskValue(b) - taskValue(a) || a.id.localeCompare(b.id))
  return candidates[0] ?? null
}

function actionableTasks(state) {
  const blockedIds = new Set(state.tasks.filter(task => ['blocked', 'awaiting_approval'].includes(task.status)).map(task => task.id))
  const byId = new Map(state.tasks.map(item => [item.id, item]))
  return state.tasks.filter(task => task.status === 'ready' &&
    !task.dependencies.some(id => blockedIds.has(id)) &&
    task.dependencies.every(id => byId.get(id)?.status === 'validated'))
}

function recordOptimizationAudit(state, audit = {}) {
  if (state.checkpoint.selectedTaskId) {
    throw new Error('Resolve the active task checkpoint before recording an exhaustion audit')
  }
  const { auditId, immediateStopCode = null, evidenceRefs = [], auditedDimensions = [], specialistAssessments = [] } = audit
  if (!onlyKeys(audit, ['auditId', 'immediateStopCode', 'evidenceRefs', 'auditedDimensions', 'specialistAssessments']) ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(auditId ?? '') ||
      !Array.isArray(evidenceRefs) ||
      evidenceRefs.length === 0 || evidenceRefs.length > 12 || !Array.isArray(auditedDimensions) ||
      auditedDimensions.length !== AUDIT_DIMENSIONS.length ||
      AUDIT_DIMENSIONS.some(d => !auditedDimensions.includes(d)) ||
      auditedDimensions.some(d => !AUDIT_DIMENSIONS.includes(d)) ||
      !Array.isArray(specialistAssessments) || specialistAssessments.length !== AUDIT_ROLES.length ||
      (immediateStopCode !== null && !['budget', 'security', 'correctness', 'approval'].includes(immediateStopCode))) {
    throw new Error('Audit input must use bounded allowlisted metadata')
  }
  evidenceRefs.forEach(assertReference)
  validateSpecialistAssessments(specialistAssessments)
  const previousAudits = state.checkpoint.optimizationGate?.auditHistory ?? []
  if (previousAudits.some(item => item.auditId === auditId)) throw new Error(`Duplicate audit ID: ${auditId}`)
  if (previousAudits.length >= 100) throw new Error('Audit history limit reached; archive checkpoint before continuing')
  if (state.checkpoint.optimizationGate?.status === 'STOPPED') {
    throw new Error('Stopped optimization gate requires an explicitly authorized release or new budgeted pilot')
  }
  const actionableCount = actionableTasks(state).length
  const awaitingApprovalCount = state.tasks.filter(t => t.status === 'awaiting_approval').length
  const blockedCount = state.tasks.filter(t => t.status === 'blocked').length +
    state.tasks.filter(t => t.status === 'ready' && t.dependencies.some(id => {
      const dependency = state.tasks.find(candidate => candidate.id === id)
      return dependency && dependency.status !== 'validated'
    })).length
  const specialistBlocked = specialistAssessments.some(item => item.finding === 'blocked')
  const unconfirmedImprovement = hasUnconfirmedImprovement(specialistAssessments)
  const credibleSpecialistImprovement = specialistAssessments.some(item => item.finding === 'improvement_confirmed')
  const gate = state.checkpoint.optimizationGate ??= {
    status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
    stopReason: null, finalReport: null, auditHistory: [],
  }
  if (immediateStopCode) {
    gate.status = immediateStopCode === 'approval' ? 'BLOCKED' : 'STOPPED'
    gate.consecutiveCleanAudits = 0
    gate.stopReason = immediateStopCode
  } else if (unconfirmedImprovement || awaitingApprovalCount > 0) {
    gate.status = 'BLOCKED'
    gate.consecutiveCleanAudits = 0
    gate.stopReason = awaitingApprovalCount > 0 ? 'approval' : null
  } else if (actionableCount > 0 || credibleSpecialistImprovement) {
    gate.status = 'ACTIVE'
    gate.consecutiveCleanAudits = 0
    gate.stopReason = null
  } else if (blockedCount > 0 || specialistBlocked) {
    gate.status = 'BLOCKED'
    gate.consecutiveCleanAudits = 0
    gate.stopReason = null
  } else {
    gate.consecutiveCleanAudits += 1
    gate.status = gate.consecutiveCleanAudits >= 2 ? 'OPTIMIZATION_EXHAUSTED' : 'ACTIVE'
    gate.stopReason = null
  }
  gate.lastAuditRefs = [...evidenceRefs]
  gate.lastAuditedDimensions = [...auditedDimensions]
  const auditRecord = {
    auditId, recordedAt: now(), auditStatus: gate.status, actionableCount, blockedCount,
    awaitingApprovalCount, auditedDimensions: [...auditedDimensions], evidenceRefs: [...evidenceRefs],
    specialistAssessments: specialistAssessments.map(item => ({ ...item })),
  }
  gate.auditHistory.push(auditRecord)
  gate.finalReport = gate.status === 'OPTIMIZATION_EXHAUSTED'
    ? buildFinalReport(state, evidenceRefs, specialistAssessments) : null
  const type = gate.status === 'STOPPED' ? 'gate_stopped' : 'audit_completed'
  appendEvent(state, {
    type,
    auditStatus: gate.status,
    auditId,
    consecutiveCleanAudits: gate.consecutiveCleanAudits,
    actionableCount,
    blockedCount,
    auditedDimensions: [...auditedDimensions],
    specialistRoles: specialistAssessments.map(item => item.role),
    auditEvidenceRefs: [...evidenceRefs],
    specialistAssessments: specialistAssessments.map(item => ({ ...item })),
    awaitingApprovalCount,
    ...(evidenceRefs[0] ? { evidenceRef: evidenceRefs[0] } : {}),
  })
  return gate
}

function appendEvent(state, event) {
  if (state.checkpoint.events.length >= MAX_EVENTS) {
    const amount = Math.min(EVENT_ARCHIVE_CHUNK, state.checkpoint.events.length)
    state.checkpoint.eventArchives.push(state.checkpoint.events.splice(0, amount))
  }
  const entry = { at: now(), ...event }
  if (!Object.hasOwn(entry, 'pilotId')) entry.pilotId = state.checkpoint.pilotId
  state.checkpoint.events.push(entry)
  state.updatedAt = now()
}

function archivePriorPilotSummary(checkpoint, previousCheckpoint, completedAt = now()) {
  if (!previousCheckpoint.pilotId) return
  const started = [...(previousCheckpoint.eventArchives ?? []).flat(), ...(previousCheckpoint.events ?? [])]
    .find(event => event.type === 'pilot_started' && event.pilotId === previousCheckpoint.pilotId)
  const summary = {
    pilotId: previousCheckpoint.pilotId,
    maxCycles: previousCheckpoint.maxCycles,
    cyclesStarted: previousCheckpoint.cyclesStarted,
    cyclesValidated: previousCheckpoint.cyclesValidated,
    gateStatus: previousCheckpoint.optimizationGate.status,
    stopReason: previousCheckpoint.optimizationGate.stopReason,
    startedAt: started?.at ?? null,
    completedAt,
  }
  validatePilotSummary(summary)
  const ids = [...checkpoint.archivedPilotHistory.flat(), ...checkpoint.pilotHistory]
    .map(item => item.pilotId)
  if (ids.includes(summary.pilotId)) throw new Error('Pilot history already contains this pilot ID')
  if (checkpoint.pilotHistory.length >= MAX_PILOT_SUMMARIES) {
    checkpoint.archivedPilotHistory.push(checkpoint.pilotHistory.splice(0, PILOT_SUMMARY_ARCHIVE_CHUNK))
  }
  checkpoint.pilotHistory.push(summary)
}

function resumeOptimization(state, reasonCode, taskId) {
  const gate = state.checkpoint.optimizationGate
  const canClearBlocked = gate.status === 'BLOCKED' && (gate.stopReason === 'approval'
    ? ['required_approval', 'new_actionable_task'].includes(reasonCode)
    : ['distinct_blocker_evidence', 'new_actionable_task'].includes(reasonCode))
  if (gate.status !== 'OPTIMIZATION_EXHAUSTED' &&
      !canClearBlocked) return false
  gate.status = 'ACTIVE'
  gate.consecutiveCleanAudits = 0
  gate.stopReason = null
  gate.finalReport = null
  appendEvent(state, { type: 'optimization_resumed', taskId, reasonCode })
  return true
}

function selectTask(state) {
  if (!state.checkpoint.pilotId) {
    throw new Error('Task selection requires an explicitly started pilot')
  }
  if (state.checkpoint.selectedTaskId) {
    const current = state.tasks.find(task => task.id === state.checkpoint.selectedTaskId)
    if (current && ['selected', 'baseline_established', 'implementing', 'implemented',
      'tests_passed', 'reviewed', 'qa_passed', 'quality_security_passed'].includes(current.status)) {
      return current
    }
    state.checkpoint.selectedTaskId = null
  }
  if (state.checkpoint.cyclesStarted >= state.checkpoint.maxCycles) {
    stopForBudget(state)
    return null
  }
  if (state.checkpoint.mergeMode === 'supervised_autonomous') {
    const selected = [...state.checkpoint.eventArchives.flat(), ...state.checkpoint.events]
      .filter(event => event.type === 'selected' && event.pilotId === state.checkpoint.pilotId)
    const tasksSelected = new Set(selected.map(event => event.taskId)).size
    if (tasksSelected >= state.checkpoint.mergeAuthorization.maxTasks) {
      stopForBudget(state)
      appendEvent(state, { type: 'supervised_task_limit_reached', mergeRecord: {
        authorizationId: state.checkpoint.mergeAuthorization.authorizationId,
        maxTasks: state.checkpoint.mergeAuthorization.maxTasks, tasksSelected,
      } })
      return null
    }
  }
  const task = selectNextTask(state, {
    excludeTaskIds: [],
  })
  if (!task) return null
  try {
    preserveAndResetStaleLifecycle(task)
  } catch (error) {
    if (!error.message.includes('bounded work history is full')) throw error
    deferTaskForSnapshotArchive(state, task)
    return selectTask(state)
  }
  task.status = 'selected'
  state.checkpoint.previousTaskId = task.id
  state.checkpoint.selectedTaskId = task.id
  state.checkpoint.cyclesStarted += 1
  appendEvent(state, { type: 'selected', taskId: task.id, cycle: state.checkpoint.cyclesStarted })
  if (task.benchmarkCost === 'expensive') {
    const checkRef = task.benchmarkRefs[0] ?? task.testRefs[0]
    const investigatorEvidenceRef = task.evidenceRefs[0] ?? checkRef
    if (!checkRef || !investigatorEvidenceRef) {
      throw new Error('Expensive benchmark task lacks evidence to record a safe blocker')
    }
    recordRecoveryDiagnosis(state, task.id, {
      diagnosisCode: 'benchmark_over_budget',
      investigatorEvidenceRef,
      originalCheckRef: checkRef,
      recoverable: false,
      blockerCode: 'benchmark_expensive',
      nonRecoverableReasonCode: 'resource_unavailable',
    })
    const fallback = { next: state.checkpoint.selectedTaskId
      ? findTask(state, state.checkpoint.selectedTaskId) : null }
    return fallback.next
  }
  return task
}

function preserveAndResetStaleLifecycle(task) {
  const hasStaleLifecycle = Boolean(task.baseline || task.implementation || task.testResult || task.validation ||
    Object.values(task.assessments ?? {}).some(assessment => assessment !== null))
  if (!hasStaleLifecycle) return
  const snapshot = mergeWorkPreserved(task, lifecycleSnapshot(task))
  task.workPreserved = snapshot
  task.baseline = null
  task.implementation = null
  task.testResult = null
  task.assessments = Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null]))
  delete task.assessmentProvenanceLegacy
  task.validation = null
}

function deferTaskForSnapshotArchive(state, task) {
  const snapshot = lifecycleSnapshot(task)
  task.status = 'blocked'
  task.blocker = {
    code: 'snapshot_history_full',
    evidenceRef: null,
    evidenceRevision: task.evidenceRevision,
    recordedAt: now(),
  }
  task.preservationDeferral = {
    reasonCode: 'snapshot_history_full',
    lifecycleSnapshot: snapshot,
    recordedAt: now(),
  }
  state.checkpoint.previousTaskId = task.id
  appendEvent(state, { type: 'blocked', taskId: task.id, blockerCode: 'snapshot_history_full', evidenceRef: null })
}

function lifecycleSnapshot(task) {
  return {
    baseline: clone(task.baseline),
    implementation: clone(task.implementation),
    testResult: clone(task.testResult),
    assessments: clone(task.assessments),
    validation: clone(task.validation),
  }
}

function snapshotHasLifecycle(snapshot) {
  return Boolean(snapshot.baseline || snapshot.implementation || snapshot.testResult || snapshot.validation ||
    Object.values(snapshot.assessments ?? {}).some(assessment => assessment !== null))
}

function mergeWorkPreserved(task, latestSnapshot) {
  const existing = task.workPreserved
  const priorSnapshots = [...(existing?.priorSnapshots ?? [])]
  if (existing && snapshotHasLifecycle(existing)) {
    const previousSnapshot = {
      baseline: clone(existing.baseline),
      implementation: clone(existing.implementation),
      testResult: clone(existing.testResult),
      assessments: clone(existing.assessments),
      validation: clone(existing.validation),
    }
    if (JSON.stringify(previousSnapshot) !== JSON.stringify(latestSnapshot)) priorSnapshots.push(previousSnapshot)
  }
  if (priorSnapshots.length > MAX_PRESERVED_SNAPSHOTS) {
    throw new Error('Cannot preserve another lifecycle snapshot; bounded work history is full')
  }
  return {
    ...clone(latestSnapshot),
    ...(priorSnapshots.length > 0 ? { priorSnapshots } : {}),
  }
}

function stopForBudget(state) {
  const gate = state.checkpoint.optimizationGate
  if (gate.status === 'STOPPED') return
  gate.status = 'STOPPED'
  gate.consecutiveCleanAudits = 0
  gate.stopReason = 'budget'
  gate.finalReport = null
  appendEvent(state, { type: 'gate_stopped', reasonCode: 'budget' })
}

function findTask(state, taskId) {
  const task = state.tasks.find(item => item.id === taskId)
  if (!task) throw new Error(`Unknown task: ${taskId}`)
  return task
}

function requireSelected(state, taskId) {
  const task = findTask(state, taskId)
  if (state.checkpoint.selectedTaskId !== task.id) {
    throw new Error(`Task ${taskId} is not the active checkpoint task`)
  }
  return task
}

function eventPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Event payload must be a structured object')
  }
  const allowed = new Set(['artifactRef', 'baselineMetric', 'resultMetric', 'branch', 'commitSha'])
  if (Object.keys(payload).some(key => !allowed.has(key))) {
    throw new Error('Event payload contains an unsupported field')
  }
  if (payload.artifactRef !== undefined) assertReference(payload.artifactRef)
  if (payload.baselineMetric !== undefined && !Number.isFinite(payload.baselineMetric)) {
    throw new Error('baselineMetric must be numeric')
  }
  if (payload.resultMetric !== undefined && !Number.isFinite(payload.resultMetric)) {
    throw new Error('resultMetric must be numeric')
  }
  if (payload.branch !== undefined && !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(payload.branch)) {
    throw new Error('Implementation branch must use the codex/ prefix')
  }
  if (payload.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(payload.commitSha)) {
    throw new Error('commitSha must be a full hexadecimal SHA')
  }
  return payload
}

function recordBaseline(state, taskId, payload) {
  const task = requireSelected(state, taskId)
  payload = eventPayload(payload)
  if (task.status !== 'selected' || !Number.isFinite(payload.baselineMetric) || !payload.artifactRef) {
    throw new Error('Baseline requires a numeric metric and evidence reference before implementation')
  }
  task.baseline = { metric: payload.baselineMetric, evidenceRef: payload.artifactRef }
  task.status = 'baseline_established'
  appendEvent(state, { type: 'baseline', taskId, metric: payload.baselineMetric, evidenceRef: payload.artifactRef })
  return task
}

function recordImplementation(state, taskId, payload) {
  const task = requireSelected(state, taskId)
  payload = eventPayload(payload)
  if (task.status !== 'baseline_established' && task.status !== 'implementing') {
    throw new Error('Implementation can start only after a baseline is recorded')
  }
  if (!payload.branch || !payload.commitSha) {
    throw new Error('Implementation requires a codex/ development branch and commit SHA')
  }
  task.implementation = { branch: payload.branch, commitSha: payload.commitSha }
  task.status = 'implemented'
  appendEvent(state, { type: 'implemented', taskId, branch: payload.branch, commitSha: payload.commitSha })
  return task
}

function recordTests(state, taskId, { passed, artifactRef }) {
  const task = requireSelected(state, taskId)
  if (passed === false) {
    assertReference(artifactRef)
    task.testResult = { passed: false, evidenceRef: artifactRef }
    task.status = 'implemented'
    appendEvent(state, { type: 'tests_failed', taskId, evidenceRef: artifactRef })
    return task
  }
  if (task.status !== 'implemented' || passed !== true) {
    throw new Error('Tests can pass only after implementation and require passed=true')
  }
  assertReference(artifactRef)
  task.testResult = { passed: true, evidenceRef: artifactRef }
  task.status = 'tests_passed'
  appendEvent(state, { type: 'tests_passed', taskId, evidenceRef: artifactRef })
  return task
}

function recordAssessment(state, taskId, { role, passed, artifactRef, invocationRef, targetCommitSha }) {
  const task = requireSelected(state, taskId)
  if (task.status !== 'tests_passed' && task.status !== 'reviewed' && task.status !== 'qa_passed') {
    throw new Error('Independent assessments require passing focused tests')
  }
  if (!['reviewer', 'qa', 'quality', 'security'].includes(role) || typeof passed !== 'boolean') {
    throw new Error('Assessment role/result is invalid')
  }
  assertReference(artifactRef)
  assertInvocationReference(invocationRef)
  if (targetCommitSha !== task.implementation?.commitSha) {
    throw new Error('Assessment invocation must identify the exact implemented commit')
  }
  delete task.assessmentProvenanceLegacy
  task.assessments[role] = {
    passed, evidenceRef: artifactRef, invocationRef, targetCommitSha,
  }
  if (!passed) return rejectTask(state, taskId, `${role}_rejected`, artifactRef)
  if (task.assessments.reviewer?.passed && task.assessments.qa?.passed) task.status = 'reviewed'
  if (task.assessments.quality?.passed && task.assessments.security?.passed) {
    if (task.status !== 'reviewed') throw new Error('Quality/security checks require Reviewer and QA passes')
    task.status = 'quality_security_passed'
  } else if (task.assessments.reviewer?.passed && task.assessments.qa?.passed) {
    task.status = 'qa_passed'
  }
  appendEvent(state, {
    type: `${role}_${passed ? 'passed' : 'rejected'}`,
    taskId,
    evidenceRef: artifactRef,
    invocationRef,
    assessmentCommitSha: targetCommitSha,
  })
  return task
}

function recordBenchmark(state, taskId, payload) {
  const task = requireSelected(state, taskId)
  payload = eventPayload(payload)
  if (task.status !== 'quality_security_passed') {
    throw new Error('Benchmark result requires tests, Reviewer, QA, quality, and security passes')
  }
  if (task.benchmarkCost === 'expensive') {
    return blockTask(state, taskId, 'benchmark_expensive', payload.artifactRef)
  }
  if (!Number.isFinite(payload.resultMetric) || !payload.artifactRef) {
    throw new Error('Local benchmark requires a numeric result and evidence reference')
  }
  const direction = task.benchmarkDirection
  const regression = direction === 'lower_is_better'
    ? payload.resultMetric > task.baseline.metric
    : payload.resultMetric < task.baseline.metric
  const improved = direction === 'lower_is_better'
    ? payload.resultMetric < task.baseline.metric
    : payload.resultMetric > task.baseline.metric
  task.validation = {
    accepted: true,
    baselineMetric: task.baseline.metric,
    resultMetric: payload.resultMetric,
    regression,
    evidenceRef: payload.artifactRef,
  }
  if (regression) return rejectTask(state, taskId, 'benchmark_regression', payload.artifactRef)
  if (!improved) return rejectTask(state, taskId, 'no_measurable_improvement', payload.artifactRef)
  task.status = 'validated'
  state.checkpoint.cyclesValidated += 1
  state.checkpoint.selectedTaskId = null
  appendEvent(state, { type: 'validated', taskId, resultMetric: payload.resultMetric, evidenceRef: payload.artifactRef })
  if (state.checkpoint.cyclesStarted >= state.checkpoint.maxCycles) stopForBudget(state)
  return task
}

function rejectTask(state, taskId, reasonCode, evidenceRef) {
  const task = requireSelected(state, taskId)
  if (evidenceRef) assertReference(evidenceRef)
  task.status = 'rejected'
  task.validation = { accepted: false, reasonCode, evidenceRef: evidenceRef ?? null }
  state.checkpoint.selectedTaskId = null
  appendEvent(state, { type: 'rejected', taskId, reasonCode, evidenceRef: evidenceRef ?? null })
  if (state.checkpoint.cyclesStarted >= state.checkpoint.maxCycles) stopForBudget(state)
  return task
}

function blockTask(state, taskId, blockerCode, evidenceRef) {
  const task = requireSelected(state, taskId)
  if (!BLOCKERS.includes(blockerCode)) throw new Error('Blocker code is not allowlisted')
  if (evidenceRef) assertReference(evidenceRef)
  const recoveryCase = task.recoveryHistory.at(-1)
  if (!recoveryCase || recoveryCase.outcome !== 'blocked' ||
      recoveryCase.diagnosis.blockerCode !== blockerCode ||
      (recoveryCase.diagnosis.recoverable &&
        (recoveryCase.attempts.length !== MAX_RECOVERY_ATTEMPTS ||
          recoveryCase.attempts.some(attempt => attempt.result !== 'failed'))) ||
      (!recoveryCase.diagnosis.recoverable && recoveryCase.attempts.length !== 0)) {
    throw new Error('Blocking requires an Investigator diagnosis and completed safe recovery policy')
  }
  const preservedWork = mergeWorkPreserved(task, lifecycleSnapshot(task))
  task.status = 'blocked'
  task.blocker = {
    code: blockerCode,
    evidenceRef: evidenceRef ?? null,
    evidenceRevision: task.evidenceRevision,
    recordedAt: now(),
  }
  task.workPreserved = preservedWork
  state.checkpoint.selectedTaskId = null
  state.checkpoint.previousTaskId = task.id
  appendEvent(state, { type: 'blocked', taskId, blockerCode, evidenceRef: evidenceRef ?? null })
  const next = selectTask(state)
  return { blocked: task, next }
}

function recordRecoveryDiagnosis(state, taskId, payload) {
  const task = requireSelected(state, taskId)
  const allowed = [
    'diagnosisCode', 'investigatorEvidenceRef', 'originalCheckRef', 'recoverable',
    'blockerCode', 'nonRecoverableReasonCode',
  ]
  if (!onlyKeys(payload, allowed) || !RECOVERY_DIAGNOSIS_CODES.includes(payload.diagnosisCode) ||
      typeof payload.recoverable !== 'boolean' || !BLOCKERS.includes(payload.blockerCode)) {
    throw new Error('Investigator diagnosis requires allowlisted diagnosis, recoverability, and blocker codes')
  }
  assertReference(payload.investigatorEvidenceRef)
  assertReference(payload.originalCheckRef)
  if (![...task.testRefs, ...task.benchmarkRefs].includes(payload.originalCheckRef)) {
    throw new Error('Investigator must identify the original allowlisted check')
  }
  if (payload.recoverable && payload.nonRecoverableReasonCode !== undefined) {
    throw new Error('Recoverable diagnosis cannot include a non-recoverable reason code')
  }
  if (!payload.recoverable && !NON_RECOVERABLE_REASON_CODES.includes(payload.nonRecoverableReasonCode)) {
    throw new Error('A non-recoverable diagnosis requires an allowlisted reason code')
  }
  if (task.recoveryHistory.length >= MAX_RECOVERY_CASES) {
    throw new Error('Recovery history limit reached; preserve and archive the task before reopening')
  }
  if (task.recoveryHistory.some(item => item.outcome === 'in_progress')) {
    throw new Error('Resolve the current recovery case before recording another diagnosis')
  }
  if (recoveryEvidenceReferences(task.recoveryHistory).has(payload.investigatorEvidenceRef)) {
    throw new Error('Recovery diagnosis requires evidence not used in any prior recovery case')
  }
  const addsEvidenceRef = !task.evidenceRefs.includes(payload.investigatorEvidenceRef)
  if (addsEvidenceRef && task.evidenceRefs.length >= 12) throw new Error('Task evidence reference limit reached')
  if (!payload.recoverable) mergeWorkPreserved(task, lifecycleSnapshot(task))
  if (addsEvidenceRef) task.evidenceRefs.push(payload.investigatorEvidenceRef)
  const recoveryCase = {
    diagnosis: {
      diagnosisCode: payload.diagnosisCode,
      investigatorEvidenceRef: payload.investigatorEvidenceRef,
      originalCheckRef: payload.originalCheckRef,
      recoverable: payload.recoverable,
      blockerCode: payload.blockerCode,
      ...(payload.recoverable ? {} : { nonRecoverableReasonCode: payload.nonRecoverableReasonCode }),
      recordedAt: now(),
    },
    attempts: [],
    outcome: payload.recoverable ? 'in_progress' : 'blocked',
  }
  task.recoveryHistory.push(recoveryCase)
  appendEvent(state, {
    type: 'recovery_diagnosed', taskId, recoveryCaseIndex: task.recoveryHistory.length - 1,
    evidenceRef: payload.investigatorEvidenceRef,
  })
  if (!payload.recoverable) return blockTask(state, taskId, payload.blockerCode, payload.investigatorEvidenceRef)
  return recoveryCase
}

function recordRecoveryAttempt(state, taskId, payload) {
  const task = requireSelected(state, taskId)
  const recoveryCase = task.recoveryHistory.at(-1)
  if (!recoveryCase || recoveryCase.outcome !== 'in_progress' || !recoveryCase.diagnosis.recoverable) {
    throw new Error('An active, safely recoverable Investigator diagnosis is required')
  }
  if (!onlyKeys(payload, ['strategy', 'evidenceRef', 'verificationRef', 'result']) ||
      !RECOVERY_STRATEGIES.includes(payload.strategy) ||
      !['passed', 'failed'].includes(payload.result)) {
    throw new Error('Recovery attempt must use an allowlisted strategy and result')
  }
  if (recoveryCase.attempts.length >= MAX_RECOVERY_ATTEMPTS) {
    throw new Error('Recovery is limited to two distinct attempts')
  }
  assertReference(payload.evidenceRef)
  assertReference(payload.verificationRef)
  if (recoveryCase.attempts.some(attempt => attempt.strategy === payload.strategy)) {
    throw new Error('Repeated recovery strategy; new evidence and a distinct strategy are required')
  }
  const recordedEvidence = recoveryEvidenceReferences(task.recoveryHistory)
  if (recordedEvidence.has(payload.evidenceRef) || recordedEvidence.has(payload.verificationRef) ||
      payload.evidenceRef === payload.verificationRef) {
    throw new Error('Recovery attempt requires distinct evidence and verification references')
  }
  const willBlock = payload.result === 'failed' && recoveryCase.attempts.length + 1 === MAX_RECOVERY_ATTEMPTS
  if (willBlock) mergeWorkPreserved(task, lifecycleSnapshot(task))
  const attempt = {
    strategy: payload.strategy,
    evidenceRef: payload.evidenceRef,
    checkRef: recoveryCase.diagnosis.originalCheckRef,
    verificationRef: payload.verificationRef,
    result: payload.result,
    recordedAt: now(),
  }
  recoveryCase.attempts.push(attempt)
  appendEvent(state, {
    type: 'recovery_attempted', taskId, recoveryCaseIndex: task.recoveryHistory.length - 1,
    recoveryStrategy: attempt.strategy, recoveryResult: attempt.result,
    evidenceRef: attempt.verificationRef,
  })
  if (payload.result === 'passed') {
    recoveryCase.outcome = 'recovered'
    if (task.testResult?.passed === false) {
      task.testResult = { passed: true, evidenceRef: attempt.verificationRef }
      task.status = 'tests_passed'
      appendEvent(state, { type: 'tests_passed', taskId, evidenceRef: attempt.verificationRef })
    }
    appendEvent(state, {
      type: 'recovery_recovered', taskId, recoveryCaseIndex: task.recoveryHistory.length - 1,
      evidenceRef: attempt.verificationRef,
    })
    return { recovered: true, task, next: task }
  }
  if (recoveryCase.attempts.length < MAX_RECOVERY_ATTEMPTS) {
    return { recovered: false, retryAvailable: true, task, next: task }
  }
  recoveryCase.outcome = 'blocked'
  const blocked = blockTask(state, taskId, recoveryCase.diagnosis.blockerCode, attempt.verificationRef)
  return { recovered: false, retryAvailable: false, ...blocked }
}

function recordNewEvidence(state, taskId, evidenceRef) {
  const task = findTask(state, taskId)
  if (task.status !== 'blocked') throw new Error('Only blocked tasks can receive unblock evidence')
  if (task.preservationDeferral) {
    throw new Error('Task is blocked awaiting snapshot archive; new evidence cannot reopen it yet')
  }
  assertReference(evidenceRef)
  if (task.evidenceRefs.includes(evidenceRef) || task.blocker?.evidenceRef === evidenceRef) {
    throw new Error('New evidence must be distinct from all evidence already recorded for this task')
  }
  const recoveryEvidence = new Set(task.recoveryHistory.flatMap(recoveryCase => [
    recoveryCase.diagnosis.investigatorEvidenceRef,
    ...recoveryCase.attempts.flatMap(attempt => [attempt.evidenceRef, attempt.verificationRef]),
  ]))
  if (recoveryEvidence.has(evidenceRef)) {
    throw new Error('New evidence must be distinct from all recovery diagnosis and attempt evidence')
  }
  if (task.evidenceRefs.length >= 12) {
    throw new Error('Task evidence reference limit reached; preserve the existing evidence set')
  }
  task.evidenceRevision += 1
  task.evidenceRefs = [...new Set([...task.evidenceRefs, evidenceRef])]
  task.priorBlockerEvidenceRevision = task.blocker?.evidenceRevision ?? 0
  task.blocker = null
  task.status = 'ready'
  task.baseline = null
  task.implementation = null
  task.testResult = null
  task.assessments = Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null]))
  task.validation = null
  appendEvent(state, { type: 'new_evidence', taskId, evidenceRef, evidenceRevision: task.evidenceRevision })
  resumeOptimization(state, 'distinct_blocker_evidence', task.id)
  return task
}

function preservationSnapshotManifest(task) {
  const priorSnapshots = task.workPreserved.priorSnapshots ?? []
  const currentSnapshot = {
    baseline: clone(task.workPreserved.baseline),
    implementation: clone(task.workPreserved.implementation),
    testResult: clone(task.workPreserved.testResult),
    assessments: clone(task.workPreserved.assessments),
    validation: clone(task.workPreserved.validation),
  }
  const snapshots = [
    ...priorSnapshots.map((snapshot, index) => ({ kind: 'prior', index, snapshot: clone(snapshot) })),
    { kind: 'work_preserved', snapshot: currentSnapshot },
    { kind: 'deferred', snapshot: clone(task.preservationDeferral.lifecycleSnapshot) },
  ]
  return { schemaVersion: 1, taskId: task.id, snapshotCount: snapshots.length, snapshots }
}

function taskStoredEvidenceReferences(task) {
  const refs = new Set([
    ...task.evidenceRefs,
    ...task.testRefs,
    ...task.benchmarkRefs,
    ...recoveryEvidenceReferences(task.recoveryHistory),
    ...task.preservationArchiveRefs,
  ])
  if (task.blocker?.evidenceRef) refs.add(task.blocker.evidenceRef)
  for (const snapshot of [
    lifecycleSnapshot(task),
    ...(task.workPreserved ? [
      {
        baseline: task.workPreserved.baseline,
        implementation: task.workPreserved.implementation,
        testResult: task.workPreserved.testResult,
        assessments: task.workPreserved.assessments,
        validation: task.workPreserved.validation,
      },
      ...(task.workPreserved.priorSnapshots ?? []),
    ] : []),
    ...(task.preservationDeferral ? [task.preservationDeferral.lifecycleSnapshot] : []),
  ]) {
    if (snapshot.baseline?.evidenceRef) refs.add(snapshot.baseline.evidenceRef)
    if (snapshot.testResult?.evidenceRef) refs.add(snapshot.testResult.evidenceRef)
    if (snapshot.validation?.evidenceRef) refs.add(snapshot.validation.evidenceRef)
    for (const assessment of Object.values(snapshot.assessments ?? {})) {
      if (assessment?.evidenceRef) refs.add(assessment.evidenceRef)
    }
  }
  return refs
}

function preservationArchiveReference(taskId, digest) {
  return `docs/autonomy/archives/${taskId}-${digest}.json`
}

function archiveTargetPath(repositoryRoot, taskId, archiveReference) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(taskId ?? '') || typeof archiveReference !== 'string') {
    throw new Error('Lifecycle archive reference is invalid')
  }
  const match = archiveReference.match(/^docs\/autonomy\/archives\/([a-z0-9][a-z0-9-]{1,63})-([a-f0-9]{64})\.json$/)
  if (!match || match[1] !== taskId) {
    throw new Error('Lifecycle archive must use the exact task-scoped SHA-256 path')
  }
  const root = path.resolve(repositoryRoot)
  const target = path.resolve(root, ...archiveReference.split('/'))
  const expectedDirectory = path.resolve(root, 'docs', 'autonomy', 'archives')
  if (path.dirname(target) !== expectedDirectory || path.basename(target) !== `${taskId}-${match[2]}.json`) {
    throw new Error('Lifecycle archive path escapes its task-scoped archive directory')
  }
  return { root, directory: expectedDirectory, target, digest: match[2], reference: archiveReference }
}

async function inspectArchiveDirectory(repositoryRoot, create) {
  const root = path.resolve(repositoryRoot)
  let rootStat
  try { rootStat = await fs.lstat(root) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Lifecycle archive repository root is missing')
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Lifecycle archive repository root must be a real directory')
  }
  let current = root
  for (const segment of ['docs', 'autonomy', 'archives']) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw new Error('Lifecycle archive directory is missing')
      try { await fs.mkdir(current) } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError
      }
      stat = await fs.lstat(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || path.resolve(await fs.realpath(current)) !== current) {
      throw new Error('Lifecycle archive directories cannot contain symlinks or traversal components')
    }
  }
  return current
}

function preservationArchiveBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function createPreservationArchive(state, taskId, repositoryRoot = REPOSITORY_ROOT) {
  const task = findTask(state, taskId)
  if (task.status !== 'blocked' || !task.preservationDeferral) {
    throw new Error('Only a task awaiting lifecycle snapshot archive can be archived')
  }
  if (task.preservationArchiveRefs.length >= MAX_PRESERVATION_ARCHIVES) {
    throw new Error('Lifecycle archive reference history is full')
  }
  const manifest = preservationSnapshotManifest(task)
  const bytes = preservationArchiveBytes(manifest)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const archiveReference = preservationArchiveReference(task.id, digest)
  if (taskStoredEvidenceReferences(task).has(archiveReference)) {
    throw new Error('Generated lifecycle archive path collides with evidence already stored on the task')
  }
  const { directory, target } = archiveTargetPath(repositoryRoot, task.id, archiveReference)
  await inspectArchiveDirectory(repositoryRoot, true)

  let existing
  try { existing = await fs.lstat(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Lifecycle archive target is not a regular file')
    const { bytes: currentBytes } = await readTaskScopedArchive(repositoryRoot, task.id, archiveReference)
    if (!currentBytes.equals(bytes)) throw new Error('Existing lifecycle archive content does not match its SHA-256 name')
    return archiveReference
  }

  const temporaryPath = path.join(directory, `.${task.id}.${crypto.randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    try {
      await fs.link(temporaryPath, target)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const { bytes: concurrentBytes } = await readTaskScopedArchive(repositoryRoot, task.id, archiveReference)
      if (!concurrentBytes.equals(bytes)) {
        throw new Error('Concurrent lifecycle archive differs from the expected immutable artifact')
      }
    }
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
  return archiveReference
}

async function readTaskScopedArchive(repositoryRoot, taskId, archiveReference) {
  const { target, digest } = archiveTargetPath(repositoryRoot, taskId, archiveReference)
  await inspectArchiveDirectory(repositoryRoot, false)
  const beforeStat = await fs.lstat(target).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Lifecycle archive artifact is missing')
    throw error
  })
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
    throw new Error('Lifecycle archive artifact must be a regular non-symlink file')
  }
  if (beforeStat.size > MAX_PRESERVATION_ARCHIVE_BYTES) {
    throw new Error('Lifecycle archive exceeds its bounded size')
  }
  const handle = await fs.open(target, 'r')
  let bytes
  try {
    const openedStat = await handle.stat()
    const afterStat = await fs.lstat(target)
    if (afterStat.isSymbolicLink() || afterStat.dev !== beforeStat.dev || afterStat.ino !== beforeStat.ino ||
        openedStat.dev !== beforeStat.dev || openedStat.ino !== beforeStat.ino ||
        openedStat.size !== beforeStat.size || openedStat.size > MAX_PRESERVATION_ARCHIVE_BYTES) {
      throw new Error('Lifecycle archive target changed while being verified')
    }
    const buffer = Buffer.alloc(MAX_PRESERVATION_ARCHIVE_BYTES + 1)
    let totalBytes = 0
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalBytes, buffer.length - totalBytes, totalBytes)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_PRESERVATION_ARCHIVE_BYTES) {
        throw new Error('Lifecycle archive exceeds its bounded size')
      }
    }
    bytes = buffer.subarray(0, totalBytes)
  } finally {
    await handle.close()
  }
  return { bytes, digest }
}

async function verifyPreservationArchive(state, taskId, archiveReference, repositoryRoot = REPOSITORY_ROOT) {
  const task = findTask(state, taskId)
  if (task.status !== 'blocked' || !task.preservationDeferral) {
    throw new Error('Only a task awaiting lifecycle snapshot archive can be resolved')
  }
  const { bytes, digest } = await readTaskScopedArchive(repositoryRoot, task.id, archiveReference)
  const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actualDigest !== digest) throw new Error('Lifecycle archive SHA-256 does not match its path')
  const expected = preservationArchiveBytes(preservationSnapshotManifest(task))
  if (!bytes.equals(expected)) throw new Error('Lifecycle archive snapshot manifest or count does not match the task')
  if (taskStoredEvidenceReferences(task).has(archiveReference)) {
    throw new Error('Lifecycle archive reference must be distinct from every stored task evidence source')
  }
  return { archiveReference, archivedSnapshotCount: preservationSnapshotManifest(task).snapshotCount }
}

async function verifyPersistedPreservationArchives(state, repositoryRoot = REPOSITORY_ROOT) {
  const archiveEvents = [...state.checkpoint.eventArchives.flat(), ...state.checkpoint.events]
    .filter(event => event.type === 'preservation_archived')
  for (const task of state.tasks) {
    for (const archiveReference of task.preservationArchiveRefs) {
      const event = archiveEvents.find(candidate => candidate.taskId === task.id && candidate.evidenceRef === archiveReference)
      if (!event) throw new Error(`Task ${task.id} lifecycle archive has no matching checkpoint event`)
      const { bytes, digest } = await readTaskScopedArchive(repositoryRoot, task.id, archiveReference)
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error(`Task ${task.id} lifecycle archive SHA-256 does not match its path`)
      }
      let manifest
      try { manifest = JSON.parse(bytes.toString('utf8')) } catch {
        throw new Error(`Task ${task.id} lifecycle archive manifest is invalid JSON`)
      }
      if (!onlyKeys(manifest, ['schemaVersion', 'taskId', 'snapshotCount', 'snapshots']) ||
          manifest.schemaVersion !== 1 || manifest.taskId !== task.id ||
          !Array.isArray(manifest.snapshots) || manifest.snapshotCount !== manifest.snapshots.length ||
          manifest.snapshotCount !== event.archivedSnapshotCount ||
          manifest.snapshotCount < 2 || manifest.snapshotCount > MAX_PRESERVED_SNAPSHOTS + 2) {
        throw new Error(`Task ${task.id} lifecycle archive manifest does not match its checkpoint event`)
      }
      const priorCount = manifest.snapshotCount - 2
      for (let index = 0; index < priorCount; index += 1) {
        const entry = manifest.snapshots[index]
        if (!onlyKeys(entry, ['kind', 'index', 'snapshot']) || entry.kind !== 'prior' || entry.index !== index) {
          throw new Error(`Task ${task.id} lifecycle archive snapshot sequence is invalid`)
        }
        validatePreservedSnapshot(entry.snapshot)
      }
      for (const [index, kind] of [[priorCount, 'work_preserved'], [priorCount + 1, 'deferred']]) {
        const entry = manifest.snapshots[index]
        if (!onlyKeys(entry, ['kind', 'snapshot']) || entry.kind !== kind) {
          throw new Error(`Task ${task.id} lifecycle archive snapshot sequence is invalid`)
        }
        validatePreservedSnapshot(entry.snapshot)
      }
      if (!preservationArchiveBytes(manifest).equals(bytes)) {
        throw new Error(`Task ${task.id} lifecycle archive manifest is not canonical`)
      }
    }
  }
}

async function resolvePreservationDeferral(state, taskId, archiveReference, repositoryRoot = REPOSITORY_ROOT) {
  const task = findTask(state, taskId)
  const { archivedSnapshotCount } = await verifyPreservationArchive(state, taskId, archiveReference, repositoryRoot)
  if (task.preservationArchiveRefs.length >= MAX_PRESERVATION_ARCHIVES) {
    throw new Error('Lifecycle archive reference history is full')
  }
  if (!Number.isSafeInteger(task.evidenceRevision + 1)) {
    throw new Error('Task evidence revision cannot be advanced safely')
  }
  const previousBlockerEvidenceRevision = task.blocker?.evidenceRevision ?? 0
  const latestSnapshot = clone(task.preservationDeferral.lifecycleSnapshot)

  task.preservationArchiveRefs.push(archiveReference)
  task.evidenceRevision += 1
  task.priorBlockerEvidenceRevision = previousBlockerEvidenceRevision
  task.workPreserved = latestSnapshot
  task.baseline = null
  task.implementation = null
  task.testResult = null
  task.assessments = Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null]))
  task.validation = null
  task.preservationDeferral = null
  task.blocker = null
  task.status = 'ready'
  appendEvent(state, {
    type: 'preservation_archived', taskId, evidenceRef: archiveReference,
    evidenceRevision: task.evidenceRevision, archivedSnapshotCount,
  })
  resumeOptimization(state, 'new_actionable_task', task.id)
  return task
}

function recordApproval(state, taskId, attestation) {
  const task = findTask(state, taskId)
  if (task.status !== 'awaiting_approval') throw new Error('Only tasks awaiting approval can be released')
  attestation = validateApprovalAttestation(attestation)
  task.status = 'ready'
  appendEvent(state, {
    type: 'approval_recorded', taskId, approverIdentity: attestation.approverIdentity,
    approverRole: attestation.approverRole, approvalEvidenceRef: attestation.approvalEvidenceRef,
    authorizedScopeRef: attestation.authorizedScopeRef, scopeCommitSha: attestation.scopeCommitSha,
  })
  resumeOptimization(state, 'required_approval', task.id)
  return task
}

function releaseStopGate(state, release) {
  const allowed = ['remediationEvidenceRef', 'authorizedScopeRef', 'scopeCommitSha', 'approvals']
  if (!onlyKeys(release, allowed) || !/^[a-f0-9]{40}$/.test(release.scopeCommitSha ?? '')) {
    throw new Error('Stop release requires remediation, exact reviewed scope, and structured approvals')
  }
  const gate = state.checkpoint.optimizationGate
  if (gate.status !== 'STOPPED' || !['security', 'correctness'].includes(gate.stopReason)) {
    throw new Error('Only security or correctness stops can be released through this transition')
  }
  validateStopReleaseAttestation({ ...release, reasonCode: gate.stopReason })
  if (state.checkpoint.selectedTaskId) throw new Error('Resolve the active task before releasing a global stop')
  const reasonCode = gate.stopReason
  gate.status = 'ACTIVE'
  gate.stopReason = null
  gate.consecutiveCleanAudits = 0
  gate.finalReport = null
  appendEvent(state, {
    type: 'stop_released', reasonCode, evidenceRef: release.remediationEvidenceRef,
    authorizedScopeRef: release.authorizedScopeRef, scopeCommitSha: release.scopeCommitSha,
    approvals: release.approvals.map(item => ({ ...item })),
  })
  return gate
}

function startNewCycle(state) {
  if (!state.checkpoint.pilotId) {
    throw new Error('Cannot start a cycle without an explicitly started pilot')
  }
  if (state.checkpoint.selectedTaskId) {
    throw new Error('Cannot start another cycle while the current task is active; resume or close it first')
  }
  if (state.checkpoint.cyclesStarted >= state.checkpoint.maxCycles) {
    stopForBudget(state)
    return { task: null, reason: 'cycle_limit_reached' }
  }
  const task = selectTask(state)
  if (!task) return { task: null, reason: 'no_actionable_task' }
  return { task, reason: 'selected' }
}

function resume(state) {
  if (!state.checkpoint.pilotId) {
    throw new Error('Cannot resume without an explicitly started pilot')
  }
  if (state.checkpoint.selectedTaskId) {
    return {
      task: findTask(state, state.checkpoint.selectedTaskId),
      reason: 'active_checkpoint_resumed',
    }
  }
  return startNewCycle(state)
}

function createPilot(state, { pilotId, maxCycles = MAX_CYCLES, pilotStartAuthorization } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pilotId ?? '') ||
      !Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_CYCLES) {
    throw new Error(`Pilot requires a safe id and maxCycles between 1 and ${MAX_CYCLES}`)
  }
  if (state.checkpoint.pilotId && state.checkpoint.selectedTaskId) {
    throw new Error('Cannot replace an active pilot checkpoint')
  }
  const previousCheckpoint = state.checkpoint
  const knownPilotIds = new Set([
    ...previousCheckpoint.archivedPilotHistory.flat().map(summary => summary.pilotId),
    ...previousCheckpoint.pilotHistory.map(summary => summary.pilotId),
    ...[...previousCheckpoint.eventArchives.flat(), ...previousCheckpoint.events]
      .filter(event => event.type === 'pilot_started' ||
        (event.type === 'pilot_prepared' && event.pilotId !== previousCheckpoint.preparedPilot?.pilotId))
      .map(event => event.pilotId),
    ...(previousCheckpoint.pilotId ? [previousCheckpoint.pilotId] : []),
  ])
  if (knownPilotIds.has(pilotId)) throw new Error('Pilot IDs must be unique across current and archived history')
  archivePriorPilotSummary(state.checkpoint, previousCheckpoint)
  const preservedEvents = [...previousCheckpoint.events]
  while (preservedEvents.length) {
    previousCheckpoint.eventArchives.push(preservedEvents.splice(0, MAX_EVENTS))
  }
  if (previousCheckpoint.optimizationGate?.status === 'STOPPED' &&
      previousCheckpoint.optimizationGate.stopReason === 'budget') {
    previousCheckpoint.optimizationGate.status = 'ACTIVE'
    previousCheckpoint.optimizationGate.stopReason = null
    previousCheckpoint.optimizationGate.consecutiveCleanAudits = 0
  }
  state.checkpoint = {
    pilotId,
    maxCycles,
    cyclesStarted: 0,
    cyclesValidated: 0,
    revision: previousCheckpoint.revision,
    selectedTaskId: null,
    previousTaskId: previousCheckpoint.previousTaskId,
    preparedPilot: null,
    pilotHistory: previousCheckpoint.pilotHistory,
    archivedPilotHistory: previousCheckpoint.archivedPilotHistory,
    eventArchives: previousCheckpoint.eventArchives,
    optimizationGate: previousCheckpoint.optimizationGate ?? {
      status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
      stopReason: null, finalReport: null, auditHistory: [],
    },
    mergeMode: pilotStartAuthorization?.mergeMode ?? 'manual',
    mergeAuthorization: pilotStartAuthorization?.mergeAuthorization
      ? clone(pilotStartAuthorization.mergeAuthorization) : null,
    events: [],
  }
  appendEvent(state, {
    type: 'pilot_started', pilotId, maxCycles,
    ...(pilotStartAuthorization ? { pilotStartAuthorization: clone(pilotStartAuthorization) } : {}),
  })
}

function preparePilot(state, { pilotId = `pilot-${crypto.randomBytes(6).toString('hex')}` } = {}) {
  const checkpoint = state.checkpoint
  if (checkpoint.preparedPilot) throw new Error('A pilot is already prepared; explicitly start or resolve it first')
  if (checkpoint.selectedTaskId) throw new Error('Cannot prepare a pilot while an optimization task is active')
  const events = [...checkpoint.eventArchives.flat(), ...checkpoint.events]
  const initialPilot = !checkpoint.pilotId && checkpoint.pilotHistory.length === 0 &&
    checkpoint.archivedPilotHistory.length === 0 && checkpoint.cyclesStarted === 0 &&
    !events.some(event => event.type === 'pilot_started')
  const terminal = initialPilot || (checkpoint.pilotId && checkpoint.selectedTaskId === null && (
    (checkpoint.optimizationGate.status === 'STOPPED' && checkpoint.optimizationGate.stopReason === 'budget') ||
    (checkpoint.optimizationGate.status === 'ACTIVE' && hasActionableRestartEvidence(checkpoint, state.tasks))
  ))
  if (!terminal) throw new Error('A new pilot can be prepared only after the current pilot reaches a terminal budget or exhaustion state')
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pilotId)) throw new Error('Prepared pilot ID is invalid')
  const knownPilotIds = new Set([
    ...checkpoint.archivedPilotHistory.flat().map(summary => summary.pilotId),
    ...checkpoint.pilotHistory.map(summary => summary.pilotId),
    ...[...checkpoint.eventArchives.flat(), ...checkpoint.events]
      .filter(event => ['pilot_started', 'pilot_prepared'].includes(event.type)).map(event => event.pilotId),
    ...(checkpoint.pilotId ? [checkpoint.pilotId] : []),
  ])
  if (knownPilotIds.has(pilotId)) throw new Error('Prepared pilot ID must be unique')
  checkpoint.preparedPilot = { pilotId, maxCycles: MAX_CYCLES, preparedAt: now() }
  appendEvent(state, { type: 'pilot_prepared', pilotId, maxCycles: MAX_CYCLES })
  return checkpoint.preparedPilot
}

function startPreparedPilot(state, attestation) {
  const prepared = state.checkpoint.preparedPilot
  if (!prepared) throw new Error('No pending pilot; prepare one before explicitly starting it')
  const pilotStartAuthorization = validatePilotStartAuthorization(attestation, prepared)
  createPilot(state, {
    pilotId: prepared.pilotId, maxCycles: prepared.maxCycles, pilotStartAuthorization,
  })
  return { checkpoint: state.checkpoint, started: true, selectedTask: null }
}

function activeMergeEvents(state) {
  return [...state.checkpoint.eventArchives.flat(), ...state.checkpoint.events].filter(event => event.pilotId === state.checkpoint.pilotId &&
    ['supervised_merge_decision', 'supervised_merge_completed', 'supervised_merge_revoked'].includes(event.type))
}

function revokeSupervisedMerges(state, evidenceRef, { currentTime = now() } = {}) {
  const authorization = state.checkpoint.mergeAuthorization
  if (state.checkpoint.mergeMode !== 'supervised_autonomous' || !authorization) {
    throw new Error('No supervised merge run is active')
  }
  if (authorization.status === 'revoked') throw new Error('Supervised merge authorization is already revoked')
  assertReference(evidenceRef)
  if (!evidenceRef.startsWith(`https://github.com/${authorization.repository}/`)) {
    throw new Error('Revocation evidence must belong to the authorized repository')
  }
  authorization.status = 'revoked'
  authorization.revokedAt = new Date(currentTime).toISOString()
  authorization.revocationEvidenceRef = evidenceRef
  appendEvent(state, { at: authorization.revokedAt, type: 'supervised_merge_revoked', mergeRecord: {
    authorizationId: authorization.authorizationId, evidenceRef, revokedAt: authorization.revokedAt,
  } })
  return { revoked: true, authorizationId: authorization.authorizationId, revokedAt: authorization.revokedAt }
}

function recordSupervisedMergeDecision(state, input) {
  const authorization = state.checkpoint.mergeAuthorization
  if (state.checkpoint.mergeMode !== 'supervised_autonomous' || !authorization) {
    throw new Error('Supervised merge decisions require an explicitly authorized supervised run')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Merge decision evidence must be a JSON object')
  const task = state.tasks.find(item => item.id === input?.taskId)
  if (!task) throw new Error('Decision must reference a real discovered task')
  const events = activeMergeEvents(state)
  const starts = [...state.checkpoint.eventArchives.flat(), ...state.checkpoint.events]
    .filter(event => event.type === 'selected' && event.pilotId === state.checkpoint.pilotId)
  const tasksSelected = new Set(starts.map(event => event.taskId)).size
  const selectedInRun = starts.some(event => event.taskId === task.id)
  const evidence = { ...input, repository: input.repository ?? authorization.repository,
    runId: state.checkpoint.pilotId }
  let result = task.status === 'validated' && selectedInRun
    ? evaluateSupervisedMerge({
      mode: state.checkpoint.mergeMode, authorization, evidence,
      pilotId: state.checkpoint.pilotId, maxCycles: state.checkpoint.maxCycles,
      cyclesStarted: state.checkpoint.cyclesStarted, tasksSelected,
    })
    : { eligible: false, reason: 'evidence_invalid', message: 'Task must complete implementation, tests, Reviewer, QA, quality/security, and benchmark validation in this run' }
  const previousUsage = events.filter(event => event.type === 'supervised_merge_decision' && event.mergeRecord.resourceUsage)
    .at(-1)?.mergeRecord.resourceUsage
  const usageGapRecorded = events.some(event => event.type === 'supervised_merge_decision' && !event.mergeRecord.resourceUsage)
  const currentUsage = evidence.resourceUsage
  if (usageGapRecorded) {
    result = { eligible: false, reason: 'budget_exhausted', message: 'An earlier decision lacks resource-usage evidence; this run is fail-closed for further merges' }
  } else if (previousUsage && (!currentUsage || currentUsage.ciRunsUsed < previousUsage.ciRunsUsed ||
      currentUsage.localBenchmarkMinutesUsed < previousUsage.localBenchmarkMinutesUsed ||
      currentUsage.paidWorkflowRuns < previousUsage.paidWorkflowRuns)) {
    result = { eligible: false, reason: 'budget_exhausted', message: 'Cumulative run resource usage cannot decrease or be omitted' }
  }
  if (result.eligible && evidence.headSha !== task.implementation?.commitSha) {
    result = { eligible: false, reason: 'evidence_invalid', message: 'Final PR head must equal the selected task implementation commit' }
  }
  const mergeRecord = sanitizeMergeDecisionRecord(state, evidence, result, null)
  const decisionDigest = digestCandidate(candidateEvidence(mergeRecord), mergeRecord.outcome, mergeRecord.reasonCode)
  if (events.some(event => event.type === 'supervised_merge_decision' && event.mergeRecord.decisionDigest === decisionDigest)) {
    throw new Error('Exact duplicate supervised merge evidence cannot be retried')
  }
  mergeRecord.decisionDigest = decisionDigest
  validateMergeDecisionRecord(mergeRecord, state.checkpoint.pilotId, authorization,
    state.checkpoint.cyclesStarted, tasksSelected, selectedInRun)
  appendEvent(state, { type: 'supervised_merge_decision', taskId: task.id, mergeRecord })
  return { ...result, taskId: task.id, prNumber: mergeRecord.prNumber, decisionDigest, decisionRecorded: true }
}

function recordSupervisedMergeResult(state, input, { currentTime = now() } = {}) {
  const authorization = state.checkpoint.mergeAuthorization
  if (state.checkpoint.mergeMode !== 'supervised_autonomous' || !authorization) {
    throw new Error('A supervised run is required to record a merge response')
  }
  if (authorization.policyDigest !== MERGE_POLICY_DIGEST) throw new Error('Policy changed since authorization; merge is blocked')
  const { taskId, prNumber, headSha, baseSha, decisionDigest, githubResponse } = input ?? {}
  const decisions = activeMergeEvents(state).filter(event => event.type === 'supervised_merge_decision' &&
    event.taskId === taskId && event.mergeRecord.prNumber === prNumber)
  const latest = decisions.at(-1)
  const prior = latest && latest.mergeRecord.outcome === 'eligible' &&
    latest.mergeRecord.decisionDigest === decisionDigest && latest.mergeRecord.headSha === headSha &&
    latest.mergeRecord.baseSha === baseSha ? latest : null
  if (!prior) throw new Error('The latest decision for this task and PR must be eligible and match its evidence digest and exact head/base')
  if (activeMergeEvents(state).some(event => event.type === 'supervised_merge_completed' &&
      event.mergeRecord.decisionDigest === decisionDigest)) throw new Error('This eligible decision already has a recorded merge result')
  if (!githubResponse || typeof githubResponse !== 'object' || Array.isArray(githubResponse) ||
      githubResponse.merged !== true || githubResponse.number !== prNumber ||
      githubResponse.headSha !== headSha || githubResponse.baseSha !== baseSha ||
      !/^[a-f0-9]{40}$/.test(githubResponse.mergeCommitSha ?? '') ||
      !Number.isFinite(Date.parse(githubResponse.mergedAt)) ||
      typeof githubResponse.message !== 'string' || !githubResponse.message.trim()) {
    throw new Error('A structured GitHub response confirming merged=true, PR, head, base, commit, and time is required')
  }
  const mergedAt = Date.parse(githubResponse.mergedAt)
  const revokedAt = authorization.status === 'revoked' ? Date.parse(authorization.revokedAt) : Infinity
  if (mergedAt <= Date.parse(prior.at) || mergedAt > Date.parse(authorization.expiresAt) || mergedAt >= revokedAt ||
      mergedAt > Date.parse(currentTime)) {
    throw new Error('GitHub merge must have occurred after the eligible decision, before expiry/revocation, and no later than this recording time')
  }
  const mergeRecord = {
    authorizationId: authorization.authorizationId, decisionDigest, repository: authorization.repository,
    runId: state.checkpoint.pilotId, taskId, prNumber, headSha, baseSha,
    mergeCommitSha: githubResponse.mergeCommitSha,
    mergeEvidenceRef: `https://github.com/${authorization.repository}/commit/${githubResponse.mergeCommitSha}`,
    mergedAt: githubResponse.mergedAt, githubMessage: githubResponse.message.trim().slice(0, 160),
  }
  validateMergeResultRecord(mergeRecord)
  appendEvent(state, { at: new Date(currentTime).toISOString(), type: 'supervised_merge_completed', taskId, mergeRecord })
  return { recorded: true, mergeCommitSha: mergeRecord.mergeCommitSha }
}

function addTask(state, taskInput) {
  if (taskInput?.initialStatus !== undefined) {
    throw new Error('Initial status is assigned by the orchestrator during task discovery')
  }
  if (taskInput?.status !== undefined && !['ready', 'awaiting_approval'].includes(taskInput.status)) {
    throw new Error('Discovered tasks must start ready or awaiting_approval')
  }
  if (taskInput?.preservationDeferral || taskInput?.preservationArchiveRefs?.length) {
    throw new Error('Lifecycle preservation metadata is assigned only by orchestrator transitions')
  }
  const task = validateTask(taskInput)
  if (state.tasks.some(item => item.id === task.id)) throw new Error(`Task already exists: ${task.id}`)
  if (state.tasks.some(item => item.investigationKey === task.investigationKey)) {
    throw new Error('This investigation already exists; add distinct evidence to its blocked task instead')
  }
  for (const dependency of task.dependencies) {
    if (!state.tasks.some(item => item.id === dependency)) throw new Error(`Unknown dependency: ${dependency}`)
  }
  state.tasks.push(task)
  appendEvent(state, {
    type: 'task_discovered', taskId: task.id, domain: task.domain, initialStatus: task.initialStatus,
  })
  if (task.status === 'ready') resumeOptimization(state, 'new_actionable_task', task.id)
  else if (task.status === 'awaiting_approval' && state.checkpoint.optimizationGate?.status === 'OPTIMIZATION_EXHAUSTED') {
    const gate = state.checkpoint.optimizationGate
    gate.status = 'BLOCKED'
    gate.consecutiveCleanAudits = 0
    gate.stopReason = 'approval'
    gate.finalReport = null
  }
  return task
}

function beginRun(state) {
  if (state.checkpoint.preparedPilot && state.checkpoint.optimizationGate.status === 'STOPPED') {
    throw new Error('A pilot is prepared but not started; use the explicit start-pilot transition')
  }
  if (!state.checkpoint.pilotId) {
    throw new Error(state.checkpoint.preparedPilot
      ? 'A pilot is prepared but not started; use the explicit start-pilot transition'
      : 'No active pilot; prepare and explicitly authorize a pilot before beginning')
  }
  return resume(state)
}

async function loadState(filePath = DEFAULT_STATE_PATH, repositoryRoot = REPOSITORY_ROOT) {
  const text = await fs.readFile(filePath, 'utf8')
  let state
  try { state = JSON.parse(text) } catch { throw new Error(`Invalid JSON in state file: ${filePath}`) }
  validateState(state)
  await verifyPersistedPreservationArchives(state, repositoryRoot)
  return state
}

async function saveState(filePath, state) {
  validateState(state)
  const target = path.resolve(filePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const lockPath = `${target}.lock`
  const recoveryPath = `${lockPath}.recovery`
  let lock
  const lockData = JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: now(), token: crypto.randomUUID() })
  let recovered = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = await fs.open(lockPath, 'wx')
      break
    } catch (error) {
      if (error.code !== 'EEXIST' || recovered) throw new Error('State is locked by another or ambiguous orchestrator process')
      const beforeStat = await fs.stat(lockPath).catch(() => null)
      if (!beforeStat) continue
      const beforeText = await fs.readFile(lockPath, 'utf8').catch(() => null)
      if (beforeText === null) throw new Error('State lock is ambiguous; inspect it manually before retrying')
      let owner
      try { owner = JSON.parse(beforeText) } catch { owner = null }
      let reclaimable = false
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string') {
        if (owner.host !== os.hostname()) throw new Error('State lock belongs to another host; refusing recovery')
        try {
          process.kill(owner.pid, 0)
          throw new Error('State is locked by a live orchestrator process')
        } catch (probeError) {
          if (probeError.message === 'State is locked by a live orchestrator process') throw probeError
          if (probeError.code === 'ESRCH') reclaimable = true
          else throw new Error('State lock owner cannot be proven dead; refusing recovery')
        }
      } else if (Date.now() - beforeStat.mtimeMs >= MALFORMED_LOCK_RECOVERY_MS) {
        reclaimable = true
      } else {
        throw new Error('Malformed state lock is too recent for safe recovery')
      }
      if (!reclaimable) throw new Error('State lock is ambiguous; refusing recovery')
      let recoveryLock
      try { recoveryLock = await fs.open(recoveryPath, 'wx') } catch (guardError) {
        if (guardError.code === 'EEXIST') throw new Error('State lock recovery is already in progress or needs operator recovery')
        throw guardError
      }
      let guardToken
      try {
        guardToken = crypto.randomUUID()
        await recoveryLock.writeFile(guardToken)
        await recoveryLock.sync()
        const [currentStat, currentText] = await Promise.all([
          fs.stat(lockPath).catch(() => null), fs.readFile(lockPath, 'utf8').catch(() => null),
        ])
        const sameFile = currentStat && currentText === beforeText && currentStat.dev === beforeStat.dev &&
          currentStat.ino === beforeStat.ino && currentStat.size === beforeStat.size &&
          currentStat.mtimeMs === beforeStat.mtimeMs && currentStat.ctimeMs === beforeStat.ctimeMs
        if (sameFile) await fs.unlink(lockPath)
        else throw new Error('State lock changed during recovery; refusing to remove it')
      } finally {
        const ownedGuard = await recoveryLock.stat().catch(() => null)
        await recoveryLock.close().catch(() => {})
        const currentGuardStat = await fs.lstat(recoveryPath).catch(() => null)
        const currentGuardText = await fs.readFile(recoveryPath, 'utf8').catch(() => null)
        if (ownedGuard && currentGuardStat && !currentGuardStat.isSymbolicLink() &&
            currentGuardStat.dev === ownedGuard.dev && currentGuardStat.ino === ownedGuard.ino &&
            guardToken && currentGuardText === guardToken) {
          await fs.unlink(recoveryPath).catch(() => {})
        }
      }
      recovered = true
    }
  }
  if (!lock) throw new Error('Unable to acquire state lock')
  const tempPath = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await lock.writeFile(lockData)
    let diskRevision = 0
    try {
      const current = JSON.parse(await fs.readFile(target, 'utf8'))
      diskRevision = current.checkpoint?.revision ?? 0
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot verify checkpoint revision; refusing to overwrite state')
    }
    if (diskRevision !== state.checkpoint.revision) {
      throw new Error(`Stale checkpoint revision ${state.checkpoint.revision}; current revision is ${diskRevision}`)
    }
    state.checkpoint.revision += 1
    validateState(state)
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(tempPath, target)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    await lock.close().catch(() => {})
    const current = await fs.readFile(lockPath, 'utf8').catch(() => null)
    if (current === lockData) await fs.rm(lockPath, { force: true }).catch(() => {})
  }
}

async function initialize(filePath = DEFAULT_STATE_PATH, { overwrite = false } = {}) {
  if (!overwrite) {
    try { await fs.access(filePath); throw new Error(`State already exists: ${filePath}`) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const state = createInitialState()
  await saveState(filePath, state)
  return state
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function cli(argv) {
  const [command, ...rawArgs] = argv
  let filePath = DEFAULT_STATE_PATH
  const args = [...rawArgs]
  const stateIndex = args.indexOf('--state')
  if (stateIndex !== -1) {
    if (!args[stateIndex + 1]) throw new Error('--state requires a path')
    filePath = path.resolve(args[stateIndex + 1])
    args.splice(stateIndex, 2)
  }

  if (command === 'init') return print(await initialize(filePath))
  const state = await loadState(filePath)
  let result
  if (command === 'status') {
    return print({ checkpoint: state.checkpoint, taskCounts: Object.fromEntries(TASK_STATUSES.map(status => [
      status, state.tasks.filter(task => task.status === status).length,
    ])), domains: state.domains })
  }
  if (command === 'begin') {
    result = beginRun(state)
  } else if (command === 'resume') {
    result = resume(state)
  } else if (command === 'new-cycle') {
    result = startNewCycle(state)
  } else if (command === 'prepare-pilot') {
    result = preparePilot(state, { pilotId: args[0] })
  } else if (command === 'start-pilot') {
    let authorization
    try { authorization = JSON.parse(args[0] ?? '') } catch { throw new Error('start-pilot requires a JSON authorization attestation') }
    result = startPreparedPilot(state, authorization)
  } else if (command === 'revoke-supervised-merges') {
    if (args.length !== 1) throw new Error('revoke-supervised-merges requires a GitHub evidence URL')
    result = revokeSupervisedMerges(state, args[0])
  } else if (command === 'record-supervised-merge') {
    let evidence
    try { evidence = JSON.parse(args[0] ?? '') } catch { throw new Error('record-supervised-merge requires one JSON evidence record') }
    result = recordSupervisedMergeDecision(state, evidence)
  } else if (command === 'record-supervised-merge-result') {
    let response
    try { response = JSON.parse(args[0] ?? '') } catch { throw new Error('record-supervised-merge-result requires one structured JSON GitHub response record') }
    result = recordSupervisedMergeResult(state, response)
  } else if (command === 'add-task') {
    result = addTask(state, JSON.parse(args[0] ?? 'null'))
  } else if (command === 'baseline') {
    result = recordBaseline(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'implement') {
    result = recordImplementation(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'tests') {
    result = recordTests(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'diagnose-recovery') {
    result = recordRecoveryDiagnosis(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'recovery-attempt') {
    result = recordRecoveryAttempt(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'assess') {
    result = recordAssessment(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'benchmark') {
    result = recordBenchmark(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'block') {
    result = blockTask(state, args[0], args[1], args[2])
  } else if (command === 'evidence') {
    result = recordNewEvidence(state, args[0], args[1])
  } else if (command === 'archive-preserved') {
    if (!args[0] || args.length !== 1) throw new Error('archive-preserved requires only the blocked task ID')
    const archiveReference = await createPreservationArchive(state, args[0])
    result = await resolvePreservationDeferral(state, args[0], archiveReference)
  } else if (command === 'approve') {
    let attestation
    try { attestation = JSON.parse(args[1] ?? '') } catch { throw new Error('approve requires a JSON attestation argument') }
    result = recordApproval(state, args[0], attestation)
  } else if (command === 'audit') {
    let audit
    try { audit = JSON.parse(args[0] ?? '') } catch { throw new Error('audit requires one JSON metadata argument') }
    result = recordOptimizationAudit(state, audit)
  } else if (command === 'release-stop') {
    let release
    try { release = JSON.parse(args[0] ?? '') } catch { throw new Error('release-stop requires one JSON metadata argument') }
    result = releaseStopGate(state, release)
  } else {
    throw new Error('Usage: init|status|begin|resume|new-cycle|prepare-pilot|start-pilot|revoke-supervised-merges|record-supervised-merge|record-supervised-merge-result|add-task|baseline|implement|tests|diagnose-recovery|recovery-attempt|assess|benchmark|block|evidence|archive-preserved|approve|audit|release-stop [--state path]')
  }
  await saveState(filePath, state)
  return print(result)
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Optimization orchestrator: ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  AUDIT_DIMENSIONS, AUDIT_ROLES, BLOCKERS, DEFAULT_STATE_PATH, DOMAINS, MAX_CYCLES, TASK_STATUSES,
  addTask, beginRun, blockTask, createInitialState, preparePilot, startPreparedPilot,
  revokeSupervisedMerges, recordSupervisedMergeDecision, recordSupervisedMergeResult,
  recordAssessment, recordBaseline, recordBenchmark, recordImplementation,
  recordApproval, recordNewEvidence, recordOptimizationAudit, recordRecoveryAttempt, recordRecoveryDiagnosis,
  createPreservationArchive, resolvePreservationDeferral,
  recordTests, rejectTask, releaseStopGate, resume, saveState, loadState, selectNextTask,
  selectTask, startNewCycle, taskValue, validateState, validateTask,
}
