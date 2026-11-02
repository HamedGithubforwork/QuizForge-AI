'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { CANDIDATE } = require('../src/local-model-store.cjs')
const { BENCHMARK_MODELS, getBenchmarkModel } = require('../src/local-benchmark-models.cjs')

const VERIFIED = Object.freeze({
  'deepseek-r1-qwen-1p5b-q4-k-m': ['1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f', 1117320800],
  'deepseek-r1-qwen-7b-q4-k-m': ['731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b', 4683073504],
})

test('benchmark only includes the product Qwen and two reviewed DeepSeek GGUFs', () => {
  assert.deepEqual(Object.keys(BENCHMARK_MODELS).sort(), [CANDIDATE.id, ...Object.keys(VERIFIED)].sort())
  assert.equal(getBenchmarkModel(CANDIDATE.id), CANDIDATE)
  for (const [id, [sha, size]] of Object.entries(VERIFIED)) {
    const model = getBenchmarkModel(id)
    assert.equal(model.id, id)
    assert.equal(model.sha256, sha)
    assert.equal(model.bytes, size)
    assert.equal(new URL(model.url).hostname, 'huggingface.co')
    assert.ok(Object.isFrozen(model))
  }
})

test('arbitrary model ids and download URLs are rejected', () => {
  for (const id of ['unknown', 'http://evil.invalid/model.gguf', '../model', '', null, {}, '__proto__']) {
    assert.throws(() => getBenchmarkModel(id), TypeError)
  }
})
