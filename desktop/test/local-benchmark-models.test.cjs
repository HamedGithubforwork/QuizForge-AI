'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { CANDIDATE } = require('../src/local-model-store.cjs')
const { BENCHMARK_MODELS, getBenchmarkModel } = require('../src/local-benchmark-models.cjs')

const VERIFIED = Object.freeze({
  'qwen3-1p7b-q4-k-m': ['d2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5', 1282439264],
  'qwen3-0p6b-q4-k-m': ['9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14', 484220320],
  'deepseek-r1-qwen-1p5b-q4-k-m': ['1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f', 1117320800],
  'deepseek-r1-qwen-7b-q4-k-m': ['731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b', 4683073504],
})

test('benchmark only includes three Qwen sizes and two reviewed DeepSeek GGUFs', () => {
  assert.deepEqual(Object.keys(BENCHMARK_MODELS).sort(), [CANDIDATE.id, ...Object.keys(VERIFIED)].sort())
  assert.equal(getBenchmarkModel(CANDIDATE.id), CANDIDATE)
  for (const [id, [sha, size]] of Object.entries(VERIFIED)) {
    const model = getBenchmarkModel(id)
    assert.equal(model.id, id)
    assert.equal(model.sha256, sha)
    assert.equal(model.bytes, size)
    assert.equal(new URL(model.url).hostname, 'huggingface.co')
    assert.ok(model.url.includes('/resolve/main/'))
    assert.ok(/^https:\/\/huggingface\.co\/(?:ggml-org|bartowski|Qwen)\//.test(model.url))
    assert.ok(Object.isFrozen(model))
  }
})

test('arbitrary model ids and download URLs are rejected', () => {
  for (const id of ['unknown', 'http://evil.invalid/model.gguf', '../model', '', null, {}, '__proto__']) {
    assert.throws(() => getBenchmarkModel(id), TypeError)
  }
})
