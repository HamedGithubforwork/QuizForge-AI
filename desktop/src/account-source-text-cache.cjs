'use strict'

const SHA256 = /^[a-f0-9]{64}$/
const MAX_RETURN_TEXT_BYTES = 2 * 1024 * 1024

const fail = message => new Error(message)

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'documentSha256,pageNumber') {
    throw fail('Source page request is invalid.')
  }
  const documentSha256 = typeof value.documentSha256 === 'string'
    ? value.documentSha256.trim().toLowerCase() : ''
  if (!SHA256.test(documentSha256) || !Number.isSafeInteger(value.pageNumber) ||
      value.pageNumber < 1 || value.pageNumber > 10000) {
    throw fail('Source page request is invalid.')
  }
  return { documentSha256, pageNumber: value.pageNumber }
}

function createAccountSourceTextCache({ account, store }) {
  if (!account || typeof account.current !== 'function' || typeof account.generation !== 'function' ||
      typeof account.request !== 'function' || !store || typeof store.get !== 'function' ||
      typeof store.put !== 'function') throw fail('Source page cache is unavailable.')

  const assertCurrent = (generation, ownerId) => {
    const current = account.current()
    if (account.generation() !== generation || !current?.enrolled || current.userId !== ownerId) {
      throw fail('Your desktop session changed. Sign in again to continue.')
    }
  }

  return Object.freeze({
    async load(value) {
      const request = normalizeRequest(value)
      const identity = account.current()
      if (!identity?.enrolled || !identity.userId) throw fail('Sign in to load source text on this desktop.')
      const generation = account.generation()
      const ownerId = identity.userId

      let cached = null
      try {
        cached = await store.get(ownerId, request.documentSha256, request.pageNumber)
      } catch {
        // Cache availability must never block canonical authenticated source retrieval.
      }
      assertCurrent(generation, ownerId)
      if (cached !== null) return cached

      const response = await account.request({
        path: '/api/documents/' + request.documentSha256 + '/pages/' + request.pageNumber,
        method: 'GET',
      })
      assertCurrent(generation, ownerId)

      let body
      try { body = JSON.parse(response.body) } catch { throw fail('Source text is unavailable.') }
      if (response.status !== 200) {
        throw fail(typeof body?.detail === 'string' && body.detail.length <= 500
          ? body.detail : 'Source text is unavailable.')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'page_number,pdf_sha256,text' ||
          body.pdf_sha256 !== request.documentSha256 ||
          body.page_number !== request.pageNumber ||
          typeof body.text !== 'string' ||
          Buffer.byteLength(body.text) > MAX_RETURN_TEXT_BYTES) {
        throw fail('Source text is unavailable.')
      }

      try {
        await store.put(ownerId, request.documentSha256, request.pageNumber, body.text)
      } catch {
        // A cache write failure does not invalidate canonical source text.
      }
      assertCurrent(generation, ownerId)
      return body.text
    },
  })
}

module.exports = { createAccountSourceTextCache, normalizeRequest }
