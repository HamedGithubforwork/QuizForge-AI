'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { evaluateLocalAiCapability } = require('./local-ai.cjs')
const { MANIFEST, verifyRuntime } = require('./local-runtime.cjs')

const GIB = 1024 ** 3
const MIB = 1024 ** 2

// Preview-only policy. The 4B candidate peaked around 4.8-5.0 GiB child RSS on
// Linux; Windows memory and consumer-device behavior remain unmeasured. Eight GiB
// is therefore an eligibility floor with headroom, not a published requirement.
const WINDOWS_EXPERIMENTAL_PROFILES = Object.freeze([
  Object.freeze({
    id: 'qwen3-4b-q4-k-m',
    tier: 'enhanced',
    modelBytes: 2497280256,
    reserveDiskBytes: 512 * MIB,
    minMemoryBytes: 8 * GIB,
    platforms: Object.freeze(['win32']),
    arches: Object.freeze(['x64']),
    accelerationModes: Object.freeze(['gpu', 'cpu']),
    releaseReady: false,
  }),
])

function safeEnvironment(source = process.env) {
  const env = {}
  for (const expected of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const found = Object.keys(source).find(name => name.toLowerCase() === expected.toLowerCase())
    if (found && typeof source[found] === 'string') env[expected] = source[found]
  }
  if (env.SystemRoot) env.PATH = path.join(env.SystemRoot, 'System32')
  return env
}

function execute(executable, args, options, implementation = execFile) {
  return new Promise((resolve, reject) => {
    implementation(executable, args, options, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function queryWindowsGpu({ platform = process.platform, env = process.env, exec = execFile } = {}) {
  if (platform !== 'win32') return Object.freeze({ detected: false, detection: 'unsupported' })
  const safe = safeEnvironment(env)
  if (!safe.SystemRoot) return Object.freeze({ detected: false, detection: 'unavailable' })
  const executable = path.join(safe.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"
  try {
    const stdout = await execute(executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5000, maxBuffer: 16384, env: safe }, exec)
    const parsed = JSON.parse(String(stdout).trim() || '[]')
    const names = (Array.isArray(parsed) ? parsed : [parsed])
      .filter(name => typeof name === 'string' && name.trim() && name.length <= 200)
      .slice(0, 16)
    return Object.freeze({ detected: names.length > 0, detection: names.length ? 'detected' : 'none' })
  } catch {
    return Object.freeze({ detected: false, detection: 'unavailable' })
  }
}

async function queryWindowsVulkanDevices({
  directory,
  platform = process.platform,
  env = process.env,
  exec = execFile,
  verifyRuntimeFn = verifyRuntime,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ detected: false })
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return Object.freeze({ detected: false })
  let safe
  try {
    await verifyRuntimeFn(directory, MANIFEST)
    safe = safeEnvironment(env)
    if (!safe.SystemRoot) return Object.freeze({ detected: false })
  } catch {
    return Object.freeze({ detected: false })
  }
  const executable = path.join(directory, 'llama-server.exe')
  return await new Promise(resolve => {
    exec(executable, ['--list-devices'], {
      cwd: directory,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
      env: safe,
    }, (error, stdout, stderr) => {
      if (error) return resolve(Object.freeze({ detected: false }))
      const output = String(stdout || '') + '\n' + String(stderr || '')
      const detected = /\bVulkan\d+\s*:\s*[^\r\n]+/i.test(output)
      resolve(Object.freeze({ detected }))
    })
  })
}

async function snapshotWindowsHardware({
  storageDirectory,
  platform = process.platform,
  arch = process.arch,
  osModule = os,
  fsModule = fs,
  env = process.env,
  exec = execFile,
  runtimeAccelerationModes = ['cpu'],
  runtimeDirectory,
  verifyRuntimeFn,
} = {}) {
  if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory)) {
    throw Object.assign(new Error('Hardware capability: invalid_storage_directory'),
      { code: 'invalid_storage_directory' })
  }
  const disk = await fsModule.statfs(storageDirectory)
  const gpu = await queryWindowsGpu({ platform, env, exec })
  const vulkan = await queryWindowsVulkanDevices({
    directory: runtimeDirectory,
    platform,
    env,
    exec,
    ...(verifyRuntimeFn ? { verifyRuntimeFn } : {}),
  })
  const accelerationModes = [...new Set([
    ...runtimeAccelerationModes,
    ...(vulkan.detected ? ['gpu'] : []),
  ])]
  return Object.freeze({
    platform,
    arch,
    totalMemoryBytes: osModule.totalmem(),
    availableDiskBytes: disk.bavail * disk.bsize,
    logicalCpuCount: Math.max(1, osModule.cpus().length),
    gpuDetected: gpu.detected,
    gpuDetection: gpu.detection,
    runtimeAccelerationModes: Object.freeze(accelerationModes),
  })
}

async function probeWindowsLocalAiCapability(options = {}) {
  const snapshot = await snapshotWindowsHardware(options)
  return evaluateLocalAiCapability(snapshot, options.profiles ?? WINDOWS_EXPERIMENTAL_PROFILES)
}

module.exports = {
  WINDOWS_EXPERIMENTAL_PROFILES,
  probeWindowsLocalAiCapability,
  queryWindowsGpu,
  queryWindowsVulkanDevices,
  safeEnvironment,
  snapshotWindowsHardware,
}
