'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { CANDIDATE, createLocalModelStore } = require('../src/local-model-store.cjs')

async function main() {
  if (!process.argv[2]) throw new Error('Pass the verified model directory')
  const store = createLocalModelStore({ directory: path.resolve(process.argv[2]) })
  // Cache data is untrusted. status() checks the complete pinned model SHA-256,
  // file type, and exact bytes before it can be used by the runtime.
  let result = await store.status()
  if (!result.ready) {
    console.log('Model cache miss; downloading pinned model with SHA-256 verification')
    await store.download()
    result = await store.status()
  }
  assert.equal(result.ready, true)
  assert.equal(result.bytes, CANDIDATE.bytes)
  assert.equal(path.basename(result.path), CANDIDATE.sha256 + '.gguf')
  console.log('PASS: pinned model is present and SHA-256 verified')
}

main().catch(error => {
  console.error('Verified Local AI model preparation failed:', error?.code || error?.message || 'unknown')
  process.exitCode = 1
})
