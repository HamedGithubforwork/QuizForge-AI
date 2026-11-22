'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const integration = require('./integration-coordinator.cjs')

const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/
const SHA = /^[a-f0-9]{40}$/

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Unexpected batch fields')
  }
}

function normalizePath(value) {
  if (typeof value !== 'string' ||
      !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*(?:\/\*\*)?$/i.test(value) ||
      value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Use a repository-relative file or directory/** reservation')
  }
  return value.replace(/\/\*\*$/, '').toLowerCase()
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

function createBatch(input) {
  fields(input, ['batch', 'max_parallel', 'tasks'])
  const { batch, max_parallel: limit, tasks } = input
  if (!SAFE_ID.test(batch ?? '') || typeof batch !== 'string' ||
      !Number.isInteger(limit) || limit < 1 || limit > 3 ||
      !Array.isArray(tasks) || tasks.length < 1 || tasks.length > integration.MAX_TASKS) {
    throw new Error('Invalid batch ID, concurrency, or task count')
  }
  const definitions = tasks.map(task => {
    fields(task, ['id', 'request', 'paths', 'depends_on'])
    if (!Array.isArray(task.paths) || !task.paths.length || task.paths.length > 40) {
      throw new Error('Each task requires path reservations')
    }
    const paths = task.paths.map(normalizePath)
    if (new Set(paths).size !== paths.length) throw new Error('Duplicate path reservation')
    return { id: task.id, request: task.request, paths, depends_on: task.depends_on ?? [] }
  })
  integration.createWorkflow({ objectiveId: batch, tasks: definitions.map(toIntegrationTask) })
  return { version: 1, batch, max_parallel: limit, tasks: definitions.map(task => ({
    ...task, status: 'queued', pr: null, worktreePath: null,
  })) }
}

function toIntegrationTask(task) {
  return { id: task.id, title: task.request, dependencies: task.depends_on }
}

function taskCheckpoint(batch, id) {
  const task = lookup(batch, id)
  return integration.createWorkflow({
    objectiveId: batch.batch,
    tasks: [{ id, title: task.request }],
  })
}

function taskLocation(batch, id) {
  validateBatch(batch)
  const task = lookup(batch, id)
  const location = `${batch.batch}/${id}`
  return {
    branch: `codex/batch-${location}`, checkpoint: `${location}.json`,
    worktree: location, worktreePath: task.worktreePath ?? null,
  }
}

function normalizeWorktreePath(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value) ||
      (process.platform === 'win32' && /^[\\/](?![\\/])/.test(value))) {
    throw new Error('Worktree requires an absolute host path')
  }
  const normalized = path.resolve(value)
  if (normalized === path.parse(normalized).root) throw new Error('Worktree cannot be a filesystem root')
  return normalized
}

function worktreeKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

// The Coordinator verifies repository and branch from Git's worktree list.
function recordWorktree(batch, id, absolutePath) {
  validateBatch(batch)
  const next = structuredClone(batch)
  const task = lookup(next, id)
  if (task.status !== 'running') throw new Error('Only reserved work may attach a worktree')
  const normalized = normalizeWorktreePath(absolutePath)
  if (task.worktreePath && worktreeKey(task.worktreePath) !== worktreeKey(normalized)) {
    throw new Error('Worktree path already recorded for this task')
  }
  task.worktreePath ??= normalized
  return validateBatch(next)
}

function recoverWorktree(batch, id, currentPath = null) {
  const location = taskLocation(batch, id)
  if (currentPath === null) {
    return { ...location, state: location.worktreePath ? 'missing' : 'before_creation' }
  }
  const live = normalizeWorktreePath(currentPath)
  if (!location.worktreePath) return { ...location, state: 'unrecorded', currentPath: live }
  const state = worktreeKey(location.worktreePath) === worktreeKey(live) ? 'present' : 'moved'
  return { ...location, state, currentPath: live }
}

function lookup(batch, id) {
  const task = batch.tasks.find(task => task.id === id)
  if (!task) throw new Error('Unknown batch task')
  return task
}

function validatePr(pr) {
  fields(pr, ['repository', 'number', 'headSha', 'target'])
  if (pr.repository !== REPOSITORY || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      typeof pr.headSha !== 'string' || !SHA.test(pr.headSha) || pr.target !== 'main') {
    throw new Error('Expected exact PR scope targeting main')
  }
}

function validateBatch(batch) {
  fields(batch, ['version', 'batch', 'max_parallel', 'tasks'])
  if (batch.version !== 1 || !Array.isArray(batch.tasks)) throw new Error('Invalid batch manifest')
  createBatch({ batch: batch.batch, max_parallel: batch.max_parallel, tasks: batch.tasks.map(task => {
    fields(task, ['id', 'request', 'paths', 'depends_on', 'status', 'pr', 'worktreePath'])
    if (task.worktreePath != null && normalizeWorktreePath(task.worktreePath) !== task.worktreePath) {
      throw new Error('Noncanonical worktree path')
    }
    if (!['queued', 'running', 'blocked', 'awaiting_merge', 'rejected'].includes(task.status)) {
      throw new Error('Invalid batch task status')
    }
    if (task.status === 'awaiting_merge' ||
        (['blocked', 'rejected'].includes(task.status) && task.pr !== null)) validatePr(task.pr)
    else if (task.pr !== null) throw new Error('Unexpected PR scope')
    if (!Array.isArray(task.paths) || task.paths.some(value => normalizePath(value) !== value)) {
      throw new Error('Noncanonical path reservation')
    }
    return { id: task.id, request: task.request, paths: task.paths, depends_on: task.depends_on }
  }) })
  const prs = batch.tasks.flatMap(task => task.pr ? [task.pr.number] : [])
  if (new Set(prs).size !== prs.length) throw new Error('PR already belongs to another batch task')
  const worktrees = batch.tasks.flatMap(task => task.worktreePath ? [worktreeKey(task.worktreePath)] : [])
  if (new Set(worktrees).size !== worktrees.length) throw new Error('Worktree already belongs to another batch task')
  const running = batch.tasks.filter(task => task.status === 'running')
  if (running.length > batch.max_parallel ||
      running.some((task, index) => running.slice(index + 1).some(other => intersects(task, other)))) {
    throw new Error('Conflicting running task reservations')
  }
  return batch
}

function intersects(task, other) {
  return task.paths.some(left => other.paths.some(right => overlaps(left, right)))
}

// The Coordinator supplies fresh live observations to each call. They are
// never saved, accepted as merge authority, or fetched by this module.
function selectTasks(batch, { mainSha, merges = [] } = {}) {
  validateBatch(batch)
  const merged = new Set()
  for (const evidence of merges) {
    const task = lookup(batch, evidence.taskId)
    const pr = task.pr
    if (typeof mainSha !== 'string' || !SHA.test(mainSha) || task.status !== 'awaiting_merge' || !pr ||
        evidence.repository !== pr.repository || evidence.number !== pr.number ||
        evidence.headSha !== pr.headSha || evidence.target !== pr.target ||
        evidence.mainSha !== mainSha || evidence.merged !== true || evidence.ancestorOfMain !== true ||
        typeof evidence.mergeSha !== 'string' || !SHA.test(evidence.mergeSha)) {
      throw new Error('Merge observation does not match task scope and inspected main')
    }
    merged.add(task.id)
  }
  const running = batch.tasks.filter(task => task.status === 'running')
  const held = batch.tasks.filter(task =>
    task.status === 'running' || (task.pr && task.status !== 'rejected' && !merged.has(task.id)))
  const selected = []
  for (const task of batch.tasks) {
    if (running.length + selected.length >= batch.max_parallel) break
    if (task.status !== 'queued' || !task.depends_on.every(id => merged.has(id)) ||
        [...held, ...selected].some(other => intersects(task, other))) continue
    selected.push(task)
  }
  const next = structuredClone(batch)
  for (const task of selected) lookup(next, task.id).status = 'running'
  const statuses = Object.fromEntries(next.tasks.map(task =>
    [task.id, merged.has(task.id) ? 'completed' : task.status]))
  return {
    batch: next, taskIds: selected.map(task => task.id), statuses,
    complete: Object.values(statuses).every(status => ['completed', 'rejected'].includes(status)),
  }
}

function recordTask(batch, id, status, pr = null) {
  validateBatch(batch)
  const next = structuredClone(batch)
  const task = lookup(next, id)
  const allowed = {
    running: ['blocked', 'awaiting_merge', 'rejected'],
    blocked: task.pr ? ['awaiting_merge'] : ['queued', 'rejected'],
    awaiting_merge: ['awaiting_merge', 'blocked'],
  }
  if (!allowed[task.status]?.includes(status)) throw new Error('Invalid task transition')
  if (task.pr && pr && pr.number !== task.pr.number) throw new Error('Cannot replace an associated PR')
  task.status = status
  task.pr = pr ?? task.pr
  return validateBatch(next)
}

async function loadBatch(file) {
  return validateBatch(JSON.parse(await fs.readFile(file, 'utf8')))
}

function rejectClosedPr(batch, id, observation) {
  validateBatch(batch)
  fields(observation, ['repository', 'number', 'headSha', 'target', 'state', 'merged'])
  const next = structuredClone(batch)
  const task = lookup(next, id)
  if (!task.pr || !['blocked', 'awaiting_merge'].includes(task.status) ||
      observation.state !== 'closed' || observation.merged !== false ||
      Object.entries(task.pr).some(([key, value]) => observation[key] !== value)) {
    throw new Error('Expected a fresh closed and unmerged observation for the associated PR')
  }
  task.status = 'rejected'
  return validateBatch(next)
}

// One Coordinator owns all writes; atomic replace prevents a partial manifest.
async function saveBatch(file, batch) {
  validateBatch(batch)
  const target = path.resolve(file)
  const temporary = target + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temporary, JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

module.exports = {
  createBatch, taskCheckpoint, taskLocation, recordWorktree, recoverWorktree,
  selectTasks, recordTask, rejectClosedPr, loadBatch, saveBatch,
}
