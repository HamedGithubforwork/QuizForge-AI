'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { approvedHost, createLocalModelStore, reviewedUrl } = require('../src/local-model-store.cjs')
const bytes = Buffer.from('GGUF synthetic model fixture')
const digest = createHash('sha256').update(bytes).digest('hex')
const spec = { bytes: bytes.length, sha256: digest, url: 'https://huggingface.co/test/model' }
async function setup(t, fetcher, model = spec) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-model-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, store: createLocalModelStore({ directory, fetch: fetcher, model }), file: path.join(directory, digest + '.gguf') }
}

test('publishes only verified complete bytes, rechecks cache and removes only model', async t => {
  let calls = 0
  const { directory, store, file } = await setup(t, async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit')
    assert.equal(options.headers, undefined)
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  })
  const progress = []
  assert.deepEqual(await store.status(), { ready: false })
  assert.equal((await store.download({ progress: value => progress.push(value) })).ready, true)
  assert.deepEqual(await fs.readFile(file), bytes)
  assert.equal((await store.download()).ready, true); assert.equal(calls, 1)
  assert.equal(progress.at(-1).receivedBytes, bytes.length)
  assert.deepEqual(await fs.readdir(directory), [digest + '.gguf'])
  await fs.writeFile(path.join(directory, 'study-data'), 'keep')
  await store.remove(); assert.deepEqual(await store.status(), { ready: false })
  assert.equal(await fs.readFile(path.join(directory, 'study-data'), 'utf8'), 'keep')
})

test('wrong digest, truncated and oversized streams never become models', async t => {
  for (const bad of [Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    const { directory, store } = await setup(t, async () => new Response(bad))
    await assert.rejects(store.download(), /invalid_download/)
    assert.deepEqual(await fs.readdir(directory), [])
  }
})

test('untrusted redirects are rejected without contacting their destinations', async t => {
  for (const destination of ['http://huggingface.co/a', 'https://127.0.0.1/a', 'https://huggingface.co.evil.example/a', 'https://user:pass@huggingface.co/a']) {
    let calls = 0
    const { directory, store } = await setup(t, async () => {
      calls++; return new Response(null, { status: 302, headers: { location: destination } })
    })
    await assert.rejects(store.download(), /unapproved_download/)
    assert.equal(calls, 1); assert.deepEqual(await fs.readdir(directory), [])
  }
})

test('reviewed CDN redirect is allowed and redirect loops are bounded', async t => {
  let calls = 0
  const { store } = await setup(t, async url => {
    calls++
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/model' } })
    assert.equal(url, 'https://us.aws.cdn.hf.co/model'); return new Response(bytes)
  })
  await store.download(); assert.equal(calls, 2)
  let loopCalls = 0
  const { store: loop } = await setup(t, async () => {
    loopCalls++; return new Response(null, { status: 302, headers: { location: '/again' } })
  })
  await assert.rejects(loop.download(), /unapproved_download/); assert.equal(loopCalls, 6)
})

test('cancellation removes partial data and a later attempt can recover', async t => {
  const controller = new AbortController()
  const { directory, store } = await setup(t, async () => new Response(bytes))
  await assert.rejects(store.download({ signal: controller.signal, progress: () => controller.abort() }))
  assert.deepEqual(await fs.readdir(directory), [])
  assert.equal((await store.download()).ready, true)
})

test('serial requests share verified cache and corrupted cache is preserved for explicit removal', async t => {
  let calls = 0
  const { store, file } = await setup(t, async () => { calls++; return new Response(bytes) })
  await Promise.all([store.download(), store.download()]); assert.equal(calls, 1)
  await fs.writeFile(file, Buffer.alloc(bytes.length))
  await assert.rejects(store.status(), /invalid_model/)
  await assert.rejects(store.download(), /invalid_model/)
  assert.equal(calls, 1); await store.remove()
  assert.equal((await store.download()).ready, true)
})

test('symlink models cannot be used or removed', { skip: process.platform === 'win32' }, async t => {
  const { directory, store, file } = await setup(t, async () => new Response(bytes))
  const target = path.join(directory, 'original'); await fs.writeFile(target, bytes); await fs.symlink(target, file)
  await assert.rejects(store.status(), /invalid_model/)
  await assert.rejects(store.remove(), /unsafe_model/)
  assert.deepEqual(await fs.readFile(target), bytes)
})

test('invalid registry entries fail before work', () => {
  assert.throws(() => reviewedUrl('https://huggingface.co/a#fragment'), /unapproved_download/)
  assert.throws(() => createLocalModelStore({ directory: 'relative' }), /invalid_configuration/)
})


test('reviewed Hugging Face storage hosts allow current CDN/Xet families but reject lookalikes', () => {
  for (const host of [
    'huggingface.co',
    'cdn-lfs-us-1.hf.co',
    'cas-server.xethub.hf.co',
    'transfer.xethub-eu.hf.co',
    'us.aws.cdn.hf.co',
  ]) assert.equal(approvedHost(host), true)
  for (const host of [
    'hf.co.evil.example',
    'huggingface.co.evil.example',
    'evil-hf.co',
    'example.com',
  ]) assert.equal(approvedHost(host), false)
})
