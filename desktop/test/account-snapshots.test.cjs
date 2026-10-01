'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAccountSnapshots } = require('../src/account-snapshots.cjs')
const { createSnapshotMenu } = require('../src/snapshot-menu.cjs')
const { snapshotDeck } = require('./snapshot-fixture.cjs')

function fixture() {
  let generation = 1, identity = { userId: 'verified-owner', enrolled: true }
  const calls = [], saved = [], removed = []
  const account = {
    generation: () => generation, current: () => identity,
    verify: async () => { calls.push('verify'); return identity },
    request: async ({ path }) => {
      calls.push(path)
      return { status: 200, body: JSON.stringify(path === '/api/decks' ? [{ id: snapshotDeck().id }] : snapshotDeck()) }
    },
  }
  const store = {
    save: async (owner, decks, guard) => { guard(); saved.push({ owner, decks }) },
    remove: async (owner, guard) => { guard(); removed.push(owner) },
  }
  return { account, store, calls, saved, removed, snapshots: createAccountSnapshots({ account, store }),
    change: () => { generation++; identity = { userId: 'other-owner', enrolled: true } },
    signOut: () => { generation++; identity = null } }
}

test('copies only complete server decks for a twice-verified owner; no renderer input or server writes', async () => {
  const f = fixture()
  assert.deepEqual(await f.snapshots.save(), { deckCount: 1, cardCount: 1 })
  assert.deepEqual(f.calls, ['verify', '/api/decks', '/api/decks/' + snapshotDeck().id, 'verify'])
  assert.deepEqual(f.saved, [{ owner: 'verified-owner', decks: [snapshotDeck()] }])
  await f.snapshots.remove()
  assert.deepEqual(f.removed, ['verified-owner'])
})

test('failed, malformed, duplicate and misbound responses never replace an existing copy', async () => {
  for (const response of [
    { status: 403, body: 'private server error' }, { status: 200, body: 'invalid' },
    { status: 200, body: JSON.stringify([{ id: '../identity' }]) },
    { status: 200, body: JSON.stringify([{ id: snapshotDeck().id }, { id: snapshotDeck().id }]) },
  ]) {
    const f = fixture(); f.account.request = async () => response
    await assert.rejects(f.snapshots.save()); assert.equal(f.saved.length, 0)
    assert.equal(f.snapshots.status().busy, false)
  }
  const f = fixture(), original = f.account.request
  f.account.request = async request => request.path === '/api/decks' ? original(request) :
    { status: 200, body: JSON.stringify({ ...snapshotDeck(), id: '33333333-3333-4333-8333-333333333333' }) }
  await assert.rejects(f.snapshots.save(), /Invalid deck response/)
  assert.equal(f.saved.length, 0)
})

test('rejects signed-out and unenrolled accounts and access revoked on final verification', async () => {
  for (const current of [null, { userId: 'owner', enrolled: false }]) {
    const f = fixture(); f.account.current = () => current
    await assert.rejects(f.snapshots.save()); await assert.rejects(f.snapshots.remove())
    assert.equal(f.calls.length, 0)
  }
  const f = fixture(); let verifies = 0
  f.account.verify = async () => { if (++verifies === 2) f.signOut() }
  await assert.rejects(f.snapshots.save(), /account changed/)
  assert.equal(f.saved.length, 0)
})

test('sign-out or account replacement during collection discards late data and releases busy state', async () => {
  for (const action of ['change', 'signOut']) {
    const f = fixture(), original = f.account.request
    f.account.request = async value => { const result = await original(value); f[action](); return result }
    await assert.rejects(f.snapshots.save(), /account changed/)
    assert.equal(f.saved.length, 0); assert.equal(f.snapshots.status().busy, false)
  }
})

test('single-flight save blocks overlapping save/remove and passes a live commit guard', async () => {
  const f = fixture(); let release
  f.account.verify = () => new Promise(resolve => { release = resolve })
  const saving = f.snapshots.save()
  await assert.rejects(f.snapshots.save(), /already running/)
  await assert.rejects(f.snapshots.remove(), /already running/)
  f.change(); release()
  await assert.rejects(saving, /account changed/)
  const next = fixture()
  next.store.save = async (_owner, _decks, guard) => { next.change(); guard() }
  await assert.rejects(next.snapshots.save(), /account changed/)
})

test('empty accounts can replace a snapshot with an explicitly requested empty copy', async () => {
  const f = fixture(); f.account.request = async () => ({ status: 200, body: '[]' })
  assert.deepEqual(await f.snapshots.save(), { deckCount: 0, cardCount: 0 })
  assert.deepEqual(f.saved[0].decks, [])
})

test('native menu requires confirmation, cancels on account change and reports only counts', async () => {
  for (const mode of ['cancel', 'switch', 'save', 'remove']) {
    const f = fixture(), messages = [], window = { isDestroyed: () => false }
    const menu = createSnapshotMenu({ account: f.account, snapshots: f.snapshots, getWindow: () => window,
      dialog: { showMessageBox: async (_window, message) => {
        messages.push(message)
        if (mode === 'switch') f.change()
        return { response: mode === 'cancel' ? 1 : 0 }
      } } })
    await menu(mode === 'remove' ? 'remove' : 'save')
    assert.equal(messages[0].defaultId, 1)
    assert.equal(f.saved.length, mode === 'save' ? 1 : 0)
    assert.equal(f.removed.length, mode === 'remove' ? 1 : 0)
    assert.equal(JSON.stringify(messages).includes('Private'), false)
    assert.equal(JSON.stringify(messages).includes('verified-owner'), false)
  }
})

test('native menu suppresses duplicate prompts and sanitizes storage errors', async () => {
  const f = fixture(), messages = [], window = { isDestroyed: () => false }; let release
  const menu = createSnapshotMenu({ account: f.account,
    snapshots: { save: async () => { throw Error('private token / private path') } }, getWindow: () => window,
    dialog: { showMessageBox: async (_window, message) => {
      messages.push(message)
      if (messages.length === 1) return new Promise(resolve => { release = resolve })
      return { response: 0 }
    } } })
  const pending = menu('save'); await menu('save'); assert.equal(messages.length, 1)
  release({ response: 0 }); await pending
  assert.equal(messages.length, 2)
  assert.equal(JSON.stringify(messages).includes('private token'), false)
})
