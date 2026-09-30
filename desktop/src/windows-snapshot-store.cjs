'use strict'

const path = require('node:path')
const { createSnapshotStore } = require('./snapshot-store.cjs')

function createWindowsSnapshotStore({ app, safeStorage, platform = process.platform }) {
  if (platform !== 'win32' || !app.isReady()) throw new Error('Secure snapshots require a ready Windows app.')
  return createSnapshotStore({
    directory: path.join(app.getPath('userData'), 'study-snapshots-v1'),
    encryption: {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    },
  })
}

module.exports = { createWindowsSnapshotStore }
