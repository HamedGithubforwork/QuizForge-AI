'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNativeSession } = require('../src/native-session.cjs')
const { AUTH_ORIGIN } = require('../src/policy.cjs')
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const account = (name = 'one') => ({ accessToken: 'access-' + name, refreshToken: 'refresh-' + name,
  subject: name, userId: 'user-' + name, email: name + '@example.invalid', expiresAt: Date.now() + 300_000 })
function fixture(overrides = {}) {
  const opened = [], revoked = [], timers = new Map()
  let timerId = 0, changes = 0
  const client = { exchange: async () => account(), refresh: async () => account(), revoke: async token => { revoked.push(token) }, ...overrides.client }
  const session = createNativeSession({ clientId: 'desktop123', client,
    openBrowser: async url => { opened.push(url); if (overrides.openError) throw new Error('private failure') },
    setTimer: callback => { timers.set(++timerId, callback); return timerId }, clearTimer: id => timers.delete(id),
    onChange: () => { changes++ },
  })
  function callback(index = opened.length - 1) {
    const url = new URL(opened[index])
    return `${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=synthetic-code`
  }
  async function begin() {
    const result = session.signIn().then(() => true, () => false)
    await Promise.resolve()
    return { result }
  }
  async function login() { const { result } = await begin(); assert.equal(await session.handleCallback(callback()), true); assert.equal(await result, true) }
  return { session, client, opened, revoked, timers, callback, begin, login, changes: () => changes }
}

test('opens only the generated authorization URL and ignores unrelated and duplicate callbacks', async () => {
  const f = fixture()
  const { result } = await f.begin()
  assert.equal(new URL(f.opened[0]).origin, AUTH_ORIGIN)
  assert.equal(f.session.status().signingIn, true)
  assert.equal(await f.session.handleCallback(f.callback().replace('state=', 'state=wrong')), false)
  assert.equal(f.session.status().signingIn, true)
  assert.equal(await f.session.handleCallback(f.callback()), true)
  assert.equal(await result, true)
  assert.deepEqual(await f.session.session(), { accessToken: 'access-one', userId: 'user-one', email: 'one@example.invalid' })
  assert.equal(await f.session.handleCallback(f.callback()), false)
  assert.equal(f.timers.size, 0)
  assert.ok(f.changes() >= 2)
})

test('replacing a pending attempt cancels it and never accepts its old callback', async () => {
  const f = fixture()
  const first = await f.begin()
  const oldCallback = f.callback()
  const second = await f.begin()
  assert.equal(await first.result, false)
  assert.equal(await f.session.handleCallback(oldCallback), false)
  assert.equal(await f.session.handleCallback(f.callback()), true)
  assert.equal(await second.result, true)
})

test('logout discards and revokes an exchange that finishes late', async () => {
  const exchange = deferred()
  const f = fixture({ client: { exchange: () => exchange.promise } })
  const { result } = await f.begin()
  const callbackResult = f.session.handleCallback(f.callback())
  assert.equal(await f.session.handleCallback(f.callback()), false)
  await f.session.signOut()
  assert.equal(await result, false)
  exchange.resolve(account())
  assert.equal(await callbackResult, false)
  assert.equal(await f.session.session(), null)
  assert.deepEqual(f.revoked, ['refresh-one'])
})

test('concurrent refresh is single-flight and a late result cannot undo logout', async () => {
  const refresh = deferred()
  let calls = 0
  const f = fixture({ client: { refresh: () => { calls++; return refresh.promise } } })
  await f.login()
  const pending = [f.session.session(true), f.session.session(true), f.session.session(true)]
  assert.equal(calls, 1)
  await f.session.signOut()
  refresh.resolve(account('rotated'))
  assert.deepEqual(await Promise.all(pending), [null, null, null])
  assert.equal(await f.session.session(), null)
  assert.deepEqual(f.revoked, ['refresh-one', 'refresh-rotated'])
})

test('a stale refresh failure does not clear a newer signed-in account', async () => {
  const refresh = deferred()
  const f = fixture({ client: { refresh: () => refresh.promise } })
  await f.login()
  const old = f.session.session(true)
  f.client.exchange = async () => account('two')
  await f.login()
  refresh.reject(new Error('private token error'))
  assert.equal(await old, null)
  assert.equal((await f.session.session()).userId, 'user-two')
})

test('refresh failures clear local identity and attempt revocation', async () => {
  const f = fixture({ client: { refresh: async () => { throw new Error('private') } } })
  await f.login()
  assert.equal(await f.session.session(true), null)
  assert.equal(f.session.status().signedIn, false)
  assert.deepEqual(f.revoked, ['refresh-one'])
})

test('revocation failures never restore identity and are reported without private details', async () => {
  const f = fixture({ client: { revoke: async () => { throw new Error('private') } } })
  await f.login()
  await assert.rejects(f.session.signOut(), { message: 'Local sign-out completed, but session revocation could not be confirmed.' })
  assert.equal(await f.session.session(), null)
  assert.equal(f.session.status().revocationUnconfirmed, true)
})

test('expiry, denied authorization and browser errors settle pending sign-in', async () => {
  for (const mode of ['expiry', 'denied', 'browser']) {
    const f = fixture({ openError: mode === 'browser' })
    const { result } = await f.begin()
    if (mode === 'expiry') [...f.timers.values()][0]()
    if (mode === 'denied') await f.session.handleCallback(f.callback().replace('code=synthetic-code', 'error=denied'))
    assert.equal(await result, false)
    assert.equal(f.session.status().signingIn, false)
    assert.equal(await f.session.session(), null)
    assert.equal(f.timers.size, 0)
  }
})

test('sign-out before browser launch prevents opening a stale request', async () => {
  const f = fixture()
  const result = f.session.signIn().then(() => true, () => false)
  await f.session.signOut()
  assert.equal(await result, false)
  assert.deepEqual(f.opened, [])
})

test('successful refresh is shared, updates the access token and keeps refresh tokens private', async () => {
  const refresh = deferred()
  let calls = 0
  const f = fixture({ client: {
    exchange: async () => ({ ...account(), expiresAt: Date.now() + 1000 }),
    refresh: () => { calls++; return refresh.promise },
  } })
  await f.login()
  const first = f.session.session()
  const second = f.session.session(true)
  assert.equal(calls, 1)
  refresh.resolve({ ...account(), accessToken: 'new-access', refreshToken: 'new-refresh' })
  assert.deepEqual(await first, await second)
  const view = await f.session.session()
  assert.equal(view.accessToken, 'new-access')
  assert.equal(view.refreshToken, undefined)
  assert.equal(calls, 1)
  await f.session.signOut()
  assert.deepEqual(f.revoked, ['new-refresh'])
})
