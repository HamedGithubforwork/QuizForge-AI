'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { verifyRuntime, MANIFEST } = require('../src/local-runtime.cjs')

async function main() {
  const directory = path.resolve(process.argv[2] ?? '')
  const executable = await verifyRuntime(directory)
  assert.equal(path.basename(executable), 'llama-server.exe')
  const names = Object.keys(MANIFEST.files)
  assert.equal(names.includes('LICENSE-LLAMA-CPP'), true)
  assert.equal(names.includes('LICENSE-JSONHPP'), true)
  assert.equal(names.includes('LICENSE-LLVM-OpenMP'), true)
  console.log('PASS: packaged Local AI runtime matches server-only manifest and notices')
}

main().catch(error => {
  console.error('Packaged runtime verification failed:', error?.code || error?.name || 'unknown')
  process.exitCode = 1
})
