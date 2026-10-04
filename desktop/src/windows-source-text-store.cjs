'use strict'

const path = require('node:path')
const { createSourceTextStore } = require('./source-text-store.cjs')

function createWindowsSourceTextStore({ app, safeStorage, platform = process.platform }) {
  if (platform !== 'win32' || !app.isReady()) throw new Error('Secure source-text cache requires a ready Windows app.')
  return createSourceTextStore({
    directory: path.join(app.getPath('userData'), 'source-text-cache-v1'),
    encryption: {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    },
  })
}

module.exports = { createWindowsSourceTextStore }
