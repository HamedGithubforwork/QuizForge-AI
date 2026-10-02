'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const api = require('../src/local-ai.cjs')

test('public Local AI API exports only portable product contracts', async () => {
  assert.deepEqual(Object.keys(api).sort(), ['LocalAiError', 'createLocalAiManager', 'createLocalAiProvider', 'createModelStoreContract', 'evaluateLocalAiCapability'])
  assert.equal(Object.isFrozen(api), true)
  const provider = api.createLocalAiProvider({ id: 'test',
    capability: async () => ({ available: true, reason: null, modelId: 'test' }),
    generate: async () => ({ text: 'test', finishReason: 'stop' }) })
  assert.deepEqual(await provider.generate({ messages: [{ role: 'user', content: 'test' }] }),
    { text: 'test', finishReason: 'stop', usage: null })
})
