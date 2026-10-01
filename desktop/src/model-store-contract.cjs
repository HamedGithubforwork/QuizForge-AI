'use strict'

const { LocalAiError, failure } = require('./local-ai-provider.cjs')

const STORE_CODES = new Set([
  'insufficient_disk',
  'invalid_model',
  'invalid_download',
  'unapproved_download',
  'unsafe_model',
])

function normalizeStoreError(error, signal) {
  if (error instanceof LocalAiError) return error
  if (signal?.aborted || error?.name === 'AbortError') return failure('cancelled', { cause: error })
  if (STORE_CODES.has(error?.code)) return failure(error.code, { cause: error })
  return failure('model_store_failed', { retryable: true, cause: error })
}

function assertStore(store) {
  if (!store || typeof store.status !== 'function' ||
      typeof store.download !== 'function' || typeof store.remove !== 'function') {
    throw failure('invalid_model_store')
  }
}

function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || typeof value.ready !== 'boolean') {
    throw failure('invalid_model_status')
  }
  if (!value.ready) return Object.freeze({ ready: false })
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) {
    throw failure('invalid_model_status')
  }
  return Object.freeze({ ready: true, bytes: value.bytes })
}

function createModelStoreContract({ id, store }) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(id)) {
    throw failure('invalid_model_store')
  }
  assertStore(store)

  return Object.freeze({
    id,

    async status({ signal } = {}) {
      signal?.throwIfAborted()
      try {
        return normalizeStatus(await store.status({ signal }))
      } catch (error) {
        throw normalizeStoreError(error, signal)
      }
    },

    async download({ signal, progress = () => {} } = {}) {
      signal?.throwIfAborted()
      try {
        const result = await store.download({
          signal,
          progress(value) {
            if (!value || !Number.isSafeInteger(value.receivedBytes) ||
                !Number.isSafeInteger(value.totalBytes) || value.receivedBytes < 0 ||
                value.totalBytes < 1 || value.receivedBytes > value.totalBytes) {
              throw failure('invalid_model_progress')
            }
            progress(Object.freeze({
              receivedBytes: value.receivedBytes,
              totalBytes: value.totalBytes,
            }))
          },
        })
        return normalizeStatus(result)
      } catch (error) {
        throw normalizeStoreError(error, signal)
      }
    },

    async remove({ signal } = {}) {
      signal?.throwIfAborted()
      try {
        await store.remove({ signal })
        return Object.freeze({ removed: true })
      } catch (error) {
        throw normalizeStoreError(error, signal)
      }
    },
  })
}

module.exports = { createModelStoreContract }
