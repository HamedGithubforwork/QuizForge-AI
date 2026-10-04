'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createAccountSourceTextCache,
  normalizeRequest,
} = require('../src/account-source-text-cache.cjs')

const SHA = 'e'.repeat(64)

function fixture() {
  let generation = 1
  let account = { userId: 'owner', enrolled: true }
  let requests = 0
  const values = new Map()
  const store = {
    async get(owner, sha, page) {
      return values.get(owner + ':' + sha + ':' + page) ?? null
    },
    async put(owner, sha, page, text) {
      values.set(owner + ':' + sha + ':' + page, text)
      return true
    },
  }
  const nativeAccount = {
    current: () => account,
    generation: () => generation,
    async request(value) {
      requests++
      assert.deepEqual(value, {
        path: '/api/documents/' + SHA + '/pages/3',
        method: 'GET',
      })
      return {
        status: 200,
        body: JSON.stringify({
          pdf_sha256: SHA,
          page_number: 3,
          text: 'server source text',
        }),
      }
    },
  }
  return {
    cache: createAccountSourceTextCache({ account: nativeAccount, store }),
    store,
    values,
    get requests() { return requests },
    changeAccount() { generation++; account = { userId: 'other', enrolled: true } },
    signOut() { generation++; account = null },
    nativeAccount,
  }
}

test('read-through cache fetches once and then reuses encrypted-store value', async () => {
  const f = fixture()
  const request = { documentSha256: SHA, pageNumber: 3 }
  assert.equal(await f.cache.load(request), 'server source text')
  assert.equal(await f.cache.load(request), 'server source text')
  assert.equal(f.requests, 1)
})

test('request contract rejects arbitrary paths and malformed keys', () => {
  assert.deepEqual(normalizeRequest({
    documentSha256: SHA.toUpperCase(),
    pageNumber: 3,
  }), {
    documentSha256: SHA,
    pageNumber: 3,
  })
  for (const value of [
    { documentSha256: SHA, pageNumber: 0 },
    { documentSha256: 'not-a-sha', pageNumber: 3 },
    { documentSha256: SHA, pageNumber: 3, path: '/api/decks' },
  ]) assert.throws(() => normalizeRequest(value), /invalid/)
})

test('mismatched server identity is rejected and never cached', async () => {
  const f = fixture()
  f.nativeAccount.request = async () => ({
    status: 200,
    body: JSON.stringify({
      pdf_sha256: 'f'.repeat(64),
      page_number: 3,
      text: 'wrong document',
    }),
  })
  await assert.rejects(
    f.cache.load({ documentSha256: SHA, pageNumber: 3 }),
    /unavailable/,
  )
  assert.equal(f.values.size, 0)
})

test('account changes during fetch invalidate the result before caching', async () => {
  const f = fixture()
  f.nativeAccount.request = async () => {
    f.changeAccount()
    return {
      status: 200,
      body: JSON.stringify({
        pdf_sha256: SHA,
        page_number: 3,
        text: 'private',
      }),
    }
  }
  await assert.rejects(
    f.cache.load({ documentSha256: SHA, pageNumber: 3 }),
    /session changed/,
  )
  assert.equal(f.values.size, 0)
})

test('signed-out accounts cannot access retained cache entries', async () => {
  const f = fixture()
  await f.store.put('owner', SHA, 3, 'cached private')
  f.signOut()
  await assert.rejects(
    f.cache.load({ documentSha256: SHA, pageNumber: 3 }),
    /Sign in/,
  )
})


test('cache read and write failures do not block canonical server source text', async () => {
  let requests = 0
  const account = {
    current: () => ({ userId: 'owner', enrolled: true }),
    generation: () => 1,
    request: async () => {
      requests++
      return {
        status: 200,
        body: JSON.stringify({
          pdf_sha256: SHA,
          page_number: 3,
          text: 'canonical source',
        }),
      }
    },
  }
  const cache = createAccountSourceTextCache({
    account,
    store: {
      get: async () => { throw new Error('disk unavailable') },
      put: async () => { throw new Error('disk unavailable') },
    },
  })

  assert.equal(
    await cache.load({ documentSha256: SHA, pageNumber: 3 }),
    'canonical source',
  )
  assert.equal(requests, 1)
})
