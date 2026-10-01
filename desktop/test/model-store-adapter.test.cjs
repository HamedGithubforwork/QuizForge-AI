'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { createLocalModelStore } = require('../src/local-model-store.cjs')
const { createModelStoreContract } = require('../src/model-store-contract.cjs')

test('real disk adapter satisfies redacted model lifecycle, cancellation and concurrent retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-contract-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('GGUF synthetic contract fixture')
  const model = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    url: 'https://huggingface.co/test/model' }
  let calls = 0
  const raw = createLocalModelStore({ directory, model, fetch: async () => { calls++; return new Response(bytes) } })
  const store = createModelStoreContract({ id: 'synthetic', store: raw })
  const controller = new AbortController()
  await assert.rejects(store.download({ signal: controller.signal, progress: () => controller.abort('private') }), { code: 'cancelled' })
  assert.deepEqual(await store.status(), { ready: false })
  assert.deepEqual(await fs.readdir(directory), [])
  const results = await Promise.all([store.download(), store.download()])
  assert.deepEqual(results, [{ ready: true, bytes: bytes.length }, { ready: true, bytes: bytes.length }])
  assert.equal(calls, 2)
  assert.deepEqual(await store.status(), results[0])
  await fs.writeFile(path.join(directory, 'study-data'), 'preserve')
  await fs.writeFile(path.join(directory, model.sha256 + '.gguf'), Buffer.alloc(bytes.length))
  await assert.rejects(store.status(), { code: 'invalid_model' })
  await store.remove(); await store.remove()
  assert.deepEqual(await store.status(), { ready: false })
  assert.equal(await fs.readFile(path.join(directory, 'study-data'), 'utf8'), 'preserve')
})
