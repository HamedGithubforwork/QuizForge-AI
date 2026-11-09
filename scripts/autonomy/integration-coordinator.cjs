'use strict'

// Durable, bounded state machine for Coordinator-led multi-task integration.
// It records/selects work only; it never runs commands or mutates GitHub.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const SCHEMA_VERSION = 1
const MAX_TASKS = 100
const MAX_SELECTIONS = 50
const MAX_ATTEMPTS = 3 // one initial attempt plus at most two retries
const MAX_EVENTS = 1000
const MALFORMED_LOCK_RECOVERY_MS = 24 * 60 * 60 * 1000
const BLOCKER_CODES = Object.freeze([
  'approval_required', 'existing_pr', 'unavailable_evidence', 'tooling_unavailable',
  'external_dependency', 'environment_failure', 'other',
])
const REJECTION_CODES = Object.freeze([
  'no_measurable_improvement', 'regression', 'duplicate_work', 'superseded', 'scope_invalid', 'other',
])
const TASK_STATUSES = Object.freeze([
  'ready', 'awaiting_approval', 'running', 'completed', 'blocked', 'rejected',
])
const WORKFLOW_STATUSES = Object.freeze(['active', 'blocked', 'budget_reached', 'completed'])
const DEFAULT_CHECKPOINT = path.resolve(__dirname, '../../docs/autonomy/integration-checkpoint.json')
const TASK_KEYS = new Set([
  'id', 'title', 'kind', 'priority', 'dependencies', 'candidateHeadSha', 'evidenceRefs',
  'status', 'pr', 'approval', 'attempts', 'blockerCode', 'retryExhausted', 'result', 'rejection',
])
const TASK_REQUIRED_KEYS = Object.freeze([
  'id', 'title', 'kind', 'priority', 'dependencies', 'evidenceRefs', 'status',
  'pr', 'approval', 'attempts', 'blockerCode', 'retryExhausted', 'result', 'rejection',
])
const EVIDENCE_URLS = Object.freeze([
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/,
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]{40}$/,
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/,
])
const EVIDENCE_PATH = /^(?:docs|scripts|backend|frontend|desktop|\.github)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|json|ya?ml|txt|cjs|mjs|js|ts|tsx|jsx|py|toml|csv|ps1|sh)(?:#[A-Za-z0-9_-]+)?$/i
const EVENT_FIELDS = Object.freeze({
  historical_merge_confirmed: ['sequence', 'type', 'taskId', 'evidenceRef', 'headSha', 'targetBranch'],
  task_selected: ['sequence', 'type', 'taskId', 'attempt', 'selection', 'candidateHeadSha'],
  task_completed: ['sequence', 'type', 'taskId', 'evidenceRef', 'commitSha'],
  task_blocked: ['sequence', 'type', 'taskId', 'blockerCode', 'evidenceRef', 'retryExhausted'],
  task_rejected: ['sequence', 'type', 'taskId', 'reasonCode', 'evidenceRef'],
  task_retry_authorized: ['sequence', 'type', 'taskId', 'evidenceRef'],
  merge_authorized: ['sequence', 'type', 'taskId', 'evidenceRef', 'headSha', 'baseSha'],
  merge_scope_changed: ['sequence', 'type', 'taskId', 'previous', 'current'],
})

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function requireText(value, name, max = 240) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) {
    throw new Error(`${name} must be a nonempty trimmed string of at most ${max} characters`)
  }
  return value
}

function validateBranchRef(reference, name = 'Branch ref') {
  if (typeof reference !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(reference) ||
      reference.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`${name} is malformed or contains path traversal`)
  }
  return reference
}

function assertEvidenceRef(reference, name = 'Evidence reference') {
  if (typeof reference !== 'string' || reference.length > 240 || reference.trim() !== reference) {
    throw new Error(`${name} is not an allowlisted reference`)
  }
  if (EVIDENCE_URLS.some(pattern => pattern.test(reference))) return reference
  if (EVIDENCE_PATH.test(reference)) {
    const normalized = reference.split('#')[0]
    if (normalized.split('/').some(part => part === '.' || part === '..')) {
      throw new Error(`${name} cannot contain path traversal`)
    }
    return reference
  }
  throw new Error(`${name} is not an allowlisted GitHub URL or repository-relative evidence path`)
}

function validateEvidenceTree(value, key = '') {
  if (value == null) return
  if (key === 'evidenceRef' || key === 'approvalEvidenceRef') assertEvidenceRef(value)
  if (key === 'evidenceRefs') {
    if (!Array.isArray(value)) throw new Error('Persisted evidenceRefs must be an array')
    for (const reference of value) assertEvidenceRef(reference)
  }
  if (Array.isArray(value)) {
    for (const item of value) validateEvidenceTree(item)
    return
  }
  if (typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) validateEvidenceTree(child, childKey)
  }
}

function validatePr(pr) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('Merge task requires exact PR scope')
  const prKeys = new Set([
    'repository', 'number', 'baseRef', 'baseSha', 'reportedBaseSha', 'liveTargetSha', 'baseShaNote',
    'mergeable', 'headSha', 'state', 'draft', 'checkedOn', 'mergeCommitSha', 'url',
  ])
  if (Object.keys(pr).some(key => !prKeys.has(key))) throw new Error('PR scope contains unsupported fields')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.repository ?? '') ||
      !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      typeof pr.baseRef !== 'string' ||
      (pr.baseSha !== undefined && !/^[a-f0-9]{40}$/.test(pr.baseSha)) ||
      (pr.reportedBaseSha !== undefined && !/^[a-f0-9]{40}$/.test(pr.reportedBaseSha)) ||
      (pr.liveTargetSha !== undefined && !/^[a-f0-9]{40}$/.test(pr.liveTargetSha)) ||
      (pr.baseShaNote !== undefined && pr.baseShaNote !== 'api_base_differs_from_live_target_requires_refresh') ||
      (pr.mergeable !== undefined && typeof pr.mergeable !== 'boolean') ||
      !/^[a-f0-9]{40}$/.test(pr.headSha ?? '') ||
      (pr.state !== undefined && !['open', 'closed', 'merged'].includes(pr.state)) ||
      (pr.draft !== undefined && typeof pr.draft !== 'boolean') ||
      (pr.checkedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(pr.checkedOn)) ||
      (pr.mergeCommitSha !== undefined && !/^[a-f0-9]{40}$/.test(pr.mergeCommitSha)) ||
      (pr.state === 'merged' && !/^[a-f0-9]{40}$/.test(pr.mergeCommitSha ?? '')) ||
      typeof pr.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr.url)) {
    throw new Error('Merge task PR scope must include repository, number, base, exact head SHA, and PR URL')
  }
  validateBranchRef(pr.baseRef, 'PR target branch')
  const urlMatch = pr.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/)
  if (urlMatch[1].toLowerCase() !== pr.repository.toLowerCase() || Number(urlMatch[2]) !== pr.number) {
    throw new Error('PR URL does not match the recorded repository and number')
  }
  return {
    repository: pr.repository, number: pr.number, baseRef: pr.baseRef,
    ...(pr.baseSha ? { baseSha: pr.baseSha } : {}), headSha: pr.headSha, url: pr.url,
    ...(pr.reportedBaseSha ? { reportedBaseSha: pr.reportedBaseSha } : {}),
    ...(pr.liveTargetSha ? { liveTargetSha: pr.liveTargetSha } : {}),
    ...(pr.baseShaNote ? { baseShaNote: pr.baseShaNote } : {}),
    ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable } : {}),
    ...(pr.state ? { state: pr.state } : {}),
    ...(pr.draft !== undefined ? { draft: pr.draft } : {}),
    ...(pr.checkedOn ? { checkedOn: pr.checkedOn } : {}),
    ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
  }
}

function validateEventRecord(item, sequence, taskIds) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.sequence !== sequence ||
      typeof item.type !== 'string' || !Object.hasOwn(EVENT_FIELDS, item.type) ||
      Object.keys(item).some(key => !EVENT_FIELDS[item.type].includes(key)) ||
      item.taskId == null || !taskIds.has(item.taskId)) throw new Error('Malformed integration event record')
  const required = {
    historical_merge_confirmed: ['evidenceRef', 'headSha', 'targetBranch'],
    task_selected: ['attempt', 'selection'],
    task_completed: ['evidenceRef'],
    task_blocked: ['blockerCode', 'evidenceRef', 'retryExhausted'],
    task_rejected: ['reasonCode', 'evidenceRef'],
    task_retry_authorized: ['evidenceRef'],
    merge_authorized: ['evidenceRef', 'headSha', 'baseSha'],
    merge_scope_changed: ['previous', 'current'],
  }[item.type]
  if (required.some(key => !Object.hasOwn(item, key))) throw new Error(`Event ${item.type} is missing required fields`)
  if (required.includes('evidenceRef')) assertEvidenceRef(item.evidenceRef, `${item.type} evidence reference`)
  if (['historical_merge_confirmed', 'merge_authorized'].includes(item.type) &&
      !/^[a-f0-9]{40}$/.test(item.headSha)) throw new Error(`Event ${item.type} has malformed headSha`)
  if (item.type === 'merge_authorized' && !/^[a-f0-9]{40}$/.test(item.baseSha)) {
    throw new Error('Merge authorization event has malformed baseSha')
  }
  if (item.type === 'task_completed' && item.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(item.commitSha)) {
    throw new Error('Completion event has malformed commitSha')
  }
  if (item.type === 'task_selected' && (![item.attempt, item.selection].every(value => Number.isSafeInteger(value) && value >= 1) ||
      (item.candidateHeadSha !== undefined && !/^[a-f0-9]{40}$/.test(item.candidateHeadSha)))) {
    throw new Error('Task selection event has malformed counters or candidateHeadSha')
  }
  if (item.type === 'task_blocked' && (!BLOCKER_CODES.includes(item.blockerCode) || typeof item.retryExhausted !== 'boolean')) {
    throw new Error('Blocker event has malformed blockerCode or retryExhausted')
  }
  if (item.type === 'task_rejected' && !REJECTION_CODES.includes(item.reasonCode)) {
    throw new Error('Task rejection event has unsupported reasonCode')
  }
  if (item.type === 'historical_merge_confirmed') validateBranchRef(item.targetBranch, 'Historical target branch')
  if (item.type === 'merge_scope_changed') {
    const prior = item.previous
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('Merge scope event has malformed previous PR scope')
    const { approvalEvidenceRef, ...previousPr } = prior
    if (approvalEvidenceRef !== null && approvalEvidenceRef !== undefined) assertEvidenceRef(approvalEvidenceRef)
    validatePr(previousPr)
    validatePr(item.current)
  }
  validateEvidenceTree(item)
  return item
}

function normalizeTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !/^[a-z0-9][a-z0-9-]{1,79}$/.test(input.id ?? '')) throw new Error('Task requires a safe unique id')
  if (Object.keys(input).some(key => !['id', 'title', 'kind', 'priority', 'dependencies', 'pr', 'candidateHeadSha', 'evidenceRefs'].includes(key))) {
    throw new Error(`Task ${input.id} contains unsupported fields`)
  }
  if (!['work', 'merge'].includes(input.kind ?? 'work')) throw new Error('Task kind must be work or merge')
  if (!Number.isInteger(input.priority ?? 1) || (input.priority ?? 1) < 1 || (input.priority ?? 1) > 100) {
    throw new Error('Task priority must be between 1 and 100')
  }
  const dependencies = input.dependencies ?? []
  if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string') ||
      new Set(dependencies).size !== dependencies.length || dependencies.includes(input.id)) {
    throw new Error(`Task ${input.id} has invalid dependencies`)
  }
  const kind = input.kind ?? 'work'
  const evidenceRefs = input.evidenceRefs ?? []
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 240) ||
      new Set(evidenceRefs).size !== evidenceRefs.length) throw new Error(`Task ${input.id} has invalid evidence references`)
  for (const ref of evidenceRefs) assertEvidenceRef(ref)
  if (kind === 'merge' && (input.pr === undefined || !/^[a-f0-9]{40}$/.test(input.pr?.baseSha ?? ''))) {
    throw new Error('Merge task requires exact PR scope with canonical baseSha')
  }
  if (input.candidateHeadSha !== undefined && !/^[a-f0-9]{40}$/.test(input.candidateHeadSha)) {
    throw new Error('Candidate head must be a full hexadecimal SHA')
  }
  return {
    id: input.id,
    title: requireText(input.title, 'Task title', 200),
    kind,
    priority: input.priority ?? 1,
    dependencies: [...dependencies],
    ...(input.candidateHeadSha ? { candidateHeadSha: input.candidateHeadSha } : {}),
    status: kind === 'merge' ? 'awaiting_approval' : 'ready',
    pr: input.pr === undefined ? null : validatePr(input.pr),
    approval: null,
    attempts: 0,
    evidenceRefs: [...evidenceRefs],
    blockerCode: null,
    retryExhausted: false,
    result: null,
    rejection: null,
  }
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) throw new Error(`Workflow supports at most ${MAX_TASKS} tasks`)
  const ids = new Set()
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !TASK_KEYS.has(key)) ||
        TASK_REQUIRED_KEYS.some(key => !Object.hasOwn(task, key)) ||
        !/^[a-z0-9][a-z0-9-]{1,79}$/.test(task.id ?? '') || typeof task.title !== 'string' ||
        !['work', 'merge'].includes(task.kind) || !Number.isInteger(task.priority) || task.priority < 1 || task.priority > 100 ||
        !TASK_STATUSES.includes(task.status) || !Array.isArray(task.dependencies) ||
        task.dependencies.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) ||
        new Set(task.dependencies).size !== task.dependencies.length || task.dependencies.includes(task.id) ||
        typeof task.retryExhausted !== 'boolean' || !Number.isInteger(task.attempts)) {
      throw new Error('Malformed integration task record')
    }
    requireText(task.title, 'Task title', 200)
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
    ids.add(task.id)
  }
  for (const task of tasks) for (const dependency of task.dependencies) {
    if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${task.id}`)
  }
  const visiting = new Set(), visited = new Set()
  const byId = new Map(tasks.map(task => [task.id, task]))
  function visit(id) {
    if (visiting.has(id)) throw new Error('Workflow dependencies contain a cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of byId.get(id).dependencies) visit(dep)
    visiting.delete(id); visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

function createWorkflow({ objectiveId, maxSelections = 10, tasks = [] } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(objectiveId ?? '')) throw new Error('Objective requires a safe id')
  if (!Number.isInteger(maxSelections) || maxSelections < 1 || maxSelections > MAX_SELECTIONS) {
    throw new Error(`Selection budget must be between 1 and ${MAX_SELECTIONS}`)
  }
  const normalized = tasks.map(normalizeTask)
  validateTasks(normalized)
  const empty = normalized.length === 0
  return {
    schemaVersion: SCHEMA_VERSION,
    objectiveId,
    status: empty ? 'completed' : 'active',
    stopReason: empty ? 'objective_complete' : null,
    revision: 0,
    maxSelections,
    selections: 0,
    selectedTaskId: null,
    tasks: normalized,
    events: [],
  }
}

function validateWorkflow(state) {
  const workflowKeys = new Set([
    'schemaVersion', 'objectiveId', 'status', 'stopReason', 'revision', 'maxSelections',
    'selections', 'selectedTaskId', 'tasks', 'events',
  ])
  if (!state || state.schemaVersion !== SCHEMA_VERSION ||
      Object.keys(state).some(key => !workflowKeys.has(key)) ||
      !/^[a-z0-9][a-z0-9-]{1,60}$/.test(state.objectiveId ?? '') ||
      !WORKFLOW_STATUSES.includes(state.status) || !Number.isInteger(state.maxSelections) ||
      state.maxSelections < 1 || state.maxSelections > MAX_SELECTIONS ||
      !Number.isInteger(state.selections) || state.selections < 0 || state.selections > state.maxSelections ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.tasks) ||
      !Array.isArray(state.events) || state.events.length > MAX_EVENTS) throw new Error('Invalid integration checkpoint')
  if (state.selectedTaskId !== null && !/^[a-z0-9][a-z0-9-]{1,79}$/.test(state.selectedTaskId ?? '')) {
    throw new Error('Invalid selected task ID')
  }
  validateTasks(state.tasks)
  const taskIds = new Set(state.tasks.map(task => task.id))
  const allowedStopReason = { active: null, blocked: 'no_actionable_task', budget_reached: 'selection_budget', completed: 'objective_complete' }
  if (state.stopReason !== allowedStopReason[state.status]) throw new Error('Workflow status and stop reason are inconsistent')
  const selected = state.selectedTaskId ? state.tasks.find(task => task.id === state.selectedTaskId) : null
  if (state.selectedTaskId && (!selected || selected.status !== 'running')) throw new Error('Selected task does not match a running task')
  if (state.selectedTaskId && state.status !== 'active') throw new Error('Only an active workflow may have a selected task')
  if (state.tasks.some(task => !TASK_STATUSES.includes(task.status))) throw new Error('Invalid task status')
  if (state.tasks.filter(task => task.status === 'running').length !== (state.selectedTaskId ? 1 : 0)) {
    throw new Error('Checkpoint must have exactly one running task when selectedTaskId is set')
  }
  let recordedAttempts = 0
  for (const task of state.tasks) {
    if (!Number.isInteger(task.attempts) || task.attempts < 0 || task.attempts > MAX_ATTEMPTS ||
        !Array.isArray(task.evidenceRefs) || task.evidenceRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 240) ||
        new Set(task.evidenceRefs).size !== task.evidenceRefs.length) {
      throw new Error(`Invalid attempt or evidence history for ${task.id}`)
    }
    for (const ref of task.evidenceRefs) assertEvidenceRef(ref)
    recordedAttempts += task.attempts
    if (task.pr) validatePr(task.pr)
    if (task.candidateHeadSha !== undefined && !/^[a-f0-9]{40}$/.test(task.candidateHeadSha)) {
      throw new Error(`Invalid candidate head SHA for ${task.id}`)
    }
    if (task.kind === 'merge' && (!task.pr || !/^[a-f0-9]{40}$/.test(task.pr.baseSha ?? ''))) {
      throw new Error(`Merge task ${task.id} requires canonical exact baseSha`)
    }
    if (task.kind === 'merge' && task.status === 'awaiting_approval' && task.approval !== null) {
      throw new Error(`Awaiting-approval merge task ${task.id} cannot have an approval`)
    }
    if (task.kind === 'merge' && ['ready', 'running', 'completed'].includes(task.status) && !task.approval) {
      throw new Error(`Unauthorized merge task ${task.id} cannot be ${task.status}`)
    }
    if (task.approval && (task.approval.action !== 'merge' ||
        task.approval.repository !== task.pr.repository || task.approval.prNumber !== task.pr.number ||
        task.approval.headSha !== task.pr.headSha || task.approval.targetBranch !== task.pr.baseRef ||
        task.approval.baseSha !== task.pr.baseSha)) {
      throw new Error(`Merge authorization scope changed for ${task.id}`)
    }
    if (task.approval && task.kind !== 'merge') throw new Error('Only merge tasks can hold merge authorization')
    if (task.approval) {
      const approvalKeys = ['action', 'repository', 'prNumber', 'headSha', 'targetBranch', 'baseSha', 'approver', 'evidenceRef']
      if (Object.keys(task.approval).some(key => !approvalKeys.includes(key)) ||
          !Number.isSafeInteger(task.approval.prNumber) || !/^[a-f0-9]{40}$/.test(task.approval.headSha ?? '') ||
          !/^[a-f0-9]{40}$/.test(task.approval.baseSha ?? '')) {
        throw new Error(`Malformed approval record for ${task.id}`)
      }
      requireText(task.approval.approver, 'Approver identity', 100)
      assertEvidenceRef(task.approval.evidenceRef)
    }
    if ((task.status === 'blocked') !== Boolean(task.blockerCode) ||
        (task.blockerCode !== null && !BLOCKER_CODES.includes(task.blockerCode)) ||
        task.retryExhausted !== (task.status === 'blocked' && task.attempts >= MAX_ATTEMPTS)) {
      throw new Error(`Blocker status is inconsistent for ${task.id}`)
    }
    if (task.status === 'completed') {
      if (!task.result || typeof task.result !== 'object' || !task.result.evidenceRef) {
        throw new Error(`Completed task ${task.id} lacks completion evidence`)
      }
      const resultKeys = ['evidenceRef', 'commitSha', 'mergeCommitSha']
      if (Object.keys(task.result).some(key => !resultKeys.includes(key))) throw new Error(`Completed task ${task.id} has unsupported result fields`)
      validateEvidenceTree(task.result)
      if (task.result.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(task.result.commitSha)) {
        throw new Error(`Invalid completion commit SHA for ${task.id}`)
      }
      if (task.kind === 'merge' && !/^[a-f0-9]{40}$/.test(task.result.mergeCommitSha ?? '')) {
        throw new Error(`Completed merge task ${task.id} lacks merge commit evidence`)
      }
    } else if (task.result !== null) throw new Error(`Incomplete task ${task.id} cannot contain completion result`)
    if (task.status === 'rejected') {
      if (!task.rejection || !REJECTION_CODES.includes(task.rejection.reasonCode) ||
          Object.keys(task.rejection).some(key => !['reasonCode', 'evidenceRef'].includes(key))) {
        throw new Error(`Rejected task ${task.id} lacks a valid rejection record`)
      }
      assertEvidenceRef(task.rejection.evidenceRef, `Task ${task.id} rejection evidence reference`)
      if (!task.evidenceRefs.includes(task.rejection.evidenceRef)) {
        throw new Error(`Rejected task ${task.id} does not preserve its rejection evidence reference`)
      }
      validateEvidenceTree(task.rejection)
    } else if (task.rejection !== null) throw new Error(`Non-rejected task ${task.id} cannot contain a rejection record`)
  }
  if (recordedAttempts !== state.selections) throw new Error('Selection count does not match persisted task attempts')
  const unfinished = state.tasks.some(task => !['completed', 'rejected'].includes(task.status))
  if (state.status === 'completed' && unfinished) throw new Error('Completed workflow contains unfinished tasks')
  if (state.status === 'completed' && state.selectedTaskId) throw new Error('Completed workflow cannot have a selected task')
  if (state.status === 'completed' && state.stopReason !== 'objective_complete') throw new Error('Completed workflow has an invalid stop reason')
  if (state.status === 'budget_reached' && (state.selections !== state.maxSelections || !unfinished || state.selectedTaskId)) {
    throw new Error('Budget stop must be at the selection limit with unfinished work')
  }
  if (state.status === 'blocked' && (!unfinished || state.selectedTaskId)) {
    throw new Error('Blocked workflow must preserve unfinished work without a selected task')
  }
  if (state.status === 'blocked') {
    const completed = new Set(state.tasks.filter(task => task.status === 'completed').map(task => task.id))
    if (state.tasks.some(task => task.status === 'ready' && task.dependencies.every(id => completed.has(id)))) {
      throw new Error('Blocked workflow contains eligible work')
    }
  }
  if (state.status === 'active' && !unfinished) throw new Error('Active workflow cannot have only terminal tasks')
  for (let i = 0; i < state.events.length; i += 1) {
    validateEventRecord(state.events[i], i + 1, taskIds)
  }
  return state
}

function event(state, type, taskId, data = {}) {
  if (state.events.length >= MAX_EVENTS) throw new Error('Integration event history is full; checkpoint requires archival')
  const item = { sequence: state.events.length + 1, type, taskId, ...clone(data) }
  validateEventRecord(item, item.sequence, new Set(state.tasks.map(task => task.id)))
  state.events.push(item)
}

function advance(state) {
  validateWorkflow(state)
  if (state.selectedTaskId) return { task: state.tasks.find(task => task.id === state.selectedTaskId), reason: 'active_task' }
  const terminal = state.tasks.every(task => ['completed', 'rejected'].includes(task.status))
  if (terminal) {
    state.status = 'completed'; state.stopReason = 'objective_complete'
    return { task: null, reason: 'completed' }
  }
  if (state.selections >= state.maxSelections) {
    state.status = 'budget_reached'; state.stopReason = 'selection_budget'
    return { task: null, reason: 'budget_reached' }
  }
  const completed = new Set(state.tasks.filter(task => task.status === 'completed').map(task => task.id))
  const next = state.tasks.filter(task => task.status === 'ready' && task.dependencies.every(id => completed.has(id)))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0]
  if (next) {
    next.status = 'running'; next.attempts += 1; state.selectedTaskId = next.id
    state.status = 'active'; state.stopReason = null; state.selections += 1
    event(state, 'task_selected', next.id, { attempt: next.attempts, selection: state.selections })
    return { task: next, reason: 'selected' }
  }
  state.status = 'blocked'
  state.stopReason = 'no_actionable_task'
  return { task: null, reason: 'blocked' }
}

function begin(state) {
  if (state.status === 'budget_reached' || state.status === 'completed') return { task: null, reason: state.status }
  return advance(state)
}

function completeTask(state, taskId, { evidenceRef, commitSha } = {}) {
  const task = selectedTask(state, taskId)
  assertEvidenceRef(evidenceRef, 'Completion evidence reference')
  if (commitSha !== undefined && !/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('Completion commit SHA must be 40 hexadecimal characters')
  if (task.kind === 'merge') {
    if (!task.approval) throw new Error('Merge completion requires exact scoped user authorization')
    if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new Error('Merge completion requires the resulting merge commit SHA')
    task.result = { evidenceRef, mergeCommitSha: commitSha }
  } else task.result = { evidenceRef, ...(commitSha ? { commitSha } : {}) }
  task.status = 'completed'; task.blockerCode = null; state.selectedTaskId = null
  event(state, 'task_completed', task.id, { evidenceRef, ...(commitSha ? { commitSha } : {}) })
  if (state.tasks.every(item => ['completed', 'rejected'].includes(item.status))) {
    state.status = 'completed'; state.stopReason = 'objective_complete'
  }
  const next = advance(state)
  return { completed: task, ...next }
}

function blockTask(state, taskId, { blockerCode, evidenceRef } = {}) {
  const task = selectedTask(state, taskId)
  if (!BLOCKER_CODES.includes(blockerCode)) throw new Error('Blocker code is not allowlisted')
  assertEvidenceRef(evidenceRef, 'Blocker evidence reference')
  if (task.evidenceRefs.includes(evidenceRef)) throw new Error('Blocker evidence must be new for this task')
  task.evidenceRefs.push(evidenceRef); task.status = 'blocked'; task.blockerCode = blockerCode
  task.retryExhausted = task.attempts >= MAX_ATTEMPTS; state.selectedTaskId = null
  event(state, 'task_blocked', task.id, { blockerCode, evidenceRef, retryExhausted: task.retryExhausted })
  return { blocked: task, ...advance(state) }
}

function rejectTask(state, taskId, { reasonCode, evidenceRef } = {}) {
  const task = selectedTask(state, taskId)
  if (!REJECTION_CODES.includes(reasonCode)) throw new Error('Rejection reasonCode is not allowlisted')
  assertEvidenceRef(evidenceRef, 'Rejection evidence reference')
  if (task.evidenceRefs.includes(evidenceRef)) throw new Error('Rejection evidence must be new for this task')
  task.evidenceRefs.push(evidenceRef)
  task.status = 'rejected'
  task.blockerCode = null
  task.retryExhausted = false
  task.rejection = { reasonCode, evidenceRef }
  state.selectedTaskId = null
  event(state, 'task_rejected', task.id, { reasonCode, evidenceRef })
  if (state.tasks.every(item => ['completed', 'rejected'].includes(item.status))) {
    state.status = 'completed'; state.stopReason = 'objective_complete'
  }
  return { rejected: task, ...advance(state) }
}

function retryTask(state, taskId, { evidenceRef } = {}) {
  const task = findTask(state, taskId)
  assertEvidenceRef(evidenceRef, 'Retry evidence reference')
  if (task.status !== 'blocked' || task.retryExhausted || task.attempts >= MAX_ATTEMPTS) {
    throw new Error('Task is not safely retryable or has exhausted its two retries')
  }
  if (task.evidenceRefs.includes(evidenceRef)) throw new Error('Retry requires distinct new evidence')
  task.evidenceRefs.push(evidenceRef); task.status = 'ready'; task.blockerCode = null
  state.status = 'active'; state.stopReason = null
  event(state, 'task_retry_authorized', task.id, { evidenceRef })
  return advance(state)
}

function recordApproval(state, taskId, authorization) {
  const task = findTask(state, taskId)
  if (task.kind !== 'merge' || task.status !== 'awaiting_approval' || task.approval) {
    throw new Error('Only an unapproved merge task awaiting approval can be authorized')
  }
  if (!authorization || authorization.action !== 'merge' ||
      authorization.repository !== task.pr.repository || authorization.prNumber !== task.pr.number ||
      authorization.headSha !== task.pr.headSha || authorization.targetBranch !== task.pr.baseRef ||
      authorization.baseSha !== task.pr.baseSha) {
    throw new Error('Approval must match this exact repository, PR, head SHA, and target branch')
  }
  const authorizationKeys = ['action', 'repository', 'prNumber', 'headSha', 'targetBranch', 'baseSha', 'approver', 'evidenceRef']
  if (Object.keys(authorization).some(key => !authorizationKeys.includes(key))) {
    throw new Error('Approval contains unsupported fields')
  }
  requireText(authorization.approver, 'Approver identity', 100)
  assertEvidenceRef(authorization.evidenceRef, 'Approval evidence reference')
  task.approval = {
    action: 'merge', repository: authorization.repository, prNumber: authorization.prNumber,
    headSha: authorization.headSha, targetBranch: authorization.targetBranch, baseSha: authorization.baseSha,
    approver: authorization.approver, evidenceRef: authorization.evidenceRef,
  }
  task.status = 'ready'
  state.status = 'active'; state.stopReason = null
  event(state, 'merge_authorized', task.id, {
    evidenceRef: authorization.evidenceRef, headSha: authorization.headSha, baseSha: authorization.baseSha,
  })
  return advance(state)
}

function refreshMergeScope(state, taskId, newPr) {
  const task = findTask(state, taskId)
  if (task.kind !== 'merge' || ['completed', 'rejected'].includes(task.status)) {
    throw new Error('Only an unfinished merge task can refresh its PR scope')
  }
  const refreshed = validatePr(newPr)
  if (['repository', 'number', 'baseRef', 'baseSha', 'headSha'].every(key => refreshed[key] === task.pr[key])) {
    task.pr = refreshed
    return advance(state)
  }
  const previous = { ...task.pr, approvalEvidenceRef: task.approval?.evidenceRef ?? null }
  if (state.selectedTaskId === task.id) state.selectedTaskId = null
  task.pr = refreshed
  task.approval = null
  task.status = 'awaiting_approval'
  task.blockerCode = null
  task.result = null
  state.status = 'active'; state.stopReason = null
  event(state, 'merge_scope_changed', task.id, { previous, current: refreshed })
  return { approvalRequired: true, ...advance(state) }
}

function selectedTask(state, taskId) {
  validateWorkflow(state)
  const task = state.tasks.find(item => item.id === taskId)
  if (!task || state.selectedTaskId !== taskId || task.status !== 'running') throw new Error('Task is not the active selected task')
  return task
}

function findTask(state, taskId) {
  const task = state.tasks.find(item => item.id === taskId)
  if (!task) throw new Error(`Unknown task: ${taskId}`)
  return task
}

function migrateAdditiveSchemaV1Fields(state) {
  // Schema-v1 checkpoints created before rejection provenance was added remain
  // readable; the new field is additive and defaults to no rejection record.
  if (state?.schemaVersion === SCHEMA_VERSION && Array.isArray(state.tasks)) {
    for (const task of state.tasks) if (task && !Object.hasOwn(task, 'rejection')) task.rejection = null
  }
  return state
}

async function loadCheckpoint(file = DEFAULT_CHECKPOINT) {
  const state = migrateAdditiveSchemaV1Fields(JSON.parse(await fs.readFile(file, 'utf8')))
  return validateWorkflow(state)
}

async function acquireCheckpointLock(lockPath, recoveryPath) {
  const lockData = JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: crypto.randomUUID() })
  let lockHandle
  let recovered = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600)
      await lockHandle.writeFile(lockData)
      await lockHandle.sync()
      return { lockHandle, lockData }
    } catch (error) {
      if (lockHandle) { await lockHandle.close().catch(() => {}); lockHandle = null }
      if (error.code !== 'EEXIST' || recovered) throw new Error('Integration checkpoint is locked by another or ambiguous Coordinator process')
      const beforeStat = await fs.stat(lockPath).catch(() => null)
      if (!beforeStat) continue
      const beforeText = await fs.readFile(lockPath, 'utf8').catch(() => null)
      if (beforeText === null) throw new Error('Integration checkpoint lock is ambiguous; inspect it manually')
      let owner
      try { owner = JSON.parse(beforeText) } catch { owner = null }
      let reclaimable = false
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string') {
        if (owner.host !== os.hostname()) throw new Error('Integration checkpoint lock belongs to another host; refusing recovery')
        try {
          process.kill(owner.pid, 0)
          throw new Error('Integration checkpoint is locked by a live Coordinator process')
        } catch (probeError) {
          if (probeError.message === 'Integration checkpoint is locked by a live Coordinator process') throw probeError
          if (probeError.code === 'ESRCH') reclaimable = true
          else throw new Error('Integration checkpoint lock owner cannot be proven dead; refusing recovery')
        }
      } else if (Date.now() - beforeStat.mtimeMs >= MALFORMED_LOCK_RECOVERY_MS) {
        reclaimable = true
      } else {
        throw new Error('Malformed integration checkpoint lock is too recent for safe recovery')
      }
      if (!reclaimable) throw new Error('Integration checkpoint lock is ambiguous; refusing recovery')
      let guard
      try { guard = await fs.open(recoveryPath, 'wx', 0o600) } catch (guardError) {
        if (guardError.code === 'EEXIST') throw new Error('Integration checkpoint lock recovery is already active or needs operator recovery')
        throw guardError
      }
      let guardToken
      try {
        guardToken = crypto.randomUUID()
        await guard.writeFile(guardToken)
        await guard.sync()
        const [currentStat, currentText] = await Promise.all([
          fs.stat(lockPath).catch(() => null), fs.readFile(lockPath, 'utf8').catch(() => null),
        ])
        const sameLock = currentStat && currentText === beforeText && currentStat.dev === beforeStat.dev &&
          currentStat.ino === beforeStat.ino && currentStat.size === beforeStat.size &&
          currentStat.mtimeMs === beforeStat.mtimeMs && currentStat.ctimeMs === beforeStat.ctimeMs
        if (!sameLock) throw new Error('Integration checkpoint lock changed during recovery; refusing to remove it')
        await fs.unlink(lockPath)
      } finally {
        const ownedGuard = await guard.stat().catch(() => null)
        await guard.close().catch(() => {})
        const [currentGuard, currentText] = await Promise.all([
          fs.lstat(recoveryPath).catch(() => null), fs.readFile(recoveryPath, 'utf8').catch(() => null),
        ])
        if (ownedGuard && currentGuard && !currentGuard.isSymbolicLink() &&
            currentGuard.dev === ownedGuard.dev && currentGuard.ino === ownedGuard.ino &&
            guardToken && currentText === guardToken) await fs.unlink(recoveryPath).catch(() => {})
      }
      recovered = true
    }
  }
  if (!lockHandle) throw new Error('Unable to acquire integration checkpoint lock')
  return { lockHandle, lockData }
}

async function saveCheckpoint(file, state) {
  file = path.resolve(file ?? DEFAULT_CHECKPOINT)
  validateWorkflow(state)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const recovery = `${lock}.recovery`
  let lockHandle
  let lockData
  try {
    ({ lockHandle, lockData } = await acquireCheckpointLock(lock, recovery))
    let diskRevision = 0
    try {
      const diskState = migrateAdditiveSchemaV1Fields(JSON.parse(await fs.readFile(file, 'utf8')))
      diskRevision = validateWorkflow(diskState).revision
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot verify integration checkpoint revision; refusing to overwrite it')
    }
    if (diskRevision !== state.revision) throw new Error(`Stale integration checkpoint revision ${state.revision}; current revision is ${diskRevision}`)
    const next = { ...clone(state), revision: state.revision + 1 }
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await fs.rename(temp, file)
    } finally {
      await fs.rm(temp, { force: true })
    }
    Object.assign(state, next)
    return state
  } finally {
    await lockHandle?.close().catch(() => {})
    const currentLock = await fs.readFile(lock, 'utf8').catch(() => null)
    if (currentLock === lockData) await fs.rm(lock, { force: true }).catch(() => {})
  }
}

async function transitionAndSave(file, state, transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
    throw new Error('Transition must be a structured allowlisted operation')
  }
  const candidate = clone(state)
  let outcome
  const { type, taskId, payload, pr } = transition
  if (type === 'begin' && Object.keys(transition).every(key => key === 'type')) outcome = begin(candidate)
  else if (type === 'complete' && Object.keys(transition).every(key => ['type', 'taskId', 'payload'].includes(key))) {
    outcome = completeTask(candidate, taskId, payload)
  } else if (type === 'block' && Object.keys(transition).every(key => ['type', 'taskId', 'payload'].includes(key))) {
    outcome = blockTask(candidate, taskId, payload)
  } else if (type === 'retry' && Object.keys(transition).every(key => ['type', 'taskId', 'payload'].includes(key))) {
    outcome = retryTask(candidate, taskId, payload)
  } else if (type === 'reject' && Object.keys(transition).every(key => ['type', 'taskId', 'payload'].includes(key))) {
    outcome = rejectTask(candidate, taskId, payload)
  } else if (type === 'approve_merge' && Object.keys(transition).every(key => ['type', 'taskId', 'payload'].includes(key))) {
    outcome = recordApproval(candidate, taskId, payload)
  } else if (type === 'refresh_merge_scope' && Object.keys(transition).every(key => ['type', 'taskId', 'pr'].includes(key))) {
    outcome = refreshMergeScope(candidate, taskId, pr)
  } else throw new Error('Unsupported or malformed integration transition')

  await saveCheckpoint(file, candidate)
  Object.assign(state, candidate)
  return outcome
}

module.exports = {
  BLOCKER_CODES, DEFAULT_CHECKPOINT, MAX_ATTEMPTS, MAX_SELECTIONS, MAX_TASKS, REJECTION_CODES,
  advance, begin, blockTask, completeTask, createWorkflow, loadCheckpoint,
  recordApproval, refreshMergeScope, rejectTask, retryTask, saveCheckpoint, transitionAndSave, validateWorkflow,
}
