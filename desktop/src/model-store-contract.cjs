'use strict'

const { LocalAiError, failure, runOperation, validId } = require('./local-ai-provider.cjs')
const STORE_CODES = new Set(['insufficient_disk', 'invalid_model', 'invalid_download', 'unapproved_download', 'unsafe_model'])

function statusResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ready !== 'boolean') {
    throw failure('invalid_model_status')
  }
  if (!value.ready) return Object.freeze({ ready: false })
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw failure('invalid_model_status')
  return Object.freeze({ ready: true, bytes: value.bytes })
}

function createModelStoreContract({ id, store }) {
  if (!validId(id) || !store || ['status', 'download', 'remove'].some(name => typeof store[name] !== 'function')) {
    throw failure('invalid_model_store')
  }
  const run = (operation, signal, checkAfter = true) => runOperation(async () => {
    try { return await operation() } catch (error) {
      if (!(error instanceof LocalAiError) && STORE_CODES.has(error?.code)) throw failure(error.code)
      throw error
    }
  }, { signal, fallback: 'model_store_failed', checkAfter })

  return Object.freeze({
    id,
    status({ signal } = {}) {
      return run(async () => statusResult(await store.status({ signal })), signal)
    },
    download({ signal, progress = () => {} } = {}) {
      return run(async () => {
        if (typeof progress !== 'function') throw failure('invalid_model_progress')
        let active = true
        try {
          const result = await store.download({ signal, progress(value) {
            if (!active || signal?.aborted) return
            if (!value || !Number.isSafeInteger(value.receivedBytes) || !Number.isSafeInteger(value.totalBytes) ||
                value.receivedBytes < 0 || value.totalBytes < 1 || value.receivedBytes > value.totalBytes) {
              throw failure('invalid_model_progress')
            }
            progress(Object.freeze({ receivedBytes: value.receivedBytes, totalBytes: value.totalBytes }))
          } })
          const status = statusResult(result)
          if (!status.ready) throw failure('invalid_model_status')
          return status
        } finally { active = false }
      }, signal)
    },
    remove({ signal } = {}) {
      // Once dispatched, removal is not cancellable. Do not imply it was rolled back.
      return run(async () => { await store.remove(); return Object.freeze({ removed: true }) }, signal, false)
    },
  })
}

module.exports = { createModelStoreContract }
