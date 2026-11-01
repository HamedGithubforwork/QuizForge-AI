'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  offloadCandidates, benchmarkCandidates, createLocalOffloadPolicy,
} = require('../src/local-offload-policy.cjs')

const GIB = 1024 ** 3
const hardware = (vram, usable = true) => ({
  gpuAccelerationUsable: usable,
  gpuDevice: usable ? 'Vulkan0' : null,
  gpuMemoryBytes: vram,
  logicalCpuCount: 8,
})

test('auto offload is conservative for limited VRAM and works without any GPU', () => {
  assert.deepEqual(offloadCandidates(hardware(12 * GIB)), [99, 24, 0])
  assert.deepEqual(offloadCandidates(hardware(6 * GIB)), [48, 16, 0])
  assert.deepEqual(offloadCandidates(hardware(4 * GIB)), [24, 8, 0])
  assert.deepEqual(offloadCandidates(hardware(3 * GIB)), [12, 4, 0])
  assert.deepEqual(offloadCandidates(hardware(2 * GIB)), [6, 0])
  assert.deepEqual(offloadCandidates(hardware(GIB)), [0])
  assert.deepEqual(offloadCandidates(hardware(null)), [99, 16, 0])
  assert.deepEqual(offloadCandidates(hardware(16 * GIB, false)), [0])
  assert.deepEqual(benchmarkCandidates([99, 24, 0]), [99, 24])
  assert.deepEqual(benchmarkCandidates([12, 4, 0]), [12, 4, 0])
})

test('passively compares real quiz generation speed and reuses private hardware cache', async t => {
  const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-offload-'))
  t.after(() => fs.rm(userDataDirectory, { recursive: true, force: true }))
  const spec = hardware(4 * GIB)
  const tuner = createLocalOffloadPolicy({ userDataDirectory })
  await tuner.prepare(spec)
  assert.equal(tuner.choose(), 24)
  assert.deepEqual(tuner.fallbackLayers(), [8, 0])
  tuner.recordInference({ layers: 24, elapsedMs: 2400, completionTokens: 120 })
  await tuner.flush()
  assert.equal(tuner.choose(), 8)
  tuner.recordInference({ layers: 8, elapsedMs: 800, completionTokens: 120 })
  await tuner.flush()
  assert.equal(tuner.choose(), 0)
  tuner.recordInference({ layers: 0, elapsedMs: 5400, completionTokens: 120 })
  await tuner.flush()
  assert.equal(tuner.choose(), 8)
  const cached = await fs.readFile(path.join(userDataDirectory, 'local-ai', 'offload-profile.json'), 'utf8')
  assert.ok(!cached.includes('study notes'))
  const reopened = createLocalOffloadPolicy({ userDataDirectory })
  await reopened.prepare(spec)
  assert.equal(reopened.choose(), 8)
  assert.equal(reopened.snapshot().benchmarked, 3)
  const differentHardware = createLocalOffloadPolicy({ userDataDirectory })
  await differentHardware.prepare(hardware(2 * GIB))
  assert.equal(differentHardware.choose(), 6, 'changed VRAM invalidates the cached winner')
})

test('failed GPU allocations are remembered, and a CPU-only system never attempts Vulkan', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-offload-fallback-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const tuner = createLocalOffloadPolicy({ userDataDirectory: directory })
  await tuner.prepare(hardware(3 * GIB))
  assert.equal(tuner.choose(), 12)
  tuner.recordFailure(12)
  assert.equal(tuner.choose(), 12, 'one transient failure must not permanently demote GPU')
  tuner.recordFailure(12)
  assert.equal(tuner.choose(), 4)
  tuner.recordFailure(4)
  assert.equal(tuner.choose(), 4)
  tuner.recordFailure(4)
  await tuner.flush()
  assert.equal(tuner.choose(), 0)
  const reopened = createLocalOffloadPolicy({ userDataDirectory: directory })
  await reopened.prepare(hardware(3 * GIB))
  assert.equal(reopened.choose(), 0)
  const noGpu = createLocalOffloadPolicy({ userDataDirectory: directory })
  await noGpu.prepare(hardware(0, false))
  assert.equal(noGpu.choose(), 0)
  assert.deepEqual(noGpu.fallbackLayers(), [])
})

test('invalid, oversized and mismatched cache data cannot override safe offload choices', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-offload-invalid-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const folder = path.join(directory, 'local-ai')
  await fs.mkdir(folder)
  const filename = path.join(folder, 'offload-profile.json')
  for (const invalid of ['{invalid', 'x'.repeat(5000), JSON.stringify({
    schema: 1, signature: 'bogus', timings: { '99': { ms: 0, tokens: 0, samples: -1 } },
    failed: [99],
  })]) {
    await fs.writeFile(filename, invalid)
    const tuner = createLocalOffloadPolicy({ userDataDirectory: directory })
    await tuner.prepare(hardware(8 * GIB))
    assert.equal(tuner.choose(), 99)
  }
})
