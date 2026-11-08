'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createLocalOffloadPolicy } = require('../src/local-offload-policy.cjs')
const {
  isCompletedInferenceProfile,
  recordCompletedInferenceProfile,
} = require('../src/windows-local-ai-stack.cjs')

test('unconfirmed GPU timing cannot influence profile selection', async t => {
  const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-profile-measurement-'))
  t.after(() => fs.rm(userDataDirectory, { recursive: true, force: true }))
  const policy = createLocalOffloadPolicy({ userDataDirectory })
  await policy.prepare({
    gpuAccelerationUsable: true,
    gpuDevice: 'Vulkan0',
    gpuMemoryBytes: 12 * 1024 ** 3,
    logicalCpuCount: 12,
  })

  const unknownGpu = {
    layers: 99, acceleration: 'unknown', elapsedMs: 18000,
    decodeMs: 11600, completionTokens: 1000,
  }
  assert.equal(policy.choose(), 99)
  assert.equal(isCompletedInferenceProfile(unknownGpu), false)
  assert.equal(recordCompletedInferenceProfile(policy, unknownGpu), false)
  assert.equal(isCompletedInferenceProfile({ layers: 24, acceleration: 'gpu' }), true)
  assert.equal(isCompletedInferenceProfile({ layers: 0, acceleration: 'cpu' }), true)
  assert.equal(isCompletedInferenceProfile({ layers: 99, acceleration: 'cpu' }), false)
  assert.equal(recordCompletedInferenceProfile(policy, {
    layers: 24, acceleration: 'cpu', elapsedMs: 8000,
    decodeMs: 5000, completionTokens: 800,
  }), false)
  assert.equal(isCompletedInferenceProfile({ layers: -1, acceleration: 'unknown' }), false)
  assert.equal(isCompletedInferenceProfile({ layers: 1.5, acceleration: 'gpu' }), false)

  assert.equal(policy.choose(), 99, 'unknown telemetry must not count a GPU candidate as measured')
  const confirmedGpu = { ...unknownGpu, acceleration: 'gpu' }
  assert.equal(recordCompletedInferenceProfile(policy, confirmedGpu), true)
  assert.equal(policy.choose(), 24, 'confirmed GPU timing may advance normal calibration')

  await policy.flush()
  const profile = JSON.parse(await fs.readFile(
    path.join(userDataDirectory, 'local-ai', 'offload-profile.json'), 'utf8'))
  assert.deepEqual(Object.keys(profile.timings), ['99'])
  assert.deepEqual(profile.timings['99'], {
    tokens: 1000, ms: 18000, samples: 1, decodeTokens: 1000, decodeMs: 11600,
  })
})
