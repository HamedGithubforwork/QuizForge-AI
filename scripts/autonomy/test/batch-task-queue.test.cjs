'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const queue = require('../batch-task-queue.cjs')
const integration = require('../integration-coordinator.cjs')

const mainSha = 'a'.repeat(40)
const pr = { repository: 'HamedGithubforwork/QuizForge-AI', number: 10, headSha: 'b'.repeat(40), target: 'main' }
const merge = { ...pr, taskId: 'first', mainSha, mergeSha: 'c'.repeat(40), merged: true, ancestorOfMain: true }
const task = (id, paths, depends_on = []) => ({ id, request: id, paths, depends_on })
const create = tasks => queue.createBatch({ batch: 'sample', max_parallel: 2, tasks })

test('independent work starts in input order within the limit', () => {
  const batch = create([task('first', ['docs/**']), task('second', ['app/file.js']), task('third', ['e2e/**'])])
  const result = queue.selectTasks(batch)
  assert.deepEqual(result.taskIds, ['first', 'second'])
  assert.deepEqual(queue.selectTasks(result.batch).taskIds, [])
  const blocked = queue.recordTask(result.batch, 'first', 'blocked')
  assert.deepEqual(queue.selectTasks(blocked).taskIds, ['third'])
})

test('overlapping directory and file paths serialize across case differences', () => {
  const batch = create([task('first', ['Docs/**']), task('second', ['docs/a.md']), task('third', ['docs-other/a.md'])])
  const result = queue.selectTasks(batch)
  assert.deepEqual(result.taskIds, ['first', 'third'])
  const ready = queue.recordTask(result.batch, 'first', 'awaiting_merge', pr)
  assert.deepEqual(queue.selectTasks(ready).taskIds, [])
  assert.deepEqual(queue.selectTasks(ready, { mainSha, merges: [merge] }).taskIds, ['second'])
})

test('merge-dependent work requires fresh matching live evidence', () => {
  const batch = create([task('first', ['docs/**']), task('child', ['e2e/**'], ['first'])])
  const { batch: running } = queue.selectTasks(batch)
  const ready = queue.recordTask(running, 'first', 'awaiting_merge', pr)
  assert.deepEqual(queue.selectTasks(ready).taskIds, [])
  for (const change of [{ headSha: mainSha }, { mainSha: merge.mergeSha }, { ancestorOfMain: false }]) {
    assert.throws(() => queue.selectTasks(ready, { mainSha, merges: [{ ...merge, ...change }] }), /scope/)
  }
  assert.deepEqual(queue.selectTasks(ready, { mainSha, merges: [merge] }).taskIds, ['child'])
  assert.deepEqual(queue.selectTasks(ready).taskIds, [])
})

test('restart preserves reservations and uses the existing per-task checkpoint', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qf-batch-'))
  t.after(async () => {
    for (const name of ['batch.json', 'task.json']) await fs.rm(path.join(dir, name), { force: true })
    await fs.rmdir(dir)
  })
  const file = path.join(dir, 'batch.json')
  const lane = path.join(dir, 'task.json')
  const { batch } = queue.selectTasks(create([task('first', ['docs/**']), task('second', ['docs/a.md'])]))
  const locationBeforeCrash = queue.taskLocation(batch, 'first')
  await queue.saveBatch(file, batch)
  // Simulate a restart after reservation but before checkpoint or worktree creation.
  const interrupted = await queue.loadBatch(file)
  assert.deepEqual(queue.taskLocation(interrupted, 'first'), locationBeforeCrash)
  assert.deepEqual(queue.selectTasks(interrupted).taskIds, [])
  await assert.rejects(fs.access(lane), { code: 'ENOENT' })
  const checkpoint = queue.taskCheckpoint(batch, 'first')
  await integration.saveCheckpoint(lane, checkpoint)
  const resumed = await queue.loadBatch(file)
  assert.deepEqual(resumed, batch)
  assert.deepEqual(queue.selectTasks(resumed).taskIds, [])
  assert.equal((await integration.loadCheckpoint(lane)).tasks[0].id, 'first')
  await queue.saveBatch(file, queue.recordTask(resumed, 'first', 'blocked'))
  assert.deepEqual(queue.selectTasks(await queue.loadBatch(file)).taskIds, ['second'])
})

test('completion is derived rather than persisted as merge proof', () => {
  const { batch } = queue.selectTasks(create([task('first', ['docs/**'])]))
  const ready = queue.recordTask(batch, 'first', 'awaiting_merge', pr)
  const result = queue.selectTasks(ready, { mainSha, merges: [merge] })
  assert.equal(result.statuses.first, 'completed')
  assert.equal(result.complete, true)
  assert.equal(queue.selectTasks(result.batch).complete, false)
})

test('blocked published work retains PR identity and path ownership', () => {
  const { batch } = queue.selectTasks(create([
    task('first', ['docs/**']), task('second', ['e2e/**']), task('third', ['docs/a.md']),
  ]))
  const ready = queue.recordTask(batch, 'first', 'awaiting_merge', pr)
  assert.throws(() => queue.recordTask(ready, 'second', 'awaiting_merge', pr), /belongs/)
  const blocked = queue.recordTask(ready, 'first', 'blocked')
  assert.deepEqual(blocked.tasks[0].pr, pr)
  assert.deepEqual(queue.selectTasks(blocked).taskIds, [])
  assert.throws(() => queue.recordTask(blocked, 'first', 'queued'), /transition/)
  assert.throws(() => queue.recordTask(blocked, 'first', 'awaiting_merge', { ...pr, number: 11 }), /replace/)
  const resumed = queue.recordTask(blocked, 'first', 'awaiting_merge')
  assert.deepEqual(queue.selectTasks(resumed, { mainSha, merges: [merge] }).taskIds, ['third'])
})

test('invalid definitions are rejected', () => {
  assert.throws(() => create([task('first', ['../docs'])]), /relative/)
  assert.throws(() => create([task('first', ['docs'], ['second']), task('second', ['e2e'], ['first'])]), /cycl/i)
  assert.throws(() => create([task('first', ['docs'], ['missing'])]), /depend/i)
})

test('fresh closed-unmerged evidence releases paths while preserving PR identity', () => {
  const { batch } = queue.selectTasks(create([
    task('first', ['docs/**']), task('overlap', ['docs/a.md']), task('child', ['e2e/**'], ['first']),
  ]))
  const ready = queue.recordTask(batch, 'first', 'awaiting_merge', pr)
  const blocked = queue.recordTask(ready, 'first', 'blocked')
  const closed = { ...pr, state: 'closed', merged: false }
  for (const state of [ready, blocked]) {
    assert.throws(() => queue.rejectClosedPr(state, 'first', { ...closed, merged: true }), /unmerged/)
    assert.throws(() => queue.rejectClosedPr(state, 'first', { ...closed, headSha: mainSha }), /associated/)
    const rejected = queue.rejectClosedPr(state, 'first', closed)
    assert.deepEqual(rejected.tasks[0].pr, pr)
    const selection = queue.selectTasks(rejected)
    assert.deepEqual(selection.taskIds, ['overlap'])
    assert.throws(() => queue.recordTask(selection.batch, 'overlap', 'awaiting_merge', pr), /belongs/)
  }
})

test('restart distinguishes reserved, created, present, and missing actual worktrees', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qf-worktree-record-'))
  const file = path.join(dir, 'batch.json')
  t.after(async () => {
    await fs.rm(file, { force: true })
    await fs.rmdir(dir)
  })
  const { batch } = queue.selectTasks(create([task('first', ['docs/**']), task('second', ['e2e/**'])]))
  const actual = path.join(dir, 'host-chosen-worktree')
  await queue.saveBatch(file, batch)
  const reserved = await queue.loadBatch(file)
  assert.equal(queue.recoverWorktree(reserved, 'first').state, 'before_creation')
  assert.equal(queue.recoverWorktree(reserved, 'first', actual).state, 'unrecorded')
  const recorded = queue.recordWorktree(reserved, 'first', actual)
  await queue.saveBatch(file, recorded)
  const resumed = await queue.loadBatch(file)
  assert.equal(queue.taskLocation(resumed, 'first').worktreePath, actual)
  assert.equal(queue.recoverWorktree(resumed, 'first', actual).state, 'present')
  assert.equal(queue.recoverWorktree(resumed, 'first').state, 'missing')
  assert.equal(queue.recoverWorktree(resumed, 'first', path.join(dir, 'other')).state, 'moved')
  assert.throws(() => queue.recordWorktree(resumed, 'first', path.join(dir, 'other')), /already recorded/)
  assert.throws(() => queue.recordWorktree(resumed, 'second', actual), /belongs/)
  assert.throws(() => queue.recordWorktree(resumed, 'second', 'relative-path'), /absolute/)
  assert.deepEqual(queue.selectTasks(resumed).taskIds, [])
})
