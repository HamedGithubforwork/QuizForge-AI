'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  DOWNLOAD_TIMEOUT_MS, MAX_PREPARATION_ELAPSED_MS, MODEL_BYTES, MODEL_ID, MODEL_SHA256, MODEL_URL,
  initialStatus, initializeStatus, prepareVerifiedModel, safeErrorCategory,
} = require('../scripts/prepare-targeted-practice-model.cjs')

const model = { id: MODEL_ID, bytes: MODEL_BYTES, sha256: MODEL_SHA256, url: MODEL_URL }
const shas = {
  toolSha: 'cbaa8faa1bf67a72df4184ddc84c6a3ce052b62b',
  sourceSha: '85518cf6240836448ef331260d16ba2401d7bfa7',
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-prep-test-'))
  const reportFile = path.join(directory, 'preparation.json')
  const status = initialStatus({ ...shas, cacheHit: 'false' })
  return { directory, reportFile, status, cleanup: () => fs.rm(directory, { recursive: true, force: true }) }
}

function readyResult() {
  return { ready: true, bytes: MODEL_BYTES, path: path.join('private', `${MODEL_SHA256}.gguf`) }
}

test('diagnostic preparation keeps exact model identity and uses the existing 35-minute store cap', async () => {
  const f = await fixture()
  try {
    let options
    let statuses = 0
    const result = await prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: value => {
        options = value
        return { status: async () => (++statuses === 1 ? { ready: true, ...readyResult() } : readyResult()) }
      },
    })
    assert.equal(options.downloadTimeoutMs, 35 * 60 * 1000)
    assert.equal(options.model, model)
    assert.equal(result.bytes, MODEL_BYTES)
    assert.equal(f.status.stage, 'verified')
    assert.equal(f.status.verification, 'passed')
    assert.equal(f.status.modelSource, 'verified_existing_file')
    assert.equal(f.status.downloadElapsedMs, null)
    assert.equal(f.status.progressPercent, 100)
  } finally { await f.cleanup() }
})

test('verified cache hit skips download and reports no unnecessary transfer', async () => {
  const f = await fixture()
  try {
    f.status.cache = 'hit'
    let downloads = 0
    await prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({ status: async () => readyResult(), download: async () => { downloads++ } }),
    })
    assert.equal(downloads, 0)
    assert.equal(f.status.cache, 'hit')
    assert.equal(f.status.modelSource, 'verified_cache')
    assert.equal(f.status.verification, 'passed')
  } finally { await f.cleanup() }
})

test('cache action hit with an absent model is reported as a fresh download', async () => {
  const f = await fixture()
  try {
    f.status.cache = 'hit'
    let statuses = 0
    await prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({
        status: async () => (++statuses === 1 ? { ready: false } : readyResult()),
        download: async () => {},
      }),
    })
    assert.equal(f.status.cache, 'hit')
    assert.equal(f.status.modelSource, 'downloaded')
  } finally { await f.cleanup() }
})

test('unverified restored cache fails closed without downloading or accepting it', async () => {
  const f = await fixture()
  try {
    f.status.cache = 'hit'
    let downloads = 0
    await assert.rejects(prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({
        status: async () => { throw Object.assign(new Error('private cache details'), { code: 'invalid_model' }) },
        download: async () => { downloads++ },
      }),
    }), /invalid_model/)
    assert.equal(downloads, 0)
    assert.equal(f.status.errorCategory, 'invalid_model')
    assert.equal(f.status.modelSource, 'unverified_cache')
    assert.equal(f.status.verification, 'failed')
  } finally { await f.cleanup() }
})

test('cache miss downloads once, bounds progress and verifies the resulting file', async () => {
  const f = await fixture()
  try {
    let statuses = 0
    let downloads = 0
    await prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({
        status: async () => (++statuses === 1 ? { ready: false } : readyResult()),
        download: async ({ progress }) => {
          downloads++
          progress({ receivedBytes: MODEL_BYTES / 2, totalBytes: MODEL_BYTES })
          progress({ receivedBytes: MODEL_BYTES + 1, totalBytes: MODEL_BYTES })
        },
      }),
    })
    assert.equal(downloads, 1)
    assert.equal(f.status.cache, 'miss')
    assert.equal(f.status.receivedBytes, MODEL_BYTES)
    assert.equal(f.status.progressPercent, 100)
    assert.equal(f.status.verification, 'passed')
    assert.equal(f.status.modelSource, 'downloaded')
    assert.ok(f.status.downloadElapsedMs >= 0)
  } finally { await f.cleanup() }
})

test('pinned model SHA, byte count, and URL revision mismatch are rejected before store access', async () => {
  const f = await fixture()
  try {
    let storeCalls = 0
    for (const changedModel of [
      { ...model, sha256: '0'.repeat(64) },
      { ...model, bytes: MODEL_BYTES + 1 },
      { ...model, url: MODEL_URL.replace('bc640142c66e1fdd12af0bd68f40445458f3869b', 'main') },
    ]) {
      await assert.rejects(prepareVerifiedModel({
        model: changedModel, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
        createStore: () => { storeCalls++; throw new Error('must not run') },
      }), /invalid_model/)
    }
    assert.equal(storeCalls, 0)
    assert.equal(f.status.errorCategory, 'invalid_model')
    assert.equal(f.status.verification, 'failed')
  } finally { await f.cleanup() }
})

test('store rejects size or checksum mismatch and preparation remains failed', async () => {
  const f = await fixture()
  try {
    await assert.rejects(prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({ status: async () => ({ ready: false }),
        download: async () => { throw Object.assign(new Error('private details'), { code: 'invalid_download' }) } }),
    }), /invalid_download/)
    assert.equal(f.status.errorCategory, 'invalid_download')
    assert.equal(f.status.modelSource, 'download_failed')
    assert.equal(f.status.verification, 'failed')
  } finally { await f.cleanup() }
})

test('download timeout is classified without exposing the underlying error', async () => {
  const f = await fixture()
  try {
    await assert.rejects(prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      createStore: () => ({ status: async () => ({ ready: false }),
        download: async () => { throw Object.assign(new Error('private path and URL'), { name: 'TimeoutError', code: 23 }) } }),
    }), /timed_out/)
    assert.equal(f.status.errorCategory, 'timed_out')
    assert.equal(JSON.stringify(f.status).includes('private path'), false)
  } finally { await f.cleanup() }
})

test('bounded status heartbeat records a stalled transfer and allowlisted timeout', async () => {
  const f = await fixture()
  try {
    let clock = 100
    let tick
    let rejectDownload
    let enteredDownload
    const downloading = new Promise(resolve => { enteredDownload = resolve })
    const result = prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      now: () => clock,
      startHeartbeat: callback => { tick = callback; return callback },
      stopHeartbeat: () => {},
      createStore: () => ({
        status: async () => ({ ready: false }),
        download: async () => {
          enteredDownload()
          return new Promise((_, reject) => { rejectDownload = reject })
        },
      }),
    })
    await downloading
    clock += 61_000
    tick()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.status.progressState, 'stalled')
    rejectDownload(Object.assign(new Error('private timeout details'), { name: 'TimeoutError', code: 23 }))
    await assert.rejects(result, /timed_out/)
    assert.equal(f.status.progressState, 'stalled')
    assert.equal(f.status.errorCategory, 'timed_out')
    assert.ok(f.status.elapsedMs <= MAX_PREPARATION_ELAPSED_MS)
    assert.ok(f.status.downloadElapsedMs > 0)
    assert.ok(f.status.downloadElapsedMs <= DOWNLOAD_TIMEOUT_MS)
  } finally { await f.cleanup() }
})

test('cancellation signal is forwarded and reported as a bounded category', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    let receivedSignal
    await assert.rejects(prepareVerifiedModel({
      model, directory: 'private-model-dir', status: f.status, statusFile: f.reportFile,
      signal: controller.signal,
      createStore: () => ({ status: async () => ({ ready: false }),
        download: async ({ signal }) => {
          receivedSignal = signal
          throw Object.assign(new Error('private'), { name: 'AbortError' })
        } }),
    }), /cancelled/)
    assert.equal(receivedSignal, controller.signal)
    assert.equal(f.status.errorCategory, 'cancelled')
  } finally { await f.cleanup() }
})

test('preparation status includes exact revisions and excludes private diagnostics', async () => {
  const f = await fixture()
  try {
    await initializeStatus({ reportFile: f.reportFile, ...shas })
    const saved = JSON.parse(await fs.readFile(f.reportFile, 'utf8'))
    assert.equal(saved.diagnosticToolSha, shas.toolSha)
    assert.equal(saved.sourceSha, shas.sourceSha)
    assert.equal(saved.cache, 'unknown')
    assert.equal(saved.stage, 'pending')
    assert.equal(saved.modelSource, 'unknown')
    for (const forbidden of ['private-model-dir', 'https://', 'prompt', 'study notes', 'token=']) {
      assert.equal(JSON.stringify(saved).includes(forbidden), false)
    }
    assert.equal(safeErrorCategory(Object.assign(new Error('secret'), { code: 'unknown_private_code' })), 'model_store_failed')
    assert.equal(DOWNLOAD_TIMEOUT_MS, 35 * 60 * 1000)
    assert.equal(MAX_PREPARATION_ELAPSED_MS, 55 * 60 * 1000)
  } finally { await f.cleanup() }
})

test('CLI preserves sanitized failure status when pinned application loading fails', async () => {
  const f = await fixture()
  try {
    await initializeStatus({ reportFile: f.reportFile, ...shas })
    const appRoot = path.join(f.directory, 'app-root')
    const modelDirectory = path.join(f.directory, 'private-model-directory')
    await fs.mkdir(path.join(appRoot, 'desktop/src'), { recursive: true })
    await fs.writeFile(path.join(appRoot, 'desktop/src/local-model-store.cjs'),
      "throw new Error('PRIVATE_IMPORT_PATH sentinel')\n")
    const entry = path.join(__dirname, '../scripts/prepare-targeted-practice-model.cjs')
    const child = spawnSync(process.execPath, [entry, 'prepare', appRoot, modelDirectory, f.reportFile, 'false'], {
      encoding: 'utf8',
    })
    assert.equal(child.status, 1)
    const saved = JSON.parse(await fs.readFile(f.reportFile, 'utf8'))
    assert.equal(saved.stage, 'failed')
    assert.equal(saved.verification, 'failed')
    assert.equal(saved.errorCategory, 'model_store_failed')
    assert.equal(saved.diagnosticToolSha, shas.toolSha)
    assert.equal(saved.sourceSha, shas.sourceSha)
    assert.equal(JSON.stringify(saved).includes('PRIVATE_IMPORT_PATH'), false)
    assert.equal(JSON.stringify(saved).includes(appRoot), false)
    assert.equal(child.stdout.includes('PRIVATE_IMPORT_PATH'), false)
    assert.equal(child.stderr.includes('PRIVATE_IMPORT_PATH'), false)
  } finally { await f.cleanup() }
})
