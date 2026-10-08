'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const { evaluateLocalAiCapability } = require('../src/local-ai.cjs')
const {
  WINDOWS_EXPERIMENTAL_PROFILES,
  probeWindowsLocalAiCapability,
  queryWindowsGpu,
  queryWindowsVulkanDevices,
  snapshotWindowsHardware,
} = require('../src/windows-hardware-probe.cjs')

const GIB = 1024 ** 3

function snapshot(overrides = {}) {
  return {
    platform: 'win32',
    arch: 'x64',
    totalMemoryBytes: 16 * GIB,
    availableDiskBytes: 20 * GIB,
    logicalCpuCount: 8,
    gpuDetected: true,
    gpuDevice: 'Vulkan0',
    gpuDetection: 'detected',
    runtimeAccelerationModes: ['cpu'],
    ...overrides,
  }
}

test('enhanced preview is eligible without claiming release readiness or GPU acceleration', () => {
  const result = evaluateLocalAiCapability(snapshot(), WINDOWS_EXPERIMENTAL_PROFILES)
  assert.equal(result.localEligible, true)
  assert.equal(result.recommendation, 'enhanced-local-preview')
  assert.equal(result.modelId, 'qwen3-4b-q4-k-m')
  assert.equal(result.acceleration, 'cpu')
  assert.equal(result.releaseReady, false)
  assert.equal(result.hardware.gpuDetected, true)
  assert.equal(result.hardware.gpuAccelerationUsable, false)
  assert.deepEqual(result.reasons, [])
  assert.ok(result.requirements.diskRequiredBytes > result.requirements.modelBytes)
})

test('unsupported, low-memory and low-disk machines fail with bounded reasons', () => {
  assert.deepEqual(
    evaluateLocalAiCapability(snapshot({ platform: 'linux' }), WINDOWS_EXPERIMENTAL_PROFILES).reasons,
    ['unsupported_platform'],
  )
  assert.deepEqual(
    evaluateLocalAiCapability(snapshot({ totalMemoryBytes: 4 * GIB }), WINDOWS_EXPERIMENTAL_PROFILES).reasons,
    ['insufficient_memory'],
  )
  assert.deepEqual(
    evaluateLocalAiCapability(snapshot({ availableDiskBytes: 1024 }), WINDOWS_EXPERIMENTAL_PROFILES).reasons,
    ['insufficient_disk'],
  )
})

test('policy already supports a future lightweight tier without choosing one today', () => {
  const lightweight = [{
    id: 'future-lightweight',
    tier: 'lightweight',
    modelBytes: GIB,
    reserveDiskBytes: GIB,
    minMemoryBytes: 4 * GIB,
    platforms: ['win32'],
    arches: ['x64'],
    accelerationModes: ['cpu'],
    releaseReady: false,
  }]
  const result = evaluateLocalAiCapability(snapshot({ totalMemoryBytes: 6 * GIB }), lightweight)
  assert.equal(result.recommendation, 'lightweight-local-preview')
  assert.equal(result.modelId, 'future-lightweight')
})

test('GPU acceleration is reported usable only when both hardware and runtime support it', () => {
  const profile = [{ ...WINDOWS_EXPERIMENTAL_PROFILES[0], accelerationModes: ['gpu'] }]
  const unavailable = evaluateLocalAiCapability(snapshot(), profile)
  assert.equal(unavailable.localEligible, false)
  assert.deepEqual(unavailable.reasons, ['runtime_acceleration_unavailable'])
  const available = evaluateLocalAiCapability(snapshot({ runtimeAccelerationModes: ['cpu', 'gpu'] }), profile)
  assert.equal(available.localEligible, true)
  assert.equal(available.acceleration, 'gpu')
  assert.equal(available.hardware.gpuAccelerationUsable, true)
  assert.equal(evaluateLocalAiCapability(
    snapshot({ runtimeAccelerationModes: ['cpu', 'gpu'] }), WINDOWS_EXPERIMENTAL_PROFILES,
  ).acceleration, 'gpu')
})

test('Vulkan probe runs the pinned server device listing and requires a Vulkan device', async () => {
  let called = false
  const result = await queryWindowsVulkanDevices({
    directory: path.resolve('runtime'),
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    verifyRuntimeFn: async (directory, manifest) => {
      assert.equal(directory, path.resolve('runtime'))
      assert.equal(manifest.package, 'server-only')
    },
    exec(file, args, options, callback) {
      called = true
      assert.match(file, /llama-server\.exe$/)
      assert.deepEqual(args, ['--list-devices'])
      assert.equal(options.timeout, 15000)
      assert.equal(options.windowsHide, true)
      callback(null, '', 'Available devices:\n  Vulkan0: Test GPU (4096 MiB)')
    },
  })
  assert.equal(called, true)
  assert.deepEqual(result, { detected: true, deviceId: 'Vulkan0' })

  const noDevice = await queryWindowsVulkanDevices({
    directory: path.resolve('runtime'),
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    verifyRuntimeFn: async () => {},
    exec(_file, _args, _options, callback) { callback(null, 'Available devices:\n  CPU: x64', '') },
  })
  assert.deepEqual(noDevice, { detected: false, deviceId: null })
})

test('Vulkan probe returns the enumerated device id when it is not the first ordinal', async () => {
  const result = await queryWindowsVulkanDevices({
    directory: path.resolve('runtime'),
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    verifyRuntimeFn: async () => {},
    exec(_file, _args, _options, callback) {
      callback(null, 'Available devices:\n  Vulkan1: Discrete GPU (8192 MiB)', '')
    },
  })
  assert.deepEqual(result, { detected: true, deviceId: 'Vulkan1' })
})

test('hardware snapshot enables GPU mode only when Vulkan enumeration finds a device', async () => {
  const result = await snapshotWindowsHardware({
    storageDirectory: path.resolve('models'),
    runtimeDirectory: path.resolve('runtime'),
    platform: 'win32',
    arch: 'x64',
    osModule: { totalmem: () => 16 * GIB, cpus: () => Array(8) },
    fsModule: { statfs: async () => ({ bavail: 10, bsize: GIB }) },
    env: { SystemRoot: 'C:\\Windows' },
    verifyRuntimeFn: async () => {},
    exec(file, _args, _options, callback) {
      if (/llama-server\.exe$/i.test(file)) callback(null, '', 'Vulkan0: Test GPU (4096 MiB)')
      else callback(null, '["Test GPU"]', '')
    },
  })
  assert.equal(result.gpuDetected, true)
  assert.equal(result.gpuDevice, 'Vulkan0')
  assert.deepEqual(result.runtimeAccelerationModes, ['cpu', 'gpu'])
})

test('Windows GPU query is bounded and degrades safely when inspection fails', async () => {
  const ok = await queryWindowsGpu({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    exec(_file, _args, options, callback) {
      assert.equal(options.windowsHide, true)
      assert.equal(options.timeout, 5000)
      callback(null, '["Synthetic GPU"]')
    },
  })
  assert.deepEqual(ok, { detected: true, detection: 'detected' })
  const failed = await queryWindowsGpu({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    exec(_file, _args, _options, callback) { callback(new Error('synthetic failure')) },
  })
  assert.deepEqual(failed, { detected: false, detection: 'unavailable' })
})

test('real Windows runner can take a safe capability snapshot without enabling inference', {
  skip: process.platform !== 'win32',
}, async () => {
  const result = await probeWindowsLocalAiCapability({ storageDirectory: os.tmpdir() })
  assert.equal(result.hardware.platform, 'win32')
  assert.equal(result.hardware.arch, process.arch)
  assert.ok(result.hardware.totalMemoryBytes > 0)
  assert.ok(result.hardware.availableDiskBytes > 0)
  assert.ok(result.hardware.logicalCpuCount > 0)
  assert.equal(result.releaseReady, false)
  assert.ok(['detected', 'none', 'unavailable'].includes(result.hardware.gpuDetection))
})


test('inconsistent GPU presence facts are rejected instead of becoming policy input', () => {
  assert.throws(
    () => evaluateLocalAiCapability(snapshot({ gpuDetected: true, gpuDetection: 'none' }), WINDOWS_EXPERIMENTAL_PROFILES),
    { code: 'invalid_capability' },
  )
  assert.throws(
    () => evaluateLocalAiCapability(snapshot({ gpuDetected: false, gpuDetection: 'detected' }), WINDOWS_EXPERIMENTAL_PROFILES),
    { code: 'invalid_capability' },
  )
})
