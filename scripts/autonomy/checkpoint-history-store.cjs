'use strict'

// Filesystem boundary for immutable, content-addressed checkpoint history.
// The state machine owns lifecycle semantics; this module only stores and
// restores the event/audit/pilot-summary streams.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const ARCHIVE_DIRECTORY = 'docs/autonomy/history-archives'
const MAX_ARCHIVE_FILE_BYTES = 256 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_FILES = 512
const MAX_TEMP_ARTIFACTS = 32
const MAX_DIRECTORY_ENTRIES = MAX_ARCHIVE_FILES + MAX_TEMP_ARTIFACTS + 1
const MAX_HISTORY_RECORDS = 50_000
const STALE_ARTIFACT_MS = 24 * 60 * 60 * 1000
const MAX_INLINE_EVENTS = 500
const MAX_INLINE_AUDITS = 100
const MAX_INLINE_PILOT_SUMMARIES = 25

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function archivePath(root, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid history archive digest')
  const directory = path.resolve(root, ARCHIVE_DIRECTORY)
  const target = path.resolve(directory, `${hash}.json`)
  if (path.dirname(target) !== directory) throw new Error('History archive path escapes its directory')
  return { directory, target }
}

async function inspectArchiveDirectory(root, { create = false, required = false } = {}) {
  const rootPath = path.resolve(root)
  const rootStat = await fs.lstat(rootPath).catch(error => {
    if (error.code === 'ENOENT') throw new Error('History archive repository root is missing')
    throw error
  })
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || path.resolve(await fs.realpath(rootPath)) !== rootPath) {
    throw new Error('History archive repository root must be a real directory')
  }
  let cursor = rootPath
  for (const segment of ARCHIVE_DIRECTORY.split('/')) {
    cursor = path.join(cursor, segment)
    let stat
    try { stat = await fs.lstat(cursor) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) {
        if (required) throw new Error('History archive directory is missing')
        return null
      }
      try { await fs.mkdir(cursor) } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError }
      stat = await fs.lstat(cursor)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || path.resolve(await fs.realpath(cursor)) !== cursor) {
      throw new Error('History archive path cannot contain symlinks')
    }
  }
  return cursor
}

async function ensureDirectory(root) {
  return inspectArchiveDirectory(root, { create: true, required: true })
}

function allHistory(state) {
  const checkpoint = state.checkpoint
  return {
    events: [...checkpoint.eventArchives.flat(), ...checkpoint.events],
    audits: checkpoint.optimizationGate.auditHistory,
    pilotSummaries: [...checkpoint.archivedPilotHistory.flat(), ...checkpoint.pilotHistory],
  }
}

function countRefs(refs, key) {
  return refs.reduce((sum, reference) => sum + reference[key], 0)
}

function validateRef(reference) {
  if (!reference || Object.keys(reference).sort().join(',') !==
      'auditCount,bytes,digest,eventCount,pilotCount') throw new Error('Invalid history archive reference')
  if (!/^[a-f0-9]{64}$/.test(reference.digest) ||
      !Number.isSafeInteger(reference.bytes) || reference.bytes < 2 || reference.bytes > MAX_ARCHIVE_FILE_BYTES ||
      ['eventCount', 'auditCount', 'pilotCount'].some(key =>
        !Number.isSafeInteger(reference[key]) || reference[key] < 0)) {
    throw new Error('Invalid bounded history archive reference')
  }
}

function validateRefs(refs, inlineRecords = 0) {
  if (!Array.isArray(refs) || refs.length > MAX_ARCHIVE_FILES) throw new Error('History archive reference capacity is invalid')
  const digests = new Set()
  let bytes = 0
  let records = inlineRecords
  for (const reference of refs) {
    validateRef(reference)
    if (digests.has(reference.digest)) throw new Error('Duplicate history archive digest reference')
    digests.add(reference.digest)
    bytes += reference.bytes
    if (bytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('Referenced history archives exceed the 32 MiB total capacity')
    records += reference.eventCount + reference.auditCount + reference.pilotCount
    if (records > MAX_HISTORY_RECORDS) throw new Error('Referenced checkpoint history exceeds the 50,000-record safety limit')
  }
  return { bytes, records }
}

async function archiveInventory(directory) {
  let count = 0
  let bytes = 0
  let tempCount = 0
  let entryCount = 0
  const sizes = new Map()
  let handle
  try { handle = await fs.opendir(directory) } catch (error) {
    if (error.code === 'ENOENT') return { count, bytes, sizes }
    throw error
  }
  for await (const entry of handle) {
    entryCount += 1
    if (entryCount > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`History archive directory exceeds its ${MAX_DIRECTORY_ENTRIES}-entry inspection bound`)
    }
    if (entry.name === '.capacity.lock') {
      if (!entry.isFile()) throw new Error('History capacity lock is not a regular file')
      continue
    }
    const isTemp = /^\.[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(entry.name)
    if ((!isTemp && !/^[a-f0-9]{64}\.json$/.test(entry.name)) || !entry.isFile()) {
      throw new Error('History archive directory contains an unexpected or unsafe entry')
    }
    const stat = await fs.lstat(path.join(directory, entry.name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error('History archive inventory contains an unsafe or oversized artifact')
    }
    bytes += stat.size
    if (isTemp) {
      tempCount += 1
      if (tempCount > MAX_TEMP_ARTIFACTS) throw new Error('History archive temporary-artifact overhead exceeds its bound')
    } else {
      count += 1
      sizes.set(entry.name.slice(0, -5), stat.size)
    }
  }
  return { count, bytes, sizes, tempCount, entryCount }
}

async function readStableFile(filePath, maxBytes, expectedBytes = null) {
  const before = await fs.lstat(filePath)
  const targetBytes = expectedBytes ?? before.size
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes ||
      (expectedBytes !== null && before.size !== expectedBytes)) throw new Error('Archive artifact size or type is invalid')
  const handle = await fs.open(filePath, 'r')
  try {
    const opened = await handle.stat()
    const named = await fs.lstat(filePath)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) {
      throw new Error('Archive artifact changed before bounded read')
    }
    const buffer = Buffer.alloc(targetBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (!bytesRead) break
      total += bytesRead
      if (total > targetBytes) throw new Error('Archive artifact exceeded its bounded read size')
    }
    const after = await handle.stat()
    const finalNamed = await fs.lstat(filePath)
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== targetBytes || total !== targetBytes ||
        finalNamed.dev !== before.dev || finalNamed.ino !== before.ino || finalNamed.isSymbolicLink()) {
      throw new Error('Archive artifact changed during bounded read')
    }
    return buffer.subarray(0, total)
  } finally { await handle.close() }
}

function isDeadLocalProcess(pid, hostname) {
  if (hostname !== require('node:os').hostname()) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) { return error.code === 'ESRCH' }
}

async function removeIfUnchanged(filePath, before, expectedText) {
  const after = await fs.lstat(filePath).catch(() => null)
  let text
  if (expectedText !== undefined) {
    try { text = (await readStableFile(filePath, 2048, before.size)).toString('utf8') } catch { return false }
  }
  if (!after || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      (expectedText !== undefined && text !== expectedText)) return false
  await fs.unlink(filePath)
  return true
}

async function cleanupStaleArtifacts(directory) {
  let entryCount = 0
  let hasLock = false
  let first
  try { first = await fs.opendir(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for await (const entry of first) {
    entryCount += 1
    if (entryCount > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`History archive directory exceeds its ${MAX_DIRECTORY_ENTRIES}-entry inspection bound`)
    }
    if (entry.name === '.capacity.lock') hasLock = true
  }
  if (hasLock) {
    const lockPath = path.join(directory, '.capacity.lock')
    const before = await fs.lstat(lockPath)
    if (before.isSymbolicLink() || !before.isFile() || before.size > 2048) {
      throw new Error('History capacity lock is unsafe; inspect it manually')
    }
    const text = (await readStableFile(lockPath, 2048, before.size)).toString('utf8')
    let owner
    try { owner = JSON.parse(text) } catch { owner = null }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string' ||
        typeof owner.token !== 'string' || !Number.isFinite(Date.parse(owner.createdAt)) ||
        !isDeadLocalProcess(owner.pid, owner.host)) {
      throw new Error('History capacity lock is active or unverified; refusing to recover it')
    }
    if (!await removeIfUnchanged(lockPath, before, text)) {
      throw new Error('History capacity lock changed during recovery')
    }
  }
  let second
  try { second = await fs.opendir(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  let secondCount = 0
  for await (const entry of second) {
    secondCount += 1
    if (secondCount > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`History archive directory exceeds its ${MAX_DIRECTORY_ENTRIES}-entry inspection bound`)
    }
    if (!/^\.[a-f0-9]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(entry.name)) continue
    const filePath = path.join(directory, entry.name)
    const before = await fs.lstat(filePath)
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_ARCHIVE_FILE_BYTES ||
        Date.now() - before.mtimeMs < STALE_ARTIFACT_MS) continue
    await removeIfUnchanged(filePath, before)
  }
}

async function readArchive(root, reference) {
  validateRef(reference)
  await inspectArchiveDirectory(root, { required: true })
  const { directory, target } = archivePath(root, reference.digest)
  const statDir = await fs.lstat(directory).catch(error => {
    if (error.code === 'ENOENT') throw new Error('History archive directory is missing')
    throw error
  })
  if (statDir.isSymbolicLink() || !statDir.isDirectory()) throw new Error('History archive directory is unsafe')
  let bytes
  try { bytes = await readStableFile(target, MAX_ARCHIVE_FILE_BYTES, reference.bytes) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('History archive artifact is missing')
    throw error
  }
  if (digest(bytes) !== reference.digest) throw new Error('History archive SHA-256 does not match its reference')
  let archive
  try { archive = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('History archive is invalid JSON') }
  if (!archive || archive.schemaVersion !== 1 || Object.keys(archive).sort().join(',') !==
      'audits,events,pilotSummaries,schemaVersion' ||
      !Array.isArray(archive.events) || !Array.isArray(archive.audits) || !Array.isArray(archive.pilotSummaries) ||
      archive.events.length !== reference.eventCount || archive.audits.length !== reference.auditCount ||
      archive.pilotSummaries.length !== reference.pilotCount || canonicalJson(archive) !== bytes.toString('utf8')) {
    throw new Error('History archive manifest does not match its reference')
  }
  return archive
}

async function hydrateHistory(state, root) {
  const refs = state.checkpoint.historyArchives ?? []
  const checkpoint = state.checkpoint
  const inlineRecords = (checkpoint.events?.length ?? 0) +
    (checkpoint.eventArchives ?? []).reduce((sum, chunk) => sum + (Array.isArray(chunk) ? chunk.length : MAX_HISTORY_RECORDS), 0) +
    (checkpoint.optimizationGate?.auditHistory?.length ?? 0) +
    (checkpoint.pilotHistory?.length ?? 0) +
    (checkpoint.archivedPilotHistory ?? []).reduce((sum, chunk) => sum + (Array.isArray(chunk) ? chunk.length : MAX_HISTORY_RECORDS), 0)
  validateRefs(refs, inlineRecords)
  const directory = await inspectArchiveDirectory(root, { required: refs.length > 0 })
  if (directory) await cleanupStaleArtifacts(directory)
  const inventory = directory ? await archiveInventory(directory) : { count: 0, bytes: 0, sizes: new Map() }
  if (inventory.count > MAX_ARCHIVE_FILES || inventory.bytes > MAX_ARCHIVE_TOTAL_BYTES) {
    throw new Error('History archive inventory exceeds the 512-file / 32 MiB capacity')
  }
  let events = []
  let audits = []
  let pilotSummaries = []
  for (const reference of refs) {
    const archive = await readArchive(root, reference)
    events.push(...archive.events)
    audits.push(...archive.audits)
    pilotSummaries.push(...archive.pilotSummaries)
  }
  checkpoint.eventArchives ??= []
  checkpoint.events ??= []
  checkpoint.archivedPilotHistory ??= []
  checkpoint.pilotHistory ??= []
  checkpoint.optimizationGate ??= {
    status: 'ACTIVE', consecutiveCleanAudits: 0, lastAuditRefs: [], lastAuditedDimensions: [],
    stopReason: null, finalReport: null, auditHistory: [],
  }
  checkpoint.optimizationGate.auditHistory ??= []
  const fullEvents = [...events, ...checkpoint.eventArchives.flat(), ...checkpoint.events]
  checkpoint.eventArchives = fullEvents.slice(0, -MAX_INLINE_EVENTS).reduce((chunks, event) => {
      if (!chunks.length || chunks.at(-1).length >= 250) chunks.push([])
      chunks.at(-1).push(event)
    return chunks
  }, [])
  checkpoint.events = fullEvents.slice(-MAX_INLINE_EVENTS)
  const fullPilots = [...pilotSummaries, ...checkpoint.archivedPilotHistory.flat(), ...checkpoint.pilotHistory]
  checkpoint.archivedPilotHistory = fullPilots.slice(0, -MAX_INLINE_PILOT_SUMMARIES).reduce((chunks, summary) => {
    if (!chunks.length || chunks.at(-1).length >= 25) chunks.push([])
    chunks.at(-1).push(summary)
    return chunks
  }, [])
  checkpoint.pilotHistory = fullPilots.slice(-MAX_INLINE_PILOT_SUMMARIES)
  checkpoint.optimizationGate.auditHistory = [...audits, ...checkpoint.optimizationGate.auditHistory]
  checkpoint.historyArchives = refs
  return state
}

async function writeArchive(root, archive) {
  const bytes = Buffer.from(canonicalJson(archive), 'utf8')
  if (bytes.length > MAX_ARCHIVE_FILE_BYTES) throw new Error('History archive chunk exceeds its bounded size')
  const hash = digest(bytes)
  const directory = await ensureDirectory(root)
  const { target } = archivePath(root, hash)
  const reference = {
    digest: hash, bytes: bytes.length,
    eventCount: archive.events.length, auditCount: archive.audits.length,
    pilotCount: archive.pilotSummaries.length,
  }
  try {
    const existingStat = await fs.lstat(target)
    if (existingStat.isSymbolicLink() || !existingStat.isFile() || existingStat.size !== bytes.length) {
      throw new Error('Existing history archive artifact has an invalid type or size')
    }
    const existing = await readStableFile(target, MAX_ARCHIVE_FILE_BYTES, bytes.length)
    if (!existing.equals(bytes)) throw new Error('Existing content-addressed history archive differs')
    return reference
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`)
  let handle
  let ownedTemporaryStat
  try {
    handle = await fs.open(temporary, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    ownedTemporaryStat = await handle.stat()
    await handle.close()
    handle = null
    try { await fs.link(temporary, target) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = await readStableFile(target, MAX_ARCHIVE_FILE_BYTES, bytes.length)
      if (!existing.equals(bytes)) throw new Error('Concurrent history archive content differs')
    }
  } finally {
    await handle?.close().catch(() => {})
    const currentTemporary = await fs.lstat(temporary).catch(() => null)
    if (ownedTemporaryStat && currentTemporary && !currentTemporary.isSymbolicLink() &&
        currentTemporary.dev === ownedTemporaryStat.dev && currentTemporary.ino === ownedTemporaryStat.ino) {
      await fs.unlink(temporary).catch(() => {})
    }
  }
  return reference
}

async function prepareHistoryForPersistence(state, root) {
  const checkpoint = state.checkpoint
  const refs = checkpoint.historyArchives ?? []
  validateRefs(refs)
  const existingBytes = refs.reduce((sum, reference) => sum + reference.bytes, 0)
  if (existingBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('History archive capacity is invalid')
  const history = allHistory(state)
  const inline = {
    events: history.events.slice(-MAX_INLINE_EVENTS),
    audits: history.audits.slice(-MAX_INLINE_AUDITS),
    pilotSummaries: history.pilotSummaries.slice(-MAX_INLINE_PILOT_SUMMARIES),
  }
  const archivedCounts = {
    events: countRefs(refs, 'eventCount'), audits: countRefs(refs, 'auditCount'),
    pilotSummaries: countRefs(refs, 'pilotCount'),
  }
  const totals = {
    events: history.events.length, audits: history.audits.length,
    pilotSummaries: history.pilotSummaries.length,
  }
  const additions = {
    events: history.events.slice(archivedCounts.events, Math.max(archivedCounts.events, totals.events - inline.events.length)),
    audits: history.audits.slice(archivedCounts.audits, Math.max(archivedCounts.audits, totals.audits - inline.audits.length)),
    pilotSummaries: history.pilotSummaries.slice(archivedCounts.pilotSummaries,
      Math.max(archivedCounts.pilotSummaries, totals.pilotSummaries - inline.pilotSummaries.length)),
  }
  if (Object.values(additions).some(list => list.length)) {
    const remaining = { ...additions }
    const archives = []
    while (Object.values(remaining).some(list => list.length)) {
      const archive = { schemaVersion: 1, events: [], audits: [], pilotSummaries: [] }
      for (const [key, limit] of [['events', 100], ['audits', 12], ['pilotSummaries', 25]]) {
        archive[key] = remaining[key].splice(0, limit)
        while (archive[key].length && Buffer.byteLength(canonicalJson(archive)) > MAX_ARCHIVE_FILE_BYTES) {
          remaining[key].unshift(archive[key].pop())
        }
      }
      if (!archive.events.length && !archive.audits.length && !archive.pilotSummaries.length) {
        throw new Error('History record cannot fit in a bounded archive chunk')
      }
      archives.push(archive)
    }
    const directory = await ensureDirectory(root)
    const lockPath = path.join(directory, '.capacity.lock')
    await cleanupStaleArtifacts(directory)
    let capacityLock
    try { capacityLock = await fs.open(lockPath, 'wx') } catch (error) {
      if (error.code === 'EEXIST') throw new Error('History archive capacity is being updated concurrently; retry after the active checkpoint save completes')
      throw error
    }
    const lockToken = crypto.randomUUID()
    const lockData = JSON.stringify({
      pid: process.pid, host: require('node:os').hostname(), createdAt: new Date().toISOString(), token: lockToken,
    })
    let lockStat
    try {
      await capacityLock.writeFile(lockData)
      await capacityLock.sync()
      lockStat = await capacityLock.stat()
      const before = await archiveInventory(directory)
      const info = archives.map(archive => {
        const bytes = Buffer.from(canonicalJson(archive), 'utf8')
        if (bytes.length > MAX_ARCHIVE_FILE_BYTES) throw new Error('History archive chunk exceeds its bounded size')
        const hash = digest(bytes)
        return { archive, hash, bytes }
      })
      const uniqueNew = info.filter(item => !before.sizes.has(item.hash))
      if (before.count + uniqueNew.length > MAX_ARCHIVE_FILES ||
          before.bytes + uniqueNew.reduce((sum, item) => sum + item.bytes.length, 0) > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error('History archive capacity reached; no archive reference was accepted and all source records remain intact')
      }
      const newRefs = []
      for (const item of info) newRefs.push(await writeArchive(root, item.archive))
      const refsNext = [...refs, ...newRefs]
      validateRefs(refsNext)
      checkpoint.historyArchives = refsNext
      const after = await archiveInventory(directory)
      // Reserve one chunk of space for a durable BLOCKED history-capacity
      // checkpoint before the finite archive fills completely.
      if (after.count >= MAX_ARCHIVE_FILES - 1 || after.bytes >= MAX_ARCHIVE_TOTAL_BYTES - MAX_ARCHIVE_FILE_BYTES) {
        const gate = checkpoint.optimizationGate
        checkpoint.historyCapacity = {
          status: 'BLOCKED', reason: 'history_capacity', recordedAt: new Date().toISOString(),
        }
        if (gate.status !== 'STOPPED' && !(gate.status === 'BLOCKED' && gate.stopReason === 'approval')) {
          gate.status = 'BLOCKED'
          gate.stopReason = 'history_capacity'
          gate.consecutiveCleanAudits = 0
          gate.finalReport = null
        }
      }
    } finally {
      await capacityLock.close().catch(() => {})
      const currentStat = await fs.lstat(lockPath).catch(() => null)
      const currentText = currentStat
        ? await readStableFile(lockPath, 2048, currentStat.size).then(bytes => bytes.toString('utf8')).catch(() => null)
        : null
      if (lockStat && currentStat && !currentStat.isSymbolicLink() && currentStat.dev === lockStat.dev &&
          currentStat.ino === lockStat.ino && currentText === lockData) {
        await fs.unlink(lockPath).catch(() => {})
      }
    }
  }
  const persisted = JSON.parse(JSON.stringify(state))
  persisted.checkpoint.historyArchives = checkpoint.historyArchives ?? []
  persisted.checkpoint.eventArchives = []
  persisted.checkpoint.events = inline.events
  persisted.checkpoint.optimizationGate.auditHistory = inline.audits
  persisted.checkpoint.archivedPilotHistory = []
  persisted.checkpoint.pilotHistory = inline.pilotSummaries
  return persisted
}

module.exports = {
  MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_TOTAL_BYTES, MAX_ARCHIVE_FILES,
  validateRef, validateRefs, hydrateHistory, prepareHistoryForPersistence,
}
