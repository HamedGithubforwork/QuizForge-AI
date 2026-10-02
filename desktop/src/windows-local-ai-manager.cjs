'use strict'

const path = require('node:path')
const { createLocalAiManager, createModelStoreContract } = require('./local-ai.cjs')
const { CANDIDATE, createLocalModelStore } = require('./local-model-store.cjs')
const { probeWindowsLocalAiCapability } = require('./windows-hardware-probe.cjs')

function createWindowsLocalAiStorage({
  userDataDirectory,
  rawModelStore = null,
  capabilityProbe = null,
}) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) {
    throw new Error('Local AI manager configuration is invalid.')
  }
  const raw = rawModelStore ?? createLocalModelStore({
    directory: path.join(userDataDirectory, 'local-ai', 'models'),
  })
  const modelStore = createModelStoreContract({
    id: CANDIDATE.id,
    store: raw,
  })
  const manager = createLocalAiManager({
    modelStore,
    capabilityProbe: capabilityProbe ?? (() => probeWindowsLocalAiCapability({
      storageDirectory: userDataDirectory,
    })),
  })
  return Object.freeze({
    rawModelStore: raw,
    modelStore,
    manager,
  })
}

function createWindowsLocalAiManager(options) {
  return createWindowsLocalAiStorage(options).manager
}

module.exports = {
  createWindowsLocalAiManager,
  createWindowsLocalAiStorage,
}
