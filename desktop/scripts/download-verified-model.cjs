'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { CANDIDATE, createLocalModelStore } = require('../src/local-model-store.cjs')

async function main() {
  const directory = path.resolve(process.argv[2])
  const store = createLocalModelStore({ directory })
  let last = 0
  const result = await store.download({
    progress(value) {
      assert.equal(value.totalBytes, CANDIDATE.bytes)
      assert.ok(value.receivedBytes >= last)
      last = value.receivedBytes
    },
  })
  assert.equal(result.ready, true)
  assert.equal(result.bytes, CANDIDATE.bytes)
  assert.equal(last, CANDIDATE.bytes)
  const checked = await store.status()
  assert.equal(checked.ready, true)
  assert.equal(checked.bytes, CANDIDATE.bytes)
  assert.equal(path.basename(checked.path), CANDIDATE.sha256 + '.gguf')
  console.log('PASS: downloaded, hashed, atomically published and reverified pinned Local AI model')
}

main().catch(error => {
  console.error('Verified Local AI model download failed:', error?.code || error?.name || 'unknown')
  process.exitCode = 1
})
