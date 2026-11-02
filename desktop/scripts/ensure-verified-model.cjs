'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { CANDIDATE, MODEL_DOWNLOAD_TIMEOUT_MS, createLocalModelStore } = require('../src/local-model-store.cjs')
const { getBenchmarkModel } = require('../src/local-benchmark-models.cjs')

async function main() {
  if (!process.argv[2]) throw new Error('Pass the verified model directory')
  const candidate = getBenchmarkModel(process.argv[3] ?? CANDIDATE.id)
  // The verified 7B GGUF can take longer than 20 minutes from Hugging Face.
  // CI comparison only: desktop user downloads still use the default cap.
  const downloadTimeoutMs = candidate.id === 'deepseek-r1-qwen-7b-q4-k-m'
    ? 35 * 60 * 1000 : MODEL_DOWNLOAD_TIMEOUT_MS
  const store = createLocalModelStore({
    directory: path.resolve(process.argv[2]), model: candidate, downloadTimeoutMs,
  })
  // Cache data is untrusted. status() checks the complete pinned model SHA-256,
  // file type, and exact bytes before it can be used by the runtime.
  let result = await store.status()
  if (!result.ready) {
    console.log('Model cache miss; downloading pinned model with SHA-256 verification')
    await store.download()
    result = await store.status()
  }
  assert.equal(result.ready, true)
  assert.equal(result.bytes, candidate.bytes)
  assert.equal(path.basename(result.path), candidate.sha256 + '.gguf')
  console.log('PASS: pinned model is present and SHA-256 verified: ' + candidate.id)
}

main().catch(error => {
  console.error('Verified Local AI model preparation failed:', error?.code || error?.message || 'unknown')
  process.exitCode = 1
})
