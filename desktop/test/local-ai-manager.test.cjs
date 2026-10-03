'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LocalAiError, createLocalAiManager } = require('../src/local-ai.cjs')

const capability = Object.freeze({
  localEligible: true,
  recommendation: 'enhanced-local-preview',
  modelId: 'qwen3-4b-q4-k-m',
  acceleration: 'cpu',
  releaseReady: false,
  reasons: Object.freeze([]),
  hardware: Object.freeze({
    platform: 'win32',
    arch: 'x64',
    totalMemoryBytes: 16 * 1024 ** 3,
    availableDiskBytes: 20 * 1024 ** 3,
    logicalCpuCount: 8,
    gpuDetected: true,
    gpuDetection: 'detected',
    gpuAccelerationUsable: false,
  }),
  requirements: Object.freeze({
    modelBytes: 100,
    reserveDiskBytes: 20,
    diskRequiredBytes: 120,
    minMemoryBytes: 8 * 1024 ** 3,
  }),
})

function fixture({ download } = {}) {
  let ready = false
  let removed = 0
  const store = {
    async status() { return ready ? { ready: true, bytes: 100 } : { ready: false } },
    async download(options) {
      if (download) return download(options, value => { ready = value })
      options.progress({ receivedBytes: 50, totalBytes: 100 })
      options.progress({ receivedBytes: 100, totalBytes: 100 })
      ready = true
      return { ready: true, bytes: 100 }
    },
    async remove() { removed++; ready = false; return { removed: true } },
  }
  const manager = createLocalAiManager({
    modelStore: store,
    capabilityProbe: async () => capability,
    modelMetadata: {
      id: 'qwen3-4b-q4-k-m',
      displayName: 'Qwen3 4B Q4_K_M',
      repository: 'Qwen/Qwen3-4B-GGUF',
      license: 'Apache-2.0',
    },
  })
  return { manager, store, getRemoved: () => removed, setReady: value => { ready = value } }
}

test('status strips raw hardware details and download is explicit', async () => {
  const { manager } = fixture()
  const loaded = await manager.load()
  assert.equal(loaded.model.ready, false)
  assert.deepEqual(loaded.model.metadata, {
    id: 'qwen3-4b-q4-k-m',
    displayName: 'Qwen3 4B Q4_K_M',
    repository: 'Qwen/Qwen3-4B-GGUF',
    license: 'Apache-2.0',
  })
  assert.equal('url' in loaded.model.metadata, false)
  assert.equal('sha256' in loaded.model.metadata, false)
  assert.equal(loaded.capability.hardware.gpuDetected, true)
  assert.equal('totalMemoryBytes' in loaded.capability.hardware, false)
  assert.equal(loaded.capability.requirements.modelBytes, 100)
  const started = await manager.startDownload()
  assert.equal(started.phase, 'downloading')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.status().model.ready, true)
  assert.equal(manager.status().phase, 'idle')
})

test('cancellation waits for the operation and rechecks committed state', async () => {
  let finish
  const { manager, setReady } = fixture({
    download: ({ signal, progress }, commit) => new Promise((resolve, reject) => {
      progress({ receivedBytes: 25, totalBytes: 100 })
      finish = () => {
        commit(true)
        reject(new LocalAiError('cancelled'))
      }
      signal.addEventListener('abort', finish, { once: true })
    }),
  })
  await manager.load()
  await manager.startDownload()
  assert.equal(manager.status().phase, 'downloading')
  setReady(false)
  const cancelled = await manager.cancelDownload()
  assert.equal(cancelled.phase, 'idle')
  assert.equal(cancelled.error, 'cancelled')
  assert.equal(cancelled.model.ready, true)
})

test('remove is explicit, model-only, and blocked while download is active', async () => {
  let release
  const { manager, getRemoved, setReady } = fixture({
    download: ({ signal }) => new Promise((resolve, reject) => {
      release = () => resolve({ ready: true, bytes: 100 })
      signal.addEventListener('abort', () => reject(new LocalAiError('cancelled')), { once: true })
    }),
  })
  setReady(true)
  await manager.load()
  await manager.removeModel()
  assert.equal(getRemoved(), 1)
  assert.equal(manager.status().model.ready, false)
  await manager.startDownload()
  await assert.rejects(manager.removeModel(), { code: 'busy' })
  release()
  await new Promise(resolve => setImmediate(resolve))
})

test('ineligible hardware cannot start a download', async () => {
  const store = {
    status: async () => ({ ready: false }),
    download: async () => { throw new Error('must not run') },
    remove: async () => ({ removed: true }),
  }
  const manager = createLocalAiManager({
    modelStore: store,
    capabilityProbe: async () => ({ ...capability, localEligible: false, recommendation: 'cloud-only',
      reasons: ['insufficient_memory'], requirements: null }),
  })
  await manager.load()
  await assert.rejects(manager.startDownload(), { code: 'unsupported_platform' })
})

test('dispose cancels an active download without exposing adapter failures', async () => {
  let aborted = false
  const { manager } = fixture({
    download: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new LocalAiError('cancelled'))
      }, { once: true })
    }),
  })
  await manager.load()
  await manager.startDownload()
  await manager.dispose()
  assert.equal(aborted, true)
  assert.equal(manager.status().phase, 'idle')
})


test('invalid capability data fails closed before it reaches the renderer status', async () => {
  const manager = createLocalAiManager({
    modelStore: {
      status: async () => ({ ready: false }),
      download: async () => ({ ready: true, bytes: 100 }),
      remove: async () => ({ removed: true }),
    },
    capabilityProbe: async () => ({
      ...capability,
      recommendation: 'invented-mode',
    }),
  })
  await assert.rejects(manager.load(), { code: 'invalid_capability' })
  assert.equal(manager.status().initialized, false)
  assert.equal(manager.status().error, 'invalid_capability')
})


test('corrupted cached model remains visible for explicit removal', async () => {
  let removed = 0
  const store = {
    async status() { throw new LocalAiError('invalid_model') },
    async download() { throw new Error('must remove first') },
    async remove() { removed++ },
  }
  const manager = createLocalAiManager({
    modelStore: store,
    capabilityProbe: async () => capability,
  })
  const loaded = await manager.load()
  assert.equal(loaded.model.state, 'invalid')
  assert.equal(loaded.model.ready, false)
  assert.equal(loaded.error, 'invalid_model')
  await assert.rejects(manager.startDownload(), { code: 'invalid_model' })
  const removedStatus = await manager.removeModel()
  assert.equal(removed, 1)
  assert.equal(removedStatus.model.state, 'missing')
  assert.equal(removedStatus.error, null)
})


test('invalid model disclosure metadata fails closed before status is exposed', () => {
  assert.throws(() => createLocalAiManager({
    modelStore: {
      status: async () => ({ ready: false }),
      download: async () => ({ ready: true, bytes: 100 }),
      remove: async () => ({ removed: true }),
    },
    capabilityProbe: async () => capability,
    modelMetadata: {
      id: 'qwen3-4b-q4-k-m',
      displayName: 'Qwen3 4B',
      repository: 'not-a-repository',
      license: 'Apache-2.0',
    },
  }), { code: 'invalid_model_store' })
})
