'use strict'

const { failure, validId } = require('./local-ai-provider.cjs')

const TIERS = new Set(['lightweight', 'enhanced'])
const RECOMMENDATIONS = new Set([
  'lightweight-local-preview',
  'enhanced-local-preview',
  'cloud-only',
])
const DETECTION = new Set(['detected', 'none', 'unavailable', 'unsupported'])
const ACCELERATION = new Set(['cpu', 'gpu'])

const safeInteger = value => Number.isSafeInteger(value) && value >= 0
const arrayOf = (value, predicate) => Array.isArray(value) && value.every(predicate)
const stringId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !stringId(value.platform) || !stringId(value.arch) ||
      !safeInteger(value.totalMemoryBytes) || value.totalMemoryBytes < 1 ||
      !safeInteger(value.availableDiskBytes) ||
      !Number.isSafeInteger(value.logicalCpuCount) || value.logicalCpuCount < 1 ||
      typeof value.gpuDetected !== 'boolean' || !DETECTION.has(value.gpuDetection) ||
      value.gpuDetected !== (value.gpuDetection === 'detected') ||
      !arrayOf(value.runtimeAccelerationModes, mode => ACCELERATION.has(mode))) {
    throw failure('invalid_capability')
  }
  return Object.freeze({
    platform: value.platform,
    arch: value.arch,
    totalMemoryBytes: value.totalMemoryBytes,
    availableDiskBytes: value.availableDiskBytes,
    logicalCpuCount: value.logicalCpuCount,
    gpuDetected: value.gpuDetected,
    gpuDetection: value.gpuDetection,
    runtimeAccelerationModes: Object.freeze([...new Set(value.runtimeAccelerationModes)]),
  })
}

function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !validId(value.id) || !TIERS.has(value.tier) ||
      !safeInteger(value.modelBytes) || value.modelBytes < 1 ||
      !safeInteger(value.reserveDiskBytes) ||
      !safeInteger(value.minMemoryBytes) || value.minMemoryBytes < 1 ||
      !arrayOf(value.platforms, stringId) || value.platforms.length < 1 ||
      !arrayOf(value.arches, stringId) || value.arches.length < 1 ||
      !arrayOf(value.accelerationModes, mode => ACCELERATION.has(mode)) ||
      value.accelerationModes.length < 1 ||
      typeof value.releaseReady !== 'boolean') {
    throw failure('invalid_capability')
  }
  return Object.freeze({
    id: value.id,
    tier: value.tier,
    modelBytes: value.modelBytes,
    reserveDiskBytes: value.reserveDiskBytes,
    minMemoryBytes: value.minMemoryBytes,
    platforms: Object.freeze([...new Set(value.platforms)]),
    arches: Object.freeze([...new Set(value.arches)]),
    accelerationModes: Object.freeze([...new Set(value.accelerationModes)]),
    releaseReady: value.releaseReady,
  })
}

function evaluateLocalAiCapability(snapshotValue, profileValues = []) {
  const snapshot = normalizeSnapshot(snapshotValue)
  if (!Array.isArray(profileValues)) throw failure('invalid_capability')
  const profiles = profileValues.map(normalizeProfile)
  const platformProfiles = profiles.filter(profile =>
    profile.platforms.includes(snapshot.platform) && profile.arches.includes(snapshot.arch))
  const evaluated = platformProfiles.map(profile => {
    const diskRequiredBytes = profile.modelBytes + profile.reserveDiskBytes
    const memoryOk = snapshot.totalMemoryBytes >= profile.minMemoryBytes
    const diskOk = snapshot.availableDiskBytes >= diskRequiredBytes
    const acceleration = profile.accelerationModes.find(mode =>
      snapshot.runtimeAccelerationModes.includes(mode) && (mode !== 'gpu' || snapshot.gpuDetected)) ?? null
    return Object.freeze({ profile, memoryOk, diskOk, acceleration, diskRequiredBytes })
  })
  const eligible = evaluated.filter(item => item.memoryOk && item.diskOk && item.acceleration)
  const selected = eligible.find(item => item.profile.tier === 'enhanced') ??
    eligible.find(item => item.profile.tier === 'lightweight') ?? null

  const reasons = []
  if (!platformProfiles.length) reasons.push('unsupported_platform')
  else if (!selected) {
    if (evaluated.every(item => !item.memoryOk)) reasons.push('insufficient_memory')
    if (evaluated.every(item => !item.diskOk)) reasons.push('insufficient_disk')
    if (evaluated.every(item => item.acceleration === null)) reasons.push('runtime_acceleration_unavailable')
    if (!reasons.length) reasons.push('no_eligible_local_profile')
  }

  const recommendation = selected
    ? (selected.profile.tier === 'enhanced' ? 'enhanced-local-preview' : 'lightweight-local-preview')
    : 'cloud-only'
  if (!RECOMMENDATIONS.has(recommendation)) throw failure('invalid_capability')

  return Object.freeze({
    localEligible: selected !== null,
    recommendation,
    modelId: selected?.profile.id ?? null,
    acceleration: selected?.acceleration ?? null,
    releaseReady: selected?.profile.releaseReady ?? false,
    reasons: Object.freeze(reasons),
    hardware: Object.freeze({
      platform: snapshot.platform,
      arch: snapshot.arch,
      totalMemoryBytes: snapshot.totalMemoryBytes,
      availableDiskBytes: snapshot.availableDiskBytes,
      logicalCpuCount: snapshot.logicalCpuCount,
      gpuDetected: snapshot.gpuDetected,
      gpuDetection: snapshot.gpuDetection,
      gpuAccelerationUsable: snapshot.gpuDetected &&
        snapshot.runtimeAccelerationModes.includes('gpu'),
    }),
    requirements: selected ? Object.freeze({
      modelBytes: selected.profile.modelBytes,
      reserveDiskBytes: selected.profile.reserveDiskBytes,
      diskRequiredBytes: selected.diskRequiredBytes,
      minMemoryBytes: selected.profile.minMemoryBytes,
    }) : null,
  })
}

module.exports = { evaluateLocalAiCapability }
