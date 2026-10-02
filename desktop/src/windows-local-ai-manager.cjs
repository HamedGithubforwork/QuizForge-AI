'use strict'

const path = require('node:path')
const { createLocalAiManager, createModelStoreContract } = require('./local-ai.cjs')
const { CANDIDATE, createLocalModelStore } = require('./local-model-store.cjs')
const { probeWindowsLocalAiCapability } = require('./windows-hardware-probe.cjs')

function createWindowsLocalAiManager({ userDataDirectory }) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) {
    throw new Error('Local AI manager configuration is invalid.')
  }
  const modelStore = createModelStoreContract({
    id: CANDIDATE.id,
    store: createLocalModelStore({
      directory: path.join(userDataDirectory, 'local-ai', 'models'),
    }),
  })
  return createLocalAiManager({
    modelStore,
    capabilityProbe: () => probeWindowsLocalAiCapability({
      storageDirectory: userDataDirectory,
    }),
  })
}

module.exports = { createWindowsLocalAiManager }
