'use strict'

// Safe, deterministic state manager for Coordinator-led optimization cycles.
// This tool records work and chooses tasks; it never executes task commands,
// calls models, writes GitHub, commits, merges, deploys, or provisions resources.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const SCHEMA_VERSION = 1
const MAX_CYCLES = 10
const MAX_EVENTS = 500
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
  'environment_failure', 'other',
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

const DEFAULT_STATE_PATH = path.resolve(__dirname, '../../docs/autonomy/optimization-state.json')

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
      selectedTaskId: null,
      previousTaskId: null,
      optimizationGate: {
        status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
        stopReason: null, finalReport: null, auditHistory: [],
      },
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
        (!Number.isSafeInteger(task.priorBlockerEvidenceRevision) || task.priorBlockerEvidenceRevision < 0))) {
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
        if (!onlyKeys(assessment, ['passed', 'evidenceRef']) || typeof assessment.passed !== 'boolean') {
          throw new Error('Invalid role assessment result')
        }
        assertReference(assessment.evidenceRef)
      }
    }
  }
  if (task.blocker !== undefined && task.blocker !== null) {
    if (!onlyKeys(task.blocker, ['code', 'evidenceRef', 'evidenceRevision', 'recordedAt']) ||
        !BLOCKERS.includes(task.blocker.code) ||
        !Number.isSafeInteger(task.blocker.evidenceRevision) || task.blocker.evidenceRevision < 0 ||
        typeof task.blocker.recordedAt !== 'string') throw new Error('Invalid blocker record')
    if (task.blocker.evidenceRef !== null) assertReference(task.blocker.evidenceRef)
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
    if (!onlyKeys(task.workPreserved, ['baseline', 'implementation', 'testResult', 'assessments', 'validation'])) {
      throw new Error('Invalid preserved-work record')
    }
    if (task.workPreserved.baseline !== null) {
      const baseline = task.workPreserved.baseline
      if (!onlyKeys(baseline, ['metric', 'evidenceRef']) || !Number.isFinite(baseline.metric)) {
        throw new Error('Invalid preserved baseline')
      }
      assertReference(baseline.evidenceRef)
    }
    if (task.workPreserved.implementation !== null) {
      const implementation = task.workPreserved.implementation
      if (!onlyKeys(implementation, ['branch', 'commitSha']) ||
          !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(implementation.branch ?? '') ||
          !/^[a-f0-9]{40}$/.test(implementation.commitSha ?? '')) {
        throw new Error('Invalid preserved implementation')
      }
    }
    if (task.workPreserved.testResult !== undefined && task.workPreserved.testResult !== null) {
      if (!onlyKeys(task.workPreserved.testResult, ['passed', 'evidenceRef']) ||
          typeof task.workPreserved.testResult.passed !== 'boolean') throw new Error('Invalid preserved test result')
      assertReference(task.workPreserved.testResult.evidenceRef)
    }
    if (!onlyKeys(task.workPreserved.assessments, ASSESSMENT_ROLES) ||
        (task.workPreserved.validation !== null &&
          !onlyKeys(task.workPreserved.validation,
            ['baselineMetric', 'resultMetric', 'regression', 'evidenceRef', 'accepted', 'reasonCode']))) {
      throw new Error('Invalid preserved assessment or validation record')
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
    investigationKey: task.investigationKey ?? task.id,
    baseline: task.baseline ?? null,
    implementation: task.implementation ?? null,
    testResult: task.testResult ?? null,
    assessments: task.assessments ?? Object.fromEntries(ASSESSMENT_ROLES.map(role => [role, null])),
    validation: task.validation ?? null,
    blocker: task.blocker ?? null,
    workPreserved: task.workPreserved ?? null,
    evidenceRevision: Number.isSafeInteger(task.evidenceRevision) ? task.evidenceRevision : 0,
    priorBlockerEvidenceRevision: Number.isSafeInteger(task.priorBlockerEvidenceRevision)
      ? task.priorBlockerEvidenceRevision : null,
  }
}

function validateState(state) {
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
  const eventTypes = new Set([
    'pilot_started', 'task_discovered', 'selected', 'baseline', 'implemented',
    'tests_passed', 'reviewer_passed', 'qa_passed', 'quality_passed', 'security_passed',
    'validated', 'rejected', 'blocked', 'new_evidence', 'approval_recorded', 'optimization_resumed',
    'audit_completed', 'gate_stopped', 'stop_released',
  ])
  const eventKeys = [
    'at', 'type', 'pilotId', 'maxCycles', 'taskId', 'cycle', 'domain', 'metric',
    'evidenceRef', 'branch', 'commitSha', 'reasonCode', 'blockerCode',
    'evidenceRevision', 'resultMetric',
    'auditStatus', 'consecutiveCleanAudits', 'actionableCount', 'blockedCount', 'auditedDimensions', 'specialistRoles',
    'auditId', 'auditEvidenceRefs', 'specialistAssessments', 'awaitingApprovalCount',
    'reviewerEvidenceRef', 'qaEvidenceRef', 'securityEvidenceRef', 'aiQualityEvidenceRef', 'scopeReviewed',
  ]
  for (const event of state.checkpoint.events) {
    if (!onlyKeys(event, eventKeys) || !eventTypes.has(event.type) ||
        typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) {
      throw new Error('Invalid checkpoint event')
    }
    if (event.taskId && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(event.taskId)) {
      throw new Error('Invalid task ID in checkpoint event')
    }
    if (event.domain && !DOMAINS.includes(event.domain)) throw new Error('Invalid domain in checkpoint event')
    if (event.blockerCode && !BLOCKERS.includes(event.blockerCode)) throw new Error('Invalid blocker in checkpoint event')
    if (event.evidenceRef) assertReference(event.evidenceRef)
    if (event.reviewerEvidenceRef) assertReference(event.reviewerEvidenceRef)
    if (event.qaEvidenceRef) assertReference(event.qaEvidenceRef)
    if (event.securityEvidenceRef) assertReference(event.securityEvidenceRef)
    if (event.aiQualityEvidenceRef) assertReference(event.aiQualityEvidenceRef)
    if (event.branch && !/^codex\/[a-z0-9][a-z0-9-]{1,80}$/.test(event.branch)) {
      throw new Error('Invalid branch in checkpoint event')
    }
    if (event.commitSha && !/^[a-f0-9]{40}$/.test(event.commitSha)) {
      throw new Error('Invalid commit SHA in checkpoint event')
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
      if (!['security', 'correctness'].includes(event.reasonCode) || event.scopeReviewed !== true ||
          !event.evidenceRef || !event.reviewerEvidenceRef || !event.qaEvidenceRef || !event.securityEvidenceRef ||
          (event.reasonCode === 'correctness' && !event.aiQualityEvidenceRef) ||
          (event.reasonCode === 'security' && event.aiQualityEvidenceRef !== undefined)) {
        throw new Error('Stop release event lacks required independent evidence')
      }
    } else if (event.auditedDimensions !== undefined || event.specialistRoles !== undefined) {
      throw new Error('Incomplete or invalid audit dimensions in event')
    }
    for (const countKey of ['consecutiveCleanAudits', 'actionableCount', 'blockedCount']) {
      if (event[countKey] !== undefined && (!Number.isSafeInteger(event[countKey]) || event[countKey] < 0)) {
        throw new Error('Invalid exhaustion audit count')
      }
    }
  }
  const persistedAuditEvents = state.checkpoint.events.filter(event =>
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
  if (['quality_security_passed', 'validated'].includes(task.status) &&
      (task.assessments.quality?.passed !== true || task.assessments.security?.passed !== true)) {
    throw new Error(`Task ${task.id} lifecycle lacks quality and security passes`)
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
  if (task.status === 'blocked' && (JSON.stringify(task.workPreserved.baseline) !== JSON.stringify(task.baseline) ||
      JSON.stringify(task.workPreserved.implementation) !== JSON.stringify(task.implementation) ||
      JSON.stringify(task.workPreserved.assessments) !== JSON.stringify(task.assessments) ||
      JSON.stringify(task.workPreserved.validation) !== JSON.stringify(task.validation) ||
      (task.workPreserved.testResult !== undefined &&
       JSON.stringify(task.workPreserved.testResult) !== JSON.stringify(task.testResult)))) {
    throw new Error(`Task ${task.id} blocked state does not match preserved work`)
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
    throw new Error('Event log limit reached; archive the checkpoint before continuing')
  }
  state.checkpoint.events.push({ at: now(), ...event })
  state.updatedAt = now()
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
  if (state.checkpoint.cyclesStarted >= state.checkpoint.maxCycles) {
    stopForBudget(state)
    return null
  }
  if (state.checkpoint.selectedTaskId) {
    const current = state.tasks.find(task => task.id === state.checkpoint.selectedTaskId)
    if (current && ['selected', 'baseline_established', 'implementing', 'implemented',
      'tests_passed', 'reviewed', 'qa_passed', 'quality_security_passed'].includes(current.status)) {
      return current
    }
    state.checkpoint.selectedTaskId = null
  }
  const task = selectNextTask(state, {
    excludeTaskIds: [],
  })
  if (!task) return null
  task.status = 'selected'
  state.checkpoint.previousTaskId = task.id
  state.checkpoint.selectedTaskId = task.id
  state.checkpoint.cyclesStarted += 1
  appendEvent(state, { type: 'selected', taskId: task.id, cycle: state.checkpoint.cyclesStarted })
  if (task.benchmarkCost === 'expensive') {
    const fallback = blockTask(state, task.id, 'benchmark_expensive', task.benchmarkRefs[0] ?? null)
    return fallback.next
  }
  return task
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
    return rejectTask(state, taskId, 'tests_failed', artifactRef)
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

function recordAssessment(state, taskId, { role, passed, artifactRef }) {
  const task = requireSelected(state, taskId)
  if (task.status !== 'tests_passed' && task.status !== 'reviewed' && task.status !== 'qa_passed') {
    throw new Error('Independent assessments require passing focused tests')
  }
  if (!['reviewer', 'qa', 'quality', 'security'].includes(role) || typeof passed !== 'boolean') {
    throw new Error('Assessment role/result is invalid')
  }
  assertReference(artifactRef)
  task.assessments[role] = { passed, evidenceRef: artifactRef }
  if (!passed) return rejectTask(state, taskId, `${role}_rejected`, artifactRef)
  if (task.assessments.reviewer?.passed && task.assessments.qa?.passed) task.status = 'reviewed'
  if (task.assessments.quality?.passed && task.assessments.security?.passed) {
    if (task.status !== 'reviewed') throw new Error('Quality/security checks require Reviewer and QA passes')
    task.status = 'quality_security_passed'
  } else if (task.assessments.reviewer?.passed && task.assessments.qa?.passed) {
    task.status = 'qa_passed'
  }
  appendEvent(state, { type: `${role}_${passed ? 'passed' : 'rejected'}`, taskId, evidenceRef: artifactRef })
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
  task.status = 'blocked'
  task.blocker = {
    code: blockerCode,
    evidenceRef: evidenceRef ?? null,
    evidenceRevision: task.evidenceRevision,
    recordedAt: now(),
  }
  task.workPreserved = {
    baseline: clone(task.baseline),
    implementation: clone(task.implementation),
    testResult: clone(task.testResult),
    assessments: clone(task.assessments),
    validation: clone(task.validation),
  }
  state.checkpoint.selectedTaskId = null
  state.checkpoint.previousTaskId = task.id
  appendEvent(state, { type: 'blocked', taskId, blockerCode, evidenceRef: evidenceRef ?? null })
  const next = selectTask(state)
  return { blocked: task, next }
}

function recordNewEvidence(state, taskId, evidenceRef) {
  const task = findTask(state, taskId)
  if (task.status !== 'blocked') throw new Error('Only blocked tasks can receive unblock evidence')
  assertReference(evidenceRef)
  if (task.evidenceRefs.includes(evidenceRef) || task.blocker?.evidenceRef === evidenceRef) {
    throw new Error('New evidence must be distinct from all evidence already recorded for this task')
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

function recordApproval(state, taskId, evidenceRef) {
  const task = findTask(state, taskId)
  if (task.status !== 'awaiting_approval') throw new Error('Only tasks awaiting approval can be released')
  assertReference(evidenceRef)
  task.status = 'ready'
  appendEvent(state, { type: 'approval_recorded', taskId, evidenceRef })
  resumeOptimization(state, 'required_approval', task.id)
  return task
}

function releaseStopGate(state, release) {
  const allowed = ['evidenceRef', 'reviewerEvidenceRef', 'qaEvidenceRef', 'securityEvidenceRef',
    'aiQualityEvidenceRef', 'scopeReviewed']
  if (!onlyKeys(release, allowed) || release.scopeReviewed !== true) {
    throw new Error('Stop release requires remediation evidence, independent approvals, and safe-scope review')
  }
  const gate = state.checkpoint.optimizationGate
  if (gate.status !== 'STOPPED' || !['security', 'correctness'].includes(gate.stopReason)) {
    throw new Error('Only security or correctness stops can be released through this transition')
  }
  if (!release.reviewerEvidenceRef || !release.qaEvidenceRef || !release.securityEvidenceRef ||
      (gate.stopReason === 'correctness' && !release.aiQualityEvidenceRef) ||
      (gate.stopReason === 'security' && release.aiQualityEvidenceRef !== undefined)) {
    throw new Error('Stop release requires Reviewer, QA, and Security evidence, plus AI Quality for correctness')
  }
  const refs = [release.evidenceRef, release.reviewerEvidenceRef, release.qaEvidenceRef, release.securityEvidenceRef,
    ...(release.aiQualityEvidenceRef ? [release.aiQualityEvidenceRef] : [])]
  refs.forEach(assertReference)
  if (new Set(refs).size !== refs.length) throw new Error('Stop release requires distinct remediation and assessment evidence')
  if (state.checkpoint.selectedTaskId) throw new Error('Resolve the active task before releasing a global stop')
  const reasonCode = gate.stopReason
  gate.status = 'ACTIVE'
  gate.stopReason = null
  gate.consecutiveCleanAudits = 0
  gate.finalReport = null
  appendEvent(state, {
    type: 'stop_released', reasonCode, evidenceRef: release.evidenceRef,
    reviewerEvidenceRef: release.reviewerEvidenceRef, qaEvidenceRef: release.qaEvidenceRef,
    securityEvidenceRef: release.securityEvidenceRef,
    ...(release.aiQualityEvidenceRef ? { aiQualityEvidenceRef: release.aiQualityEvidenceRef } : {}),
    scopeReviewed: true,
  })
  return gate
}

function startNewCycle(state) {
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
  if (state.checkpoint.selectedTaskId) {
    return {
      task: findTask(state, state.checkpoint.selectedTaskId),
      reason: 'active_checkpoint_resumed',
    }
  }
  return startNewCycle(state)
}

function createPilot(state, { pilotId, maxCycles = MAX_CYCLES } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pilotId ?? '') ||
      !Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_CYCLES) {
    throw new Error(`Pilot requires a safe id and maxCycles between 1 and ${MAX_CYCLES}`)
  }
  if (state.checkpoint.pilotId && state.checkpoint.selectedTaskId) {
    throw new Error('Cannot replace an active pilot checkpoint')
  }
  const previousCheckpoint = state.checkpoint
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
    selectedTaskId: null,
    previousTaskId: previousCheckpoint.previousTaskId,
    optimizationGate: previousCheckpoint.optimizationGate ?? {
      status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
      stopReason: null, finalReport: null, auditHistory: [],
    },
    events: [...previousCheckpoint.events],
  }
  appendEvent(state, { type: 'pilot_started', pilotId, maxCycles })
}

function addTask(state, taskInput) {
  if (taskInput?.status !== undefined && !['ready', 'awaiting_approval'].includes(taskInput.status)) {
    throw new Error('Discovered tasks must start ready or awaiting_approval')
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
  appendEvent(state, { type: 'task_discovered', taskId: task.id, domain: task.domain })
  if (task.status === 'ready') resumeOptimization(state, 'new_actionable_task', task.id)
  return task
}

function beginRun(state) {
  if (!state.checkpoint.pilotId) {
    createPilot(state, { pilotId: `pilot-${crypto.randomBytes(4).toString('hex')}`, maxCycles: MAX_CYCLES })
  }
  return resume(state)
}

async function loadState(filePath = DEFAULT_STATE_PATH) {
  const text = await fs.readFile(filePath, 'utf8')
  let state
  try { state = JSON.parse(text) } catch { throw new Error(`Invalid JSON in state file: ${filePath}`) }
  return validateState(state)
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
      try {
        const [currentStat, currentText] = await Promise.all([
          fs.stat(lockPath).catch(() => null), fs.readFile(lockPath, 'utf8').catch(() => null),
        ])
        const sameFile = currentStat && currentText === beforeText && currentStat.dev === beforeStat.dev &&
          currentStat.ino === beforeStat.ino && currentStat.size === beforeStat.size &&
          currentStat.mtimeMs === beforeStat.mtimeMs && currentStat.ctimeMs === beforeStat.ctimeMs
        if (sameFile) await fs.unlink(lockPath)
        else throw new Error('State lock changed during recovery; refusing to remove it')
      } finally {
        await recoveryLock.close().catch(() => {})
        await fs.rm(recoveryPath, { force: true }).catch(() => {})
      }
      recovered = true
    }
  }
  if (!lock) throw new Error('Unable to acquire state lock')
  const tempPath = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await lock.writeFile(lockData)
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
  } else if (command === 'add-task') {
    result = addTask(state, JSON.parse(args[0] ?? 'null'))
  } else if (command === 'baseline') {
    result = recordBaseline(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'implement') {
    result = recordImplementation(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'tests') {
    result = recordTests(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'assess') {
    result = recordAssessment(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'benchmark') {
    result = recordBenchmark(state, args[0], JSON.parse(args[1] ?? 'null'))
  } else if (command === 'block') {
    result = blockTask(state, args[0], args[1], args[2])
  } else if (command === 'evidence') {
    result = recordNewEvidence(state, args[0], args[1])
  } else if (command === 'approve') {
    result = recordApproval(state, args[0], args[1])
  } else if (command === 'audit') {
    let audit
    try { audit = JSON.parse(args[0] ?? '') } catch { throw new Error('audit requires one JSON metadata argument') }
    result = recordOptimizationAudit(state, audit)
  } else if (command === 'release-stop') {
    let release
    try { release = JSON.parse(args[0] ?? '') } catch { throw new Error('release-stop requires one JSON metadata argument') }
    result = releaseStopGate(state, release)
  } else {
    throw new Error('Usage: init|status|begin|resume|new-cycle|add-task|baseline|implement|tests|assess|benchmark|block|evidence|approve|audit|release-stop [--state path]')
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
  addTask, beginRun, blockTask, createInitialState, createPilot,
  recordAssessment, recordBaseline, recordBenchmark, recordImplementation,
  recordApproval, recordNewEvidence, recordOptimizationAudit, recordTests, rejectTask, releaseStopGate, resume, saveState, selectNextTask,
  selectTask, startNewCycle, taskValue, validateState, validateTask,
}

