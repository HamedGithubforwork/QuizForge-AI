'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createLocalAiProvider, LocalAiError } = require('../src/local-ai-provider.cjs')
const { createWindowsLocalAiProvider } = require('../src/windows-local-ai-provider.cjs')
const { createModelStoreContract } = require('../src/model-store-contract.cjs')

const input = () => ({ messages: [{ role: 'user', content: 'Synthetic notes' }], maxTokens: 50 })
const schema = () => ({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] })
const result = () => ({ text: 'Synthetic result', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
const capability = () => ({ available: true, modelId: 'synthetic', reason: null, secret: 'must not escape' })
const generic = generate => createLocalAiProvider({ id: 'synthetic', capability, generate })
const windows = complete => createWindowsLocalAiProvider({ runtime: { complete }, modelStore: { status: async () => ({ ready: true }) },
  modelId: 'synthetic', platform: 'win32', arch: 'x64' })
const wire = value => ({ choices: [{ message: { content: value.text }, finish_reason: value.finishReason }],
  usage: value.usage && { prompt_tokens: value.usage.inputTokens, completion_tokens: value.usage.outputTokens, total_tokens: value.usage.totalTokens },
  secret: 'must not escape' })

// The same behavior contract is exercised against a neutral implementation and the Windows adapter.
for (const [label, factory] of [['neutral', generic], ['windows', generate => windows(async (...args) => wire(await generate(...args))) ]]) {
  test(label + ': result/capability normalization and immutable requests', async () => {
    const provider = factory(async request => {
      assert.equal(Object.isFrozen(request.messages), true)
      assert.equal(Object.isFrozen(request.messages[0]), true)
      if (request.jsonSchema) assert.equal(Object.isFrozen(request.jsonSchema), true)
      return { ...result(), path: 'private-path' }
    })
    assert.deepEqual(await provider.generate(input()), result())
    assert.deepEqual(await provider.capability(), { available: true, modelId: 'synthetic', reason: null, execution: 'local' })
  })
  test(label + ': rejects malformed and oversized input without calling adapter', async () => {
    let calls = 0
    const provider = factory(async () => { calls++; return result() })
    for (const value of [null, {}, [], { messages: [] }, { ...input(), tools: [] },
      { messages: [{ role: 'tool', content: 'bad' }] }, { messages: [{ role: 'user', content: ' ' }] },
      { messages: [{ role: 'user', content: 'é'.repeat(31000) }] }, { ...input(), maxTokens: NaN },
      { ...input(), maxTokens: 1801 }, { ...input(), maxTokens: 0 },
      { ...input(), jsonSchema: [] }, { ...input(), jsonSchema: { description: 'x'.repeat(17000) } },
      { ...input(), generationProfile: 'arbitrary' }]) {
      await assert.rejects(provider.generate(value), { code: 'invalid_request' })
    }
    assert.equal(calls, 0)
  })
  test(label + ': pre-abort and late abort never succeed or leak custom reason', async () => {
    let calls = 0
    const controller = new AbortController()
    const provider = factory(async () => { calls++; controller.abort(new Error('secret reason')); return result() })
    await assert.rejects(provider.generate(input(), { signal: controller.signal }), { code: 'cancelled' })
    await assert.rejects(provider.generate(input(), { signal: controller.signal }), { code: 'cancelled' })
    await assert.rejects(provider.capability({ signal: controller.signal }), { code: 'cancelled' })
    assert.equal(calls, 1)
  })
  test(label + ': errors are sanitized and valid retries recover', async () => {
    let calls = 0
    const provider = factory(async () => {
      if (calls++ === 0) throw Object.assign(new Error('secret credential /private/path'), { cause: { token: 'secret' } })
      return result()
    })
    await assert.rejects(provider.generate(input()), error => {
      assert.ok(error instanceof LocalAiError)
      assert.equal(error.cause, undefined)
      assert.equal(String(error).includes('secret'), false)
      assert.equal(JSON.stringify(error).includes('secret'), false)
      return true
    })
    assert.deepEqual(await provider.generate(input()), result())
  })
}

test('portable provider loads without process, Buffer, require or Electron', async () => {
  const context = { module: { exports: {} }, TextEncoder }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/local-ai-provider.cjs'), 'utf8'), context)
  const provider = context.module.exports.createLocalAiProvider({ id: 'portable', capability, generate: async () => result() })
  assert.equal((await provider.generate(input())).text, result().text)
})

test('invalid and truncated output is not silently treated as completed generation', async () => {
  for (const value of [null, { ...result(), text: '' }, { ...result(), text: 'é'.repeat(132000) },
    { ...result(), finishReason: 'tool_calls' }, { ...result(), usage: { inputTokens: -1 } },
    { ...result(), usage: { inputTokens: 2, outputTokens: 3, totalTokens: 8 } }]) {
    await assert.rejects(generic(async () => value).generate(input()), { code: 'invalid_response' })
  }
  const truncated = await generic(async () => ({ ...result(), finishReason: 'length' })).generate(input())
  assert.equal(truncated.finishReason, 'length')
})

test('capability failures, timeouts and cancellation have bounded public codes', async () => {
  const make = fn => createLocalAiProvider({ id: 'test', capability: fn, generate: async () => result() })
  await assert.rejects(make(async () => ({ available: false, modelId: 'test', reason: '/private/path' })).capability(), { code: 'invalid_capability' })
  await assert.rejects(make(async () => { throw new Error('secret') }).capability(), { code: 'capability_failed' })
  await assert.rejects(make(async () => { throw new DOMException('secret', 'TimeoutError') }).capability(), { code: 'timed_out' })
  assert.equal(new LocalAiError('secret/path').code, 'generation_failed')
})

test('structured output schemas and named generation profiles stay trusted and bounded', async () => {
  let neutralRequest
  const neutral = generic(async request => { neutralRequest = request; return result() })
  await neutral.generate({
    ...input(),
    jsonSchema: schema(),
    generationProfile: 'quiz-mcq-v1',
  })
  assert.deepEqual(neutralRequest.jsonSchema, schema())
  assert.equal(neutralRequest.generationProfile, 'quiz-mcq-v1')

  let runtimeRequest
  const provider = windows(async request => { runtimeRequest = request; return wire(result()) })
  await provider.generate({
    ...input(),
    jsonSchema: schema(),
    generationProfile: 'quiz-mcq-v1',
  })
  assert.deepEqual(runtimeRequest.json_schema, schema())
  assert.equal(runtimeRequest.max_tokens, 50)
  assert.deepEqual({
    temperature: runtimeRequest.temperature,
    top_p: runtimeRequest.top_p,
    top_k: runtimeRequest.top_k,
    min_p: runtimeRequest.min_p,
    presence_penalty: runtimeRequest.presence_penalty,
    seed: runtimeRequest.seed,
    chat_template_kwargs: runtimeRequest.chat_template_kwargs,
  }, {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.5,
    seed: 42,
    chat_template_kwargs: { enable_thinking: false },
  })
})

test('Windows adapter preserves token limits, rejects unsupported platforms and protocol surprises', async () => {
  let calls = 0
  const provider = windows(async request => { calls++; assert.deepEqual(Object.keys(request).sort(), ['max_tokens', 'messages']);
    assert.equal(request.max_tokens, 50); return wire(result()) })
  await provider.generate(input())
  assert.equal(calls, 1)
  const unavailable = createWindowsLocalAiProvider({ runtime: { complete: async () => { throw Error('must not call') } },
    modelStore: { status: async () => { throw Error('must not call') } }, modelId: 'test', platform: 'linux', arch: 'x64' })
  assert.equal((await unavailable.capability()).reason, 'unsupported_platform')
  await assert.rejects(unavailable.generate(input()), { code: 'unsupported_platform' })
  for (const response of [{ choices: [] }, { choices: [wire(result()).choices[0], wire(result()).choices[0]] },
    { choices: [{ message: { content: 'text', tool_calls: [] }, finish_reason: 'stop' }] }, { ...wire(result()), usage: 'bad' }]) {
    await assert.rejects(windows(async () => response).generate(input()), { code: 'invalid_response' })
  }
  await assert.rejects(windows(async () => { throw { code: 'busy' } }).generate(input()), { code: 'busy', retryable: true })
})

function memoryStore() {
  let ready = false
  return { async status() { return ready ? { ready, bytes: 30, path: 'private', token: 'private' } : { ready } },
    async download({ signal, progress }) { signal?.throwIfAborted(); progress({ receivedBytes: 30, totalBytes: 30, path: 'private' });
      signal?.throwIfAborted(); ready = true; return this.status() }, async remove() { ready = false } }
}

test('model lifecycle is normalized, repeated operations are safe and progress is redacted', async () => {
  const store = createModelStoreContract({ id: 'test', store: memoryStore() })
  assert.deepEqual(await store.status(), { ready: false })
  const progress = []
  assert.deepEqual(await store.download({ progress: item => progress.push(item) }), { ready: true, bytes: 30 })
  assert.deepEqual(progress, [{ receivedBytes: 30, totalBytes: 30 }])
  assert.deepEqual(await store.download(), { ready: true, bytes: 30 })
  assert.deepEqual(await store.remove(), { removed: true })
  assert.deepEqual(await store.remove(), { removed: true })
  assert.deepEqual(await store.status(), { ready: false })
})

test('model cancellation, partial failure and retry preserve lifecycle evidence', async () => {
  const raw = memoryStore()
  const store = createModelStoreContract({ id: 'test', store: raw })
  const controller = new AbortController()
  await assert.rejects(store.download({ signal: controller.signal, progress: () => controller.abort('private') }), { code: 'cancelled' })
  for (const op of ['status', 'download', 'remove']) await assert.rejects(store[op]({ signal: controller.signal }), { code: 'cancelled' })
  assert.deepEqual(await store.status(), { ready: false })
  assert.deepEqual(await store.download(), { ready: true, bytes: 30 })
  const late = new AbortController()
  const lateStore = createModelStoreContract({ id: 'late', store: { ...raw,
    async download() { late.abort(); return { ready: true, bytes: 30 } } } })
  await assert.rejects(lateStore.download({ signal: late.signal }), { code: 'cancelled' })
})

test('model facade rejects invalid statuses, progress and raw errors; suppresses late progress', async () => {
  for (const value of [null, [], { ready: true }, { ready: true, bytes: -1 }, { ready: 1 }]) {
    const store = createModelStoreContract({ id: 'test', store: { ...memoryStore(), status: async () => value } })
    await assert.rejects(store.status(), { code: 'invalid_model_status' })
  }
  const bad = createModelStoreContract({ id: 'test', store: { ...memoryStore(), download: async ({ progress }) => {
    progress({ receivedBytes: 2, totalBytes: 1 }); return { ready: true, bytes: 30 } } } })
  await assert.rejects(bad.download(), { code: 'invalid_model_progress' })
  let saved, calls = 0
  const store = createModelStoreContract({ id: 'test', store: { ...memoryStore(), download: async ({ progress }) => {
    saved = progress; return { ready: true, bytes: 30, path: 'private' } } } })
  await store.download({ progress: () => calls++ }); saved({ receivedBytes: 1, totalBytes: 1 }); assert.equal(calls, 0)
  const failureStore = createModelStoreContract({ id: 'test', store: { ...memoryStore(), status: async () => { throw { code: 'invalid_model', path: 'private' } } } })
  await assert.rejects(failureStore.status(), { code: 'invalid_model' })
})

test('committed model removal reports completion even when cancellation arrives after dispatch', async () => {
  const controller = new AbortController()
  const store = createModelStoreContract({ id: 'test', store: { ...memoryStore(), remove: async () => controller.abort() } })
  assert.deepEqual(await store.remove({ signal: controller.signal }), { removed: true })
})
