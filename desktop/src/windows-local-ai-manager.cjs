'use strict'

const path = require('node:path')
const { createLocalAiManager, createModelStoreContract } = require('./local-ai.cjs')
const { CANDIDATE, createLocalModelStore } = require('./local-model-store.cjs')
const { probeWindowsLocalAiCapability } = require('./windows-hardware-probe.cjs')

function createWindowsLocalAiResources({
  userDataDirectory,
  modelDirectory = path.join(userDataDirectory, 'local-ai', 'models'),
} = {}) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory) ||
      typeof modelDirectory !== 'string' || !path.isAbsolute(modelDirectory)) {
    throw new Error('Local AI manager configuration is invalid.')
  }
  const rawModelStore = createLocalModelStore({ directory: modelDirectory })
  const modelStore = createModelStoreContract({
    id: CANDIDATE.id,
    store: rawModelStore,
  })
  const manager = createLocalAiManager({
    modelStore,
    modelMetadata: {
      id: CANDIDATE.id,
      displayName: CANDIDATE.displayName,
      repository: CANDIDATE.repository,
      license: CANDIDATE.license,
    },
    capabilityProbe: () => probeWindowsLocalAiCapability({
      storageDirectory: modelDirectory,
    }),
  })
  return Object.freeze({ manager, modelStore, rawModelStore, modelId: CANDIDATE.id })
}

function createWindowsLocalAiManager(options) {
  return createWindowsLocalAiResources(options).manager
}

module.exports = { createWindowsLocalAiManager, createWindowsLocalAiResources }
