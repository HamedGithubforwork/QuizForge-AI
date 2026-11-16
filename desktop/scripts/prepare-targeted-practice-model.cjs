'use strict'

// Diagnostic-only bounded preparation for the pinned Qwen3-4B model. The
// application store remains responsible for URL allowlisting, byte limits,
// temporary-file cleanup, and the final SHA-256 verification.
const fs = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const MODEL_ID = 'qwen3-4b-q4-k-m'
const MODEL_BYTES = 2_497_280_256
const MODEL_SHA256 = '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5'
const MODEL_URL = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf'
const DOWNLOAD_TIMEOUT_MS = 35 * 60 * 1000
const MAX_PREPARATION_ELAPSED_MS = 55 * 60 * 1000
const MAX_PROGRESS_BYTES = MODEL_BYTES
const SAFE_ERRORS = new Set([
  'cancelled', 'insufficient_disk', 'invalid_download', 'invalid_model',
  'model_store_failed', 'timed_out', 'unapproved_download', 'unsafe_directory',
  'unsafe_model',
])
const SAFE_STAGES = new Set(['pending', 'checking_cache', 'downloading', 'verified', 'failed'])

function safeSha(value) {
  return /^[a-f0-9]{40}$/.test(value ?? '') ? value : 'unknown'
}

function initialStatus({ toolSha, sourceSha, cacheHit }) {
  return {
    schema: 1,
    diagnostic: 'targeted-practice-model-preparation',
    diagnosticToolSha: safeSha(toolSha),
    sourceSha: safeSha(sourceSha),
    modelId: MODEL_ID,
    modelSha256: MODEL_SHA256,
    expectedBytes: MODEL_BYTES,
    cache: ['true', 'false'].includes(cacheHit) ? (cacheHit === 'true' ? 'hit' : 'miss') : 'unknown',
    stage: 'pending',
    runtimeSetupStarted: false,
    inferenceStarted: false,
    elapsedMs: 0,
    downloadElapsedMs: null,
    receivedBytes: 0,
    progressPercent: 0,
    progressState: 'not_started',
    modelSource: 'unknown',
    verification: 'not_started',
    errorCategory: null,
  }
}

async function persistStatus(file, status) {
  const temporary = `${file}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}

function safeErrorCategory(error) {
  if (error?.name === 'TimeoutError') return 'timed_out'
  if (error?.name === 'AbortError') return 'cancelled'
  const code = typeof error?.code === 'string' && SAFE_ERRORS.has(error.code) ? error.code : null
  return code ?? 'model_store_failed'
}

function assertPinnedModel(model) {
  if (model?.id !== MODEL_ID || model?.bytes !== MODEL_BYTES ||
      model?.sha256 !== MODEL_SHA256 || model?.url !== MODEL_URL) {
    throw Object.assign(new Error('Pinned diagnostic model mismatch'), { code: 'invalid_model' })
  }
}

async function prepareVerifiedModel({
  model, directory, createStore, status, statusFile, signal,
  now = () => performance.now(), heartbeatMs = 10_000,
  startHeartbeat = setInterval, stopHeartbeat = clearInterval,
}) {
  const started = now()
  let lastProgressAt = started
  let previousBytes = 0
  let downloadStartedAt = null
  let heartbeat
  let persistFailure = false
  let writeQueue = Promise.resolve()
  const persist = async () => {
    const elapsed = Math.max(0, Math.round(now() - started))
    status.elapsedMs = Math.min(MAX_PREPARATION_ELAPSED_MS, elapsed)
    if (downloadStartedAt !== null) {
      status.downloadElapsedMs = Math.min(DOWNLOAD_TIMEOUT_MS, Math.max(0, Math.round(now() - downloadStartedAt)))
    }
    if (status.stage === 'downloading') {
      status.progressState = now() - lastProgressAt >= 60_000 ? 'stalled' :
        status.receivedBytes === 0 ? 'waiting' : 'progressing'
    }
    writeQueue = writeQueue.then(() => persistStatus(statusFile, status))
    await writeQueue
  }
  const progress = ({ receivedBytes, totalBytes }) => {
    if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || receivedBytes > MAX_PROGRESS_BYTES ||
        totalBytes !== MODEL_BYTES) return
    if (receivedBytes > previousBytes) lastProgressAt = now()
    previousBytes = Math.max(previousBytes, receivedBytes)
    status.receivedBytes = previousBytes
    status.progressPercent = Math.floor(previousBytes / MODEL_BYTES * 100)
    status.progressState = 'progressing'
  }

  try {
    assertPinnedModel(model)
    status.stage = 'checking_cache'
    status.verification = 'checking'
    await persist()
    const store = createStore({ directory, model, downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS })
    heartbeat = startHeartbeat(() => { void persist().catch(() => { persistFailure = true }) }, heartbeatMs)
    let result = await store.status({ signal })
    if (result.ready) status.modelSource = status.cache === 'hit' ? 'verified_cache' : 'verified_existing_file'
    if (!result.ready) {
      status.stage = 'downloading'
      status.progressState = 'waiting'
      status.modelSource = 'download_failed'
      downloadStartedAt = now()
      await persist()
      await store.download({ signal, progress })
      result = await store.status({ signal })
    }
    if (!result.ready || result.bytes !== MODEL_BYTES || path.basename(result.path) !== `${MODEL_SHA256}.gguf`) {
      throw Object.assign(new Error('Pinned model verification failed'), { code: 'invalid_model' })
    }
    if (status.modelSource === 'download_failed') status.modelSource = 'downloaded'
    status.stage = 'verified'
    status.verification = 'passed'
    status.progressState = 'complete'
    status.receivedBytes = MODEL_BYTES
    status.progressPercent = 100
    await persist()
    if (persistFailure) throw Object.assign(new Error('Status persistence failed'), { code: 'model_store_failed' })
    return result
  } catch (error) {
    if (status.stage === 'checking_cache' && status.cache === 'hit') status.modelSource = 'unverified_cache'
    status.stage = 'failed'
    status.verification = 'failed'
    if (!['stalled', 'progressing'].includes(status.progressState)) status.progressState = 'unknown'
    status.errorCategory = safeErrorCategory(error)
    await persist()
    throw Object.assign(new Error(status.errorCategory), { code: status.errorCategory })
  } finally {
    if (heartbeat) stopHeartbeat(heartbeat)
  }
}

async function initializeStatus({ reportFile, toolSha, sourceSha }) {
  await fs.mkdir(path.dirname(reportFile), { recursive: true })
  await persistStatus(reportFile, initialStatus({ toolSha, sourceSha, cacheHit: 'unknown' }))
}

async function markStarted({ reportFile, stage }) {
  const status = JSON.parse(await fs.readFile(reportFile, 'utf8'))
  if (stage === 'runtime_setup') status.runtimeSetupStarted = true
  else if (stage === 'inference') {
    status.runtimeSetupStarted = true
    status.inferenceStarted = true
  } else throw new Error('Invalid diagnostic lifecycle stage')
  await persistStatus(reportFile, status)
}

async function cli(args) {
  if (args[0] === 'initialize' && args.length === 4) {
    await initializeStatus({ reportFile: path.resolve(args[1]), toolSha: args[2], sourceSha: args[3] })
    return
  }
  if (args[0] === 'mark' && args.length === 3) {
    await markStarted({ reportFile: path.resolve(args[1]), stage: args[2] })
    return
  }
  if (args[0] !== 'prepare' || args.length !== 5) {
    throw new Error('Usage: initialize <report> <tool-sha> <source-sha> | mark <report> <runtime_setup|inference> | prepare <app-root> <model-dir> <report> <cache-hit>')
  }
  const appRoot = path.resolve(args[1])
  const reportFile = path.resolve(args[3])
  const status = JSON.parse(await fs.readFile(reportFile, 'utf8'))
  status.cache = ['true', 'false'].includes(args[4]) ? (args[4] === 'true' ? 'hit' : 'miss') : 'unknown'
  try {
    const { CANDIDATE, createLocalModelStore } = require(path.join(appRoot, 'desktop/src/local-model-store.cjs'))
    const modelDirectory = path.resolve(args[2])
    await prepareVerifiedModel({
      model: CANDIDATE,
      directory: modelDirectory,
      createStore: options => createLocalModelStore(options),
      status,
      statusFile: reportFile,
    })
  } catch (error) {
    if (status.stage !== 'failed') {
      status.stage = 'failed'
      status.verification = 'failed'
      status.errorCategory = safeErrorCategory(error)
      await persistStatus(reportFile, status)
    }
    throw error
  }
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch(error => {
    console.error('Pinned diagnostic model preparation failed:', safeErrorCategory(error))
    process.exitCode = 1
  })
}

module.exports = {
  DOWNLOAD_TIMEOUT_MS, MAX_PREPARATION_ELAPSED_MS, MODEL_BYTES, MODEL_ID, MODEL_SHA256, MODEL_URL,
  assertPinnedModel, initialStatus, initializeStatus, markStarted, prepareVerifiedModel, safeErrorCategory,
}
