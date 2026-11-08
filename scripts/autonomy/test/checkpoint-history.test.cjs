'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  AUDIT_DIMENSIONS, AUDIT_ROLES, addTask, createInitialState, recordOptimizationAudit,
  saveState, loadState, validateState,
} = require('../optimization-orchestrator.cjs')

function makeTask(id) {
  return {
    id, domain: 'backend', title: `Improve ${id}`, impact: 3, effort: 2, risk: 1,
    dependencies: [], evidenceRefs: ['docs/ai-cost-controls.md'],
    testRefs: ['scripts/production/test_runtime.py'], benchmarkRefs: [],
  }
}

function startPilot(state) {
  state.checkpoint.pilotId = 'history-archive-pilot'
  state.checkpoint.events.push({
    at: new Date().toISOString(), type: 'pilot_started', pilotId: state.checkpoint.pilotId, maxCycles: 10,
  })
}

function auditInput(auditId) {
  return {
    auditId,
    auditedDimensions: [...AUDIT_DIMENSIONS],
    evidenceRefs: ['docs/ai-cost-controls.md'],
    specialistAssessments: AUDIT_ROLES.map(role => ({ role, finding: 'clear', evidenceRef: 'docs/ai-cost-controls.md' })),
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-history-'))
  return { root, file: path.join(root, 'state.json') }
}

test('archives the 101st audit losslessly and preserves exhaustion across restart', async () => {
  const { root, file } = await fixture()
  try {
    const state = createInitialState()
    startPilot(state)
    for (let index = 0; index < 101; index += 1) {
      recordOptimizationAudit(state, auditInput(`archive-audit-${String(index).padStart(3, '0')}`))
    }
    await saveState(file, state, root)
    const disk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(disk.checkpoint.optimizationGate.auditHistory.length, 100)
    assert.equal(disk.checkpoint.historyArchives.reduce((n, ref) => n + ref.auditCount, 0), 1)
    assert.equal(disk.checkpoint.optimizationGate.finalReport.audits.length, 2)

    const resumed = await loadState(file, root)
    assert.equal(resumed.checkpoint.optimizationGate.auditHistory.length, 101)
    assert.equal(resumed.checkpoint.optimizationGate.status, 'OPTIMIZATION_EXHAUSTED')
    assert.deepEqual(resumed.checkpoint.optimizationGate.finalReport.audits,
      resumed.checkpoint.optimizationGate.auditHistory.slice(-2))
    assert.equal(validateState(resumed), resumed)
    assert.throws(() => recordOptimizationAudit(resumed, auditInput('archive-audit-000')), /Duplicate audit ID/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('archives old event transitions, reloads the full backlog, and rejects a missing archive', async () => {
  const { root, file } = await fixture()
  try {
    const state = createInitialState()
    startPilot(state)
    for (let index = 0; index < 520; index += 1) addTask(state, makeTask(`history-task-${index}`))
    await saveState(file, state, root)
    const disk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(disk.checkpoint.events.length, 500)
    assert.equal(disk.checkpoint.eventArchives.length, 0)
    assert.ok(disk.checkpoint.historyArchives.reduce((n, ref) => n + ref.eventCount, 0) > 0)
    const restored = await loadState(file, root)
    assert.equal([...restored.checkpoint.eventArchives.flat(), ...restored.checkpoint.events].length, 521)
    assert.equal(restored.tasks.length, 520)
    assert.equal(validateState(restored), restored)
    const ref = disk.checkpoint.historyArchives[0]
    await fs.rm(path.join(root, 'docs/autonomy/history-archives', `${ref.digest}.json`))
    await assert.rejects(loadState(file, root), /History archive artifact is missing/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('rejects tampered archive content and validly rehashed broken event cross-links', async () => {
  const { root, file } = await fixture()
  try {
    const state = createInitialState()
    startPilot(state)
    for (let index = 0; index < 520; index += 1) addTask(state, makeTask(`tamper-task-${index}`))
    await saveState(file, state, root)
    const disk = JSON.parse(await fs.readFile(file, 'utf8'))
    const directory = path.join(root, 'docs/autonomy/history-archives')
    const ref = disk.checkpoint.historyArchives[0]
    const archivePath = path.join(directory, `${ref.digest}.json`)
    const original = await fs.readFile(archivePath)
    await fs.writeFile(archivePath, Buffer.concat([original, Buffer.from('tampered')]))
    await assert.rejects(loadState(file, root), /size or type is invalid|SHA-256/)

    const archive = JSON.parse(original.toString('utf8'))
    archive.events[1].domain = 'security'
    const bytes = Buffer.from(`${JSON.stringify(archive)}\n`)
    const newDigest = crypto.createHash('sha256').update(bytes).digest('hex')
    await fs.rm(archivePath)
    await fs.writeFile(path.join(directory, `${newDigest}.json`), bytes)
    disk.checkpoint.historyArchives[0].digest = newDigest
    disk.checkpoint.historyArchives[0].bytes = bytes.length
    await fs.writeFile(file, `${JSON.stringify(disk, null, 2)}\n`)
    await assert.rejects(loadState(file, root), /domain differs from its discovery event/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('capacity reservation persists a blocked gate without dropping archived or inline events', async () => {
  const { root, file } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    // Orphaned immutable artifacts count against the global cap. Leave one
    // reserved slot, then let this save consume it and persist BLOCKED.
    for (let index = 0; index < 510; index += 1) {
      await fs.writeFile(path.join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n')
    }
    const state = createInitialState()
    startPilot(state)
    for (let index = 0; index < 520; index += 1) addTask(state, makeTask(`capacity-task-${index}`))
    await saveState(file, state, root)
    const loaded = await loadState(file, root)
    assert.equal(loaded.checkpoint.optimizationGate.status, 'BLOCKED')
    assert.equal(loaded.checkpoint.optimizationGate.stopReason, 'history_capacity')
    assert.equal(loaded.checkpoint.historyCapacity.reason, 'history_capacity')
    assert.equal([...loaded.checkpoint.eventArchives.flat(), ...loaded.checkpoint.events].length, 521)
    assert.equal(loaded.tasks.length, 520)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('archive-capacity recording does not overwrite an existing safety STOPPED reason', async () => {
  const { root, file } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    for (let index = 0; index < 510; index += 1) {
      await fs.writeFile(path.join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n')
    }
    const state = createInitialState()
    startPilot(state)
    state.checkpoint.optimizationGate.status = 'STOPPED'
    state.checkpoint.optimizationGate.stopReason = 'security'
    for (let index = 0; index < 520; index += 1) addTask(state, makeTask(`stopped-capacity-${index}`))
    await saveState(file, state, root)
    const loaded = await loadState(file, root)
    assert.equal(loaded.checkpoint.optimizationGate.status, 'STOPPED')
    assert.equal(loaded.checkpoint.optimizationGate.stopReason, 'security')
    assert.equal(loaded.checkpoint.historyCapacity.status, 'BLOCKED')
    assert.equal(loaded.checkpoint.historyCapacity.reason, 'history_capacity')
    assert.equal(loaded.tasks.length, 520)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('symlinked archive directories are rejected before cleanup can touch their targets', async t => {
  const { root, file } = await fixture()
  const outside = path.join(root, 'outside-archives')
  try {
    await fs.mkdir(outside)
    const staleTemp = path.join(outside,
      `.${'b'.repeat(64)}.123e4567-e89b-42d3-a456-426614174000.tmp`)
    await fs.writeFile(staleTemp, 'preserve outside target')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await fs.utimes(staleTemp, old, old)
    const archiveParent = path.join(root, 'docs/autonomy')
    await fs.mkdir(archiveParent, { recursive: true })
    try {
      await fs.symlink(outside, path.join(archiveParent, 'history-archives'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Symlink creation unavailable: ${error.code}`)
        return
      }
      throw error
    }
    await fs.writeFile(file, `${JSON.stringify(createInitialState())}\n`)
    await assert.rejects(loadState(file, root), /cannot contain symlinks/)
    assert.equal(await fs.readFile(staleTemp, 'utf8'), 'preserve outside target')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('concurrent writers cannot exceed history archive capacity or accept stale references', async () => {
  const { root } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    for (let index = 0; index < 511; index += 1) {
      await fs.writeFile(path.join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n')
    }
    const stateA = createInitialState()
    const stateB = createInitialState()
    startPilot(stateA)
    startPilot(stateB)
    for (let index = 0; index < 520; index += 1) {
      addTask(stateA, makeTask(`writer-a-${index}`))
      addTask(stateB, makeTask(`writer-b-${index}`))
    }
    const outcomes = await Promise.allSettled([
      saveState(path.join(root, 'a.json'), stateA, root),
      saveState(path.join(root, 'b.json'), stateB, root),
    ])
    assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'))
    const count = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).length
    assert.ok(count <= 512)
    assert.ok(outcomes.some(outcome => outcome.status === 'rejected'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('schema v1 and v2 copied fixtures load with inline history intact and no invented archive records', async () => {
  const { root } = await fixture()
  try {
    const repositoryRoot = path.resolve(__dirname, '../../..')
    const legacyBytes = await fs.readFile(path.join(repositoryRoot, 'docs/autonomy/optimization-state.json'))
    const legacyFixture = JSON.parse(legacyBytes.toString('utf8'))
    assert.equal(legacyFixture.schemaVersion, 1, 'the checked-in pilot snapshot is the legacy v1 fixture')
    const v1File = path.join(root, 'schema-v1-copy.json')
    await fs.writeFile(v1File, legacyBytes)
    const migratedV1 = await loadState(v1File, repositoryRoot)
    assert.equal(migratedV1.schemaVersion, 2)
    assert.deepEqual(migratedV1.checkpoint.historyArchives, [])
    assert.equal(migratedV1.checkpoint.events.length + migratedV1.checkpoint.eventArchives.flat().length,
      legacyFixture.checkpoint.events.length + legacyFixture.checkpoint.eventArchives.flat().length)
    assert.equal(validateState(migratedV1), migratedV1)

    // The v2 fixture uses the canonical v2 schema constructor; the repository
    // has no separately preserved historical v2 snapshot to copy.
    const v2 = createInitialState()
    startPilot(v2)
    addTask(v2, makeTask('migration-v2-copy'))
    delete v2.checkpoint.historyArchives
    const v2File = path.join(root, 'schema-v2-copy.json')
    await fs.writeFile(v2File, `${JSON.stringify(v2, null, 2)}\n`)
    const migratedV2 = await loadState(v2File, root)
    assert.equal(migratedV2.schemaVersion, 2)
    assert.deepEqual(migratedV2.checkpoint.historyArchives, [])
    assert.equal(migratedV2.tasks.length, 1)
    assert.equal(migratedV2.checkpoint.events.length, 2)
    assert.equal(validateState(migratedV2), migratedV2)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('load rejects archive references exceeding cumulative byte and aggregate record caps before reading files', async () => {
  const { root, file } = await fixture()
  try {
    const state = createInitialState()
    state.checkpoint.historyArchives = Array.from({ length: 512 }, (_, index) => ({
      digest: index.toString(16).padStart(64, '0'), bytes: 65_537,
      eventCount: 0, auditCount: 0, pilotCount: 0,
    }))
    await fs.writeFile(file, `${JSON.stringify(state)}\n`)
    await assert.rejects(loadState(file, root), /32 MiB total capacity/)
    state.checkpoint.historyArchives = Array.from({ length: 512 }, (_, index) => ({
      digest: index.toString(16).padStart(64, '0'), bytes: 2,
      eventCount: 100, auditCount: 0, pilotCount: 0,
    }))
    await fs.writeFile(file, `${JSON.stringify(state)}\n`)
    await assert.rejects(loadState(file, root), /50,000-record safety limit/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('load rejects an over-cap orphan inventory and recovers only recognized stale lock/temp artifacts', async () => {
  const { root, file } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    const state = createInitialState()
    await fs.writeFile(file, `${JSON.stringify(state)}\n`)
    for (let index = 0; index < 513; index += 1) {
      await fs.writeFile(path.join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n')
    }
    await assert.rejects(loadState(file, root), /inventory exceeds the 512-file/)
    await fs.rm(directory, { recursive: true, force: true })
    await fs.mkdir(directory, { recursive: true })

    const staleTemp = path.join(directory,
      `.${'a'.repeat(64)}.123e4567-e89b-42d3-a456-426614174000.tmp`)
    await fs.writeFile(staleTemp, 'stale')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await fs.utimes(staleTemp, old, old)
    const staleLock = path.join(directory, '.capacity.lock')
    await fs.writeFile(staleLock, JSON.stringify({
      pid: 2_147_483_647, host: os.hostname(), createdAt: old.toISOString(), token: 'dead-process-lock',
    }))
    await loadState(file, root)
    await assert.rejects(fs.access(staleTemp), { code: 'ENOENT' })
    await assert.rejects(fs.access(staleLock), { code: 'ENOENT' })

    const unknown = path.join(directory, '.unknown.tmp')
    await fs.writeFile(unknown, 'keep')
    await assert.rejects(loadState(file, root), /unexpected or unsafe entry/)
    assert.equal(await fs.readFile(unknown, 'utf8'), 'keep')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('archive-capacity preflight rejects without changing the checkpoint or revision', async () => {
  const { root, file } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    for (let index = 0; index < 512; index += 1) {
      await fs.writeFile(path.join(directory, `${String(index).padStart(64, '0')}.json`), '{}\n')
    }
    const state = createInitialState()
    startPilot(state)
    for (let index = 0; index < 520; index += 1) addTask(state, makeTask(`preflight-task-${index}`))
    const before = structuredClone(state)
    await assert.rejects(saveState(file, state, root), /capacity reached; no archive reference was accepted/)
    assert.deepEqual(state, before)
    await assert.rejects(fs.access(file), { code: 'ENOENT' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('directory scans stop at the bounded entry ceiling and preserve every unknown artifact', async () => {
  const { root, file } = await fixture()
  try {
    const directory = path.join(root, 'docs/autonomy/history-archives')
    await fs.mkdir(directory, { recursive: true })
    const names = []
    for (let index = 0; index < 546; index += 1) {
      const name = `.${index.toString(16).padStart(64, '0')}.00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.tmp`
      names.push(name)
      await fs.writeFile(path.join(directory, name), 'fresh temp')
    }
    await fs.writeFile(file, `${JSON.stringify(createInitialState())}\n`)
    await assert.rejects(loadState(file, root), /exceeds its 545-entry inspection bound/)
    assert.equal((await fs.readdir(directory)).length, 546)
    assert.equal(await fs.readFile(path.join(directory, names[0]), 'utf8'), 'fresh temp')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
