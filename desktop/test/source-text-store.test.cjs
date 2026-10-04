'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  CACHE_TTL_MS,
  MAX_ENTRIES,
  createSourceTextStore,
} = require('../src/source-text-store.cjs')

function encryption() {
  return {
    available: async () => true,
    encrypt: async value => Buffer.from(
      Buffer.from(value, 'utf8').toString('base64'),
      'utf8',
    ),
    decrypt: async value => Buffer.from(
      value.toString('utf8'),
      'base64',
    ).toString('utf8'),
  }
}

async function fixture(t, now = new Date('2026-10-04T12:00:00Z')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-source-cache-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let current = now
  const create = () => createSourceTextStore({
    directory,
    encryption: encryption(),
    now: () => current,
  })
  return {
    directory,
    create,
    advance(ms) { current = new Date(current.getTime() + ms) },
  }
}

test('encrypted source text persists across store instances and stays owner-bound', async t => {
  const f = await fixture(t)
  const sha = 'a'.repeat(64)
  assert.equal(await f.create().put('owner-a', sha, 2, 'private page'), true)
  assert.equal(await f.create().get('owner-a', sha, 2), 'private page')
  assert.equal(await f.create().get('owner-b', sha, 2), null)

  const files = await fs.readdir(f.directory)
  assert.equal(files.length, 1)
  const raw = await fs.readFile(path.join(f.directory, files[0]), 'utf8')
  assert.equal(raw.includes('private page'), false)
  assert.notEqual(raw, 'private page')
})

test('expired source text is treated as a miss', async t => {
  const f = await fixture(t)
  const sha = 'b'.repeat(64)
  const store = f.create()
  await store.put('owner', sha, 1, 'old page')
  f.advance(CACHE_TTL_MS + 1)
  assert.equal(await store.get('owner', sha, 1), null)
  assert.deepEqual(await fs.readdir(f.directory), [])
})

test('cache keeps only the newest bounded entries', async t => {
  const f = await fixture(t)
  const store = f.create()
  const sha = 'c'.repeat(64)

  for (let page = 1; page <= MAX_ENTRIES + 2; page++) {
    await store.put('owner', sha, page, 'page ' + page)
    f.advance(1000)
  }

  assert.equal(await store.get('owner', sha, 1), null)
  assert.equal(await store.get('owner', sha, 2), null)
  assert.equal(await store.get('owner', sha, MAX_ENTRIES + 2), 'page ' + (MAX_ENTRIES + 2))
})

test('corrupt cache is disposable and self-heals on the next write', async t => {
  const f = await fixture(t)
  const sha = 'd'.repeat(64)
  const store = f.create()
  await store.put('owner', sha, 1, 'first')
  const [file] = await fs.readdir(f.directory)
  await fs.writeFile(path.join(f.directory, file), 'not encrypted')

  assert.equal(await store.get('owner', sha, 1), null)
  assert.deepEqual(await fs.readdir(f.directory), [])
  assert.equal(await store.put('owner', sha, 1, 'replacement'), true)
  assert.equal(await store.get('owner', sha, 1), 'replacement')
})
