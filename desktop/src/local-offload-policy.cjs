'use strict'

// Main-process-only, privacy-preserving hardware calibration. Compare actual
// tokens/second over subsequent normal quiz generations; never upload prompts
// or run hidden model generations before the user's first quiz.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')
const { CANDIDATE } = require('./local-model-store.cjs')
const { MANIFEST } = require('./local-runtime.cjs')

const GIB = 1024 ** 3
const CACHE_VERSION = 4
const MAX_CACHE_BYTES = 4096
const MAX_SAMPLES = 8

function offloadCandidates(hardware) {
  if (!hardware?.gpuAccelerationUsable || !/^Vulkan\d+$/.test(hardware.gpuDevice ?? '')) {
    return Object.freeze([0])
  }
  const bytes = hardware.gpuMemoryBytes
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    // Unknown reported VRAM: retain compatibility with existing hardware,
    // but bound fallback to a smaller offload and then to CPU.
    return Object.freeze([99, 16, 0])
  }
  if (bytes >= 8 * GIB) return Object.freeze([99, 24, 0])
  if (bytes >= 6 * GIB) return Object.freeze([48, 16, 0])
  if (bytes >= 4 * GIB) return Object.freeze([24, 8, 0])
  if (bytes >= 3 * GIB) return Object.freeze([12, 4, 0])
  if (bytes >= 2 * GIB) return Object.freeze([6, 0])
  return Object.freeze([0])
}

function benchmarkCandidates(candidates) {
  // A powerful GPU should not slow down a customer's second quiz merely to
  // benchmark an almost certainly slower CPU. CPU remains an emergency fallback.
  return candidates[0] === 99 ? candidates.filter(layers => layers > 0)
    : candidates
}

function signature(hardware, modelSha256 = CANDIDATE.sha256) {
  return createHash('sha256').update(JSON.stringify([
    CACHE_VERSION,
    modelSha256,
    MANIFEST.files,
    hardware.gpuDevice ?? null,
    hardware.gpuMemoryBytes ?? null,
    hardware.logicalCpuCount ?? null,
    offloadCandidates(hardware),
  ])).digest('hex')
}

function safeCache(value, expectedSignature, candidates) {
  if (!value || value.schema !== CACHE_VERSION || value.signature !== expectedSignature ||
      !value.timings || typeof value.timings !== 'object' || Array.isArray(value.timings) ||
      !Array.isArray(value.failed) || !value.failureCounts ||
      typeof value.failureCounts !== 'object' || Array.isArray(value.failureCounts)) return null
  const timings = {}
  for (const [key, score] of Object.entries(value.timings)) {
    const layers = Number(key)
    if (!candidates.includes(layers) || !score || !Number.isSafeInteger(score.tokens) ||
        score.tokens < 1 || score.tokens > 10_000_000 ||
        !Number.isFinite(score.ms) || score.ms <= 0 || score.ms > 3_600_000 ||
        !Number.isSafeInteger(score.samples) || score.samples < 1 || score.samples > MAX_SAMPLES) {
      return null
    }
    if ((score.decodeTokens === undefined) !== (score.decodeMs === undefined) ||
        (score.decodeTokens !== undefined &&
          (!Number.isSafeInteger(score.decodeTokens) || score.decodeTokens < 1 ||
           score.decodeTokens > score.tokens || !Number.isFinite(score.decodeMs) ||
           score.decodeMs <= 0 || score.decodeMs > score.ms))) return null
    timings[key] = { tokens: score.tokens, ms: score.ms, samples: score.samples,
      ...(score.decodeTokens !== undefined
        ? { decodeTokens: score.decodeTokens, decodeMs: score.decodeMs } : {}) }
  }
  if (value.failed.length > candidates.length ||
      value.failed.some(x => !candidates.includes(x) || x === 0) ||
      new Set(value.failed).size !== value.failed.length) return null
  const failureCounts = {}
  for (const [key, count] of Object.entries(value.failureCounts)) {
    const layers = Number(key)
    if (!candidates.includes(layers) || layers === 0 ||
        !Number.isSafeInteger(count) || count < 1 || count > 2) return null
    failureCounts[key] = count
  }
  if (value.failed.some(x => failureCounts[String(x)] !== 2)) return null
  const cpuTimings = {}
  if (value.cpuTimings && typeof value.cpuTimings === 'object' &&
      !Array.isArray(value.cpuTimings)) {
    for (const [key, score] of Object.entries(value.cpuTimings)) {
      if (!/^(?:[1-9]|1[0-6])$/.test(key) || !score ||
          !Number.isSafeInteger(score.tokens) || score.tokens < 1 ||
          !Number.isFinite(score.ms) || score.ms <= 0 ||
          !Number.isSafeInteger(score.samples) || score.samples < 1 || score.samples > MAX_SAMPLES) return null
      if ((score.decodeTokens === undefined) !== (score.decodeMs === undefined) ||
          (score.decodeTokens !== undefined &&
            (!Number.isSafeInteger(score.decodeTokens) || score.decodeTokens < 1 ||
             score.decodeTokens > score.tokens || !Number.isFinite(score.decodeMs) ||
             score.decodeMs <= 0 || score.decodeMs > score.ms))) return null
      cpuTimings[key] = { tokens: score.tokens, ms: score.ms, samples: score.samples,
        ...(score.decodeTokens !== undefined
          ? { decodeTokens: score.decodeTokens, decodeMs: score.decodeMs } : {}) }
    }
  }
  return { timings, cpuTimings, failed: [...value.failed], failureCounts }
}

function createLocalOffloadPolicy({ userDataDirectory, fileSystem = fs,
  modelSha256 = CANDIDATE.sha256 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(modelSha256)) throw new TypeError('Invalid model identity')
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) {
    throw new TypeError('An absolute Local AI profile directory is required')
  }
  const directory = path.join(userDataDirectory, 'local-ai')
  const filename = path.join(directory, 'offload-profile.json')
  let candidates = Object.freeze([0])
  let fingerprint = null
  let timings = {}
  let cpuTimings = {}
  let cpuCandidates = [8]
  let selectedCpuThreads = 8
  let failed = []
  let failureCounts = {}
  let ready = false
  let selected = 0
  let writes = Promise.resolve()

  async function prepare(hardware) {
    if (ready) return
    candidates = offloadCandidates(hardware)
    const logical = Number.isSafeInteger(hardware?.logicalCpuCount) && hardware.logicalCpuCount > 0
      ? hardware.logicalCpuCount : 8
    const first = Math.min(8, Math.max(1, logical))
    cpuCandidates = [...new Set([first, Math.max(1, first - 2)])]
    selectedCpuThreads = first
    fingerprint = signature(hardware, modelSha256)
    try {
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
      const dir = await fileSystem.lstat(directory)
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe profile directory')
      const info = await fileSystem.lstat(filename).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) {
          throw new Error('Invalid profile cache')
        }
        const data = JSON.parse(await fileSystem.readFile(filename, 'utf8'))
        const cached = safeCache(data, fingerprint, candidates)
        if (cached) {
          timings = cached.timings
          cpuTimings = cached.cpuTimings ?? {}
          failed = cached.failed
          failureCounts = cached.failureCounts
        }
      }
    } catch {
      // Cache failures must never prevent offline quiz generation.
    }
    ready = true
  }

  // Compare pure decode throughput only when both hardware profiles expose
  // comparable llama.cpp timings. Otherwise retain the existing end-to-end
  // observed token throughput. This avoids rewarding a profile solely for
  // receiving a shorter source/prefill by chance.
  function msPerToken(score, other) {
    return score.decodeTokens > 0 && other.decodeTokens > 0
      ? score.decodeMs / score.decodeTokens
      : score.ms / score.tokens
  }

  function choose() {
    const available = candidates.filter(value => !failed.includes(value))
    const benchmark = benchmarkCandidates(available)
    const untested = benchmark.find(value => !timings[String(value)])
    if (untested !== undefined) {
      selected = untested
      return selected
    }
    const measured = benchmark.filter(value => timings[String(value)])
    selected = measured.length ? measured.reduce((fastest, value) => {
      const score = timings[String(value)]
      const best = timings[String(fastest)]
      return msPerToken(score, best) < msPerToken(best, score) * 0.9 ? value : fastest
    }, measured[0]) : (available[0] ?? 0)
    return selected
  }

  function chooseThreads() {
    const candidate = cpuCandidates.find(value => !cpuTimings[String(value)])
    if (candidate !== undefined) return (selectedCpuThreads = candidate)
    selectedCpuThreads = cpuCandidates.reduce((fastest, value) => {
      const score = cpuTimings[String(value)]
      const best = cpuTimings[String(fastest)]
      return msPerToken(score, best) < msPerToken(best, score) * 0.95 ? value : fastest
    }, cpuCandidates[0])
    return selectedCpuThreads
  }

  function fallbackLayers() {
    const available = candidates.filter(value => !failed.includes(value))
    const index = available.indexOf(selected)
    // Never switch to a larger GPU allocation after a smaller one fails.
    return Object.freeze(available.slice(index < 0 ? 0 : index + 1))
  }

  function save() {
    const document = JSON.stringify({
      schema: CACHE_VERSION, signature: fingerprint,
      timings, cpuTimings, failed, failureCounts,
    })
    writes = writes.then(async () => {
      const temp = path.join(directory, '.offload-' + randomBytes(8).toString('hex') + '.tmp')
      try {
        await fileSystem.writeFile(temp, document, { flag: 'wx', mode: 0o600 })
        await fileSystem.rename(temp, filename)
      } finally {
        await fileSystem.rm(temp, { force: true }).catch(() => {})
      }
    }).catch(() => {})
  }

  function recordFailure(value) {
    if (!ready || value === 0 || !candidates.includes(value) || failed.includes(value)) return
    // A single GPU startup failure may be an intermittent watchdog or
    // Windows driver hiccup. Require two failures before remembering that
    // allocation as unavailable on future launches.
    const count = Math.min(2, (failureCounts[String(value)] ?? 0) + 1)
    failureCounts[String(value)] = count
    if (count >= 2) failed.push(value)
    save()
  }

  function recordInference({ layers, elapsedMs, decodeMs, completionTokens, threads }) {
    const measuredDecode = Number.isFinite(decodeMs) &&
      decodeMs > 0 && decodeMs <= elapsedMs ? decodeMs : null
    function addSample(prior) {
      const next = { tokens: prior.tokens + completionTokens,
        ms: prior.ms + elapsedMs, samples: prior.samples + 1 }
      if (measuredDecode !== null) {
        next.decodeTokens = (prior.decodeTokens ?? 0) + completionTokens
        next.decodeMs = (prior.decodeMs ?? 0) + measuredDecode
      } else if (prior.decodeTokens > 0) {
        next.decodeTokens = prior.decodeTokens
        next.decodeMs = prior.decodeMs
      }
      return next
    }
    if (ready && layers === 0 && cpuCandidates.includes(threads) &&
        Number.isFinite(elapsedMs) && elapsedMs > 0 &&
        Number.isSafeInteger(completionTokens) && completionTokens >= 16) {
      const key = String(threads)
      const old = cpuTimings[key] ?? { tokens: 0, ms: 0, samples: 0 }
      if (old.samples < MAX_SAMPLES) {
        cpuTimings[key] = addSample(old)
        save()
      }
    }
    if (!ready || !candidates.includes(layers) || failed.includes(layers) ||
        !Number.isFinite(elapsedMs) || elapsedMs <= 0 ||
        !Number.isSafeInteger(completionTokens) || completionTokens < 16) return
    const key = String(layers)
    const prior = timings[key] ?? { tokens: 0, ms: 0, samples: 0 }
    if (prior.samples >= MAX_SAMPLES) return
    timings[key] = addSample(prior)
    save()
  }

  async function flush() { await writes }

  return Object.freeze({
    prepare, choose, chooseThreads, fallbackLayers, recordFailure, recordInference, flush,
    selectedLayers: () => selected,
    snapshot: () => Object.freeze({ selected, candidates, benchmarked: Object.keys(timings).length }),
  })
}

module.exports = { offloadCandidates, benchmarkCandidates, createLocalOffloadPolicy }
