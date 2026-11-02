'use strict'

const path = require('node:path')
const { createLocalAiManager, createModelStoreContract } = require('./local-ai.cjs')
const { CANDIDATE, createLocalModelStore } = require('./local-model-store.cjs')
const { getBenchmarkModel } = require('./local-benchmark-models.cjs')
const { probeWindowsLocalAiCapability, WINDOWS_EXPERIMENTAL_PROFILES } = require('./windows-hardware-probe.cjs')

function createWindowsLocalAiResources({
  userDataDirectory,
  modelDirectory = path.join(userDataDirectory, 'local-ai', 'models'),
  runtimeDirectory,
  benchmarkModelId = null,
} = {}) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory) ||
      typeof modelDirectory !== 'string' || !path.isAbsolute(modelDirectory)) {
    throw new Error('Local AI manager configuration is invalid.')
  }
  // Benchmark override is an internal, allowlisted evaluation path only.
  // The shipped desktop continues to default to the verified Qwen candidate.
  const candidate = benchmarkModelId === null ? CANDIDATE : getBenchmarkModel(benchmarkModelId)
  const rawModelStore = createLocalModelStore({ directory: modelDirectory, model: candidate })
  const modelStore = createModelStoreContract({
    id: candidate.id,
    store: rawModelStore,
  })
  const manager = createLocalAiManager({
    modelStore,
    modelMetadata: {
      id: candidate.id,
      displayName: candidate.displayName,
      repository: candidate.repository,
      license: candidate.license,
    },
    capabilityProbe: () => probeWindowsLocalAiCapability({
      storageDirectory: modelDirectory,
      ...(typeof runtimeDirectory === 'string' ? { runtimeDirectory } : {}),
      ...(benchmarkModelId === null ? {} : { profiles: [{
        ...WINDOWS_EXPERIMENTAL_PROFILES[0],
        id: candidate.id, modelBytes: candidate.bytes,
        minMemoryBytes: candidate.bytes > 4 * 1024 ** 3 ? 12 * 1024 ** 3 : 8 * 1024 ** 3,
      }] }),
    }),
  })
  return Object.freeze({ manager, modelStore, rawModelStore,
    modelId: candidate.id, modelSha256: candidate.sha256 })
}

function createWindowsLocalAiManager(options) {
  return createWindowsLocalAiResources(options).manager
}

module.exports = { createWindowsLocalAiManager, createWindowsLocalAiResources }
