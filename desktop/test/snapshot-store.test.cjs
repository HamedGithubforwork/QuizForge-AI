'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const { createSnapshotStore, MAX_PLAINTEXT_BYTES } = require('../src/snapshot-store.cjs')
const { createWindowsSnapshotStore } = require('../src/windows-snapshot-store.cjs')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-vault-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  const encryption = {
    available: async () => true,
    encrypt: async text => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data])
    },
    decrypt: async bytes => {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
    },
  }
  return { directory, encryption, store: createSnapshotStore({ directory, encryption }) }
}
const { snapshotDeck } = require('./snapshot-fixture.cjs')
const decks = [snapshotDeck()]

test('encrypted snapshots survive store recreation, isolate accounts and delete only the selected account', async t => {
  const { directory, encryption, store } = await fixture(t)
  await store.save('account-one', decks)
  await store.save('account-two', [])
  const files = await fs.readdir(directory)
  assert.equal(files.length, 2)
  for (const file of files) {
    assert.match(file, /^[a-f0-9]{64}\.qfn$/)
    assert.equal((await fs.readFile(path.join(directory, file))).includes(Buffer.from('Private')), false)
  }
  const reopened = createSnapshotStore({ directory, encryption })
  assert.deepEqual((await reopened.load('account-one')).decks, decks)
  assert.equal(await reopened.load('unknown'), null)
  await reopened.remove('account-one')
  assert.equal(await reopened.load('account-one'), null)
  assert.deepEqual((await reopened.load('account-two')).decks, [])
})

test('no plaintext fallback and a failed encryption preserves the last good snapshot', async t => {
  const { directory, encryption, store } = await fixture(t)
  await store.save('owner', decks)
  const originalEncrypt = encryption.encrypt
  encryption.encrypt = async () => { throw new Error('sensitive diagnostic') }
  await assert.rejects(store.save('owner', []), /^Error: Could not encrypt study snapshot\.$/)
  encryption.encrypt = originalEncrypt
  assert.deepEqual((await store.load('owner')).decks, decks)
  encryption.available = async () => false
  await assert.rejects(store.save('owner', []), /unavailable/)
  assert.equal((await fs.readdir(directory)).length, 1)
})

test('rejects tampering and another account ciphertext without exposing decrypted data', async t => {
  const { directory, store } = await fixture(t)
  await store.save('one', decks)
  const first = (await fs.readdir(directory))[0]
  await store.save('two', [])
  const second = (await fs.readdir(directory)).find(file => file !== first)
  const bytes = await fs.readFile(path.join(directory, first))
  await fs.writeFile(path.join(directory, second), bytes)
  await assert.rejects(store.load('two'), /incompatible/)
  bytes[bytes.length - 1] ^= 1
  await fs.writeFile(path.join(directory, first), bytes)
  await assert.rejects(store.load('one'), /^Error: Could not unlock study snapshot\.$/)
})

test('bounds payload size, rejects malformed data and serializes concurrent replacement', async t => {
  const { store } = await fixture(t)
  assert.throws(() => store.save('', []), /account/)
  assert.throws(() => store.save('owner', {}), /incompatible/)
  assert.throws(() => store.save('owner', [{ id: '1', name: 'x'.repeat(MAX_PLAINTEXT_BYTES), cards: [] }]), /too large/)
  await Promise.all([store.save('owner', decks), store.save('owner', [])])
  assert.deepEqual((await store.load('owner')).decks, [])
})

test('Windows adapter rejects unsupported platforms and initialization before readiness', () => {
  assert.throws(() => createWindowsSnapshotStore({ app: {}, platform: 'linux' }), /Windows/)
  assert.throws(() => createWindowsSnapshotStore({ app: { isReady: () => false }, platform: 'win32' }), /ready/)
})

test('rejects oversized encrypted files before decryption and rejects linked files', async t => {
  const { directory, encryption, store } = await fixture(t)
  await store.save('owner', decks)
  const file = path.join(directory, (await fs.readdir(directory))[0])
  await fs.truncate(file, 13 * 1024 * 1024)
  let decrypted = false
  encryption.decrypt = async () => { decrypted = true; return '{}' }
  await assert.rejects(store.load('owner'), /oversized/)
  assert.equal(decrypted, false)
  if (process.platform !== 'win32') {
    await fs.unlink(file)
    const target = path.join(directory, 'target')
    await fs.writeFile(target, 'untouched')
    await fs.symlink(target, file)
    await assert.rejects(store.load('owner'), /Unsafe/)
    await assert.rejects(store.save('owner', []), /Unsafe/)
    await assert.rejects(store.remove('owner'), /Unsafe/)
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched')
  }
})

test('invalid save preserves ciphertext and invalid decrypted card data fails closed', async t => {
  const { directory, encryption, store } = await fixture(t)
  await store.save('owner', decks)
  const file = path.join(directory, (await fs.readdir(directory))[0])
  const original = await fs.readFile(file)
  const invalid = structuredClone(decks)
  invalid[0].cards[0].deck_id = '33333333-3333-4333-8333-333333333333'
  assert.throws(() => store.save('owner', invalid), /incompatible/)
  assert.deepEqual(await fs.readFile(file), original)
  const malformed = { schema: 1, ownerId: 'owner', savedAt: new Date().toISOString(), decks: invalid }
  await fs.writeFile(file, await encryption.encrypt(JSON.stringify(malformed)))
  await assert.rejects(store.load('owner'), /^Error: Invalid or incompatible study snapshot\.$/)
})
