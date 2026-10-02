'use strict'

const { LocalAiError, failure } = require('./local-ai-provider.cjs')

const safeError = error => error instanceof LocalAiError ? error.code : 'model_store_failed'
const RECOMMENDATIONS = new Set([
  'enhanced-local-preview',
  'lightweight-local-preview',
  'cloud-only',
])
const ACCELERATION = new Set(['cpu', 'gpu'])
const REASONS = new Set([
  'unsupported_platform',
  'insufficient_memory',
  'insufficient_disk',
  'runtime_acceleration_unavailable',
  'no_eligible_local_profile',
])

function publicCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.localEligible !== 'boolean' ||
      !RECOMMENDATIONS.has(value.recommendation) ||
      (value.modelId !== null && value.modelId !== undefined &&
        (typeof value.modelId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(value.modelId))) ||
      (value.acceleration !== null && value.acceleration !== undefined &&
        !ACCELERATION.has(value.acceleration)) ||
      typeof value.releaseReady !== 'boolean' ||
      !Array.isArray(value.reasons) || value.reasons.some(reason => !REASONS.has(reason)) ||
      !value.hardware || typeof value.hardware !== 'object' ||
      typeof value.hardware.gpuDetected !== 'boolean' ||
      typeof value.hardware.gpuAccelerationUsable !== 'boolean') {
    throw failure('invalid_capability')
  }
  let requirements = null
  if (value.requirements !== null && value.requirements !== undefined) {
    if (!value.requirements || typeof value.requirements !== 'object' ||
        !Number.isSafeInteger(value.requirements.modelBytes) || value.requirements.modelBytes < 1 ||
        !Number.isSafeInteger(value.requirements.diskRequiredBytes) ||
        value.requirements.diskRequiredBytes < value.requirements.modelBytes) {
      throw failure('invalid_capability')
    }
    requirements = Object.freeze({
      modelBytes: value.requirements.modelBytes,
      diskRequiredBytes: value.requirements.diskRequiredBytes,
    })
  }
  if ((value.localEligible && (!value.modelId || !value.acceleration || !requirements)) ||
      (!value.localEligible && value.recommendation !== 'cloud-only')) {
    throw failure('invalid_capability')
  }
  return Object.freeze({
    localEligible: value.localEligible,
    recommendation: value.recommendation,
    modelId: value.modelId ?? null,
    acceleration: value.acceleration ?? null,
    releaseReady: value.releaseReady,
    reasons: Object.freeze([...value.reasons]),
    hardware: Object.freeze({
      gpuDetected: value.hardware.gpuDetected,
      gpuAccelerationUsable: value.hardware.gpuAccelerationUsable,
    }),
    requirements,
  })
}

function createLocalAiManager({ modelStore, capabilityProbe }) {
  if (!modelStore || typeof modelStore.status !== 'function' ||
      typeof modelStore.download !== 'function' || typeof modelStore.remove !== 'function' ||
      typeof capabilityProbe !== 'function') throw failure('invalid_model_store')

  let initialized = false
  let capability = null
  let model = Object.freeze({ state: 'missing', ready: false, bytes: null })
  let phase = 'idle'
  let progress = null
  let error = null
  let controller = null
  let operation = null
  let disposed = false

  const snapshot = () => Object.freeze({
    initialized,
    phase,
    progress: progress ? Object.freeze({ ...progress }) : null,
    error,
    capability,
    model,
  })

  async function load() {
    if (disposed) throw failure('model_store_failed')
    if (initialized) return snapshot()
    if (operation) {
      await operation.catch(() => {})
      return snapshot()
    }
    phase = 'checking'
    error = null
    try {
      const nextCapability = await capabilityProbe()
      try {
        const nextModel = await modelStore.status()
        model = Object.freeze({
          state: nextModel.ready === true ? 'ready' : 'missing',
          ready: nextModel.ready === true,
          bytes: nextModel.ready === true ? nextModel.bytes : null,
        })
      } catch (caught) {
        if (safeError(caught) !== 'invalid_model') throw caught
        model = Object.freeze({ state: 'invalid', ready: false, bytes: null })
        error = 'invalid_model'
      }
      capability = publicCapability(nextCapability)
      initialized = true
    } catch (caught) {
      error = safeError(caught)
      throw caught
    } finally {
      phase = 'idle'
    }
    return snapshot()
  }

  async function startDownload() {
    await load()
    if (operation) throw failure('busy')
    if (model.state === 'invalid') throw failure('invalid_model')
    if (!capability?.localEligible) throw failure('unsupported_platform')
    if (model.ready) return snapshot()

    controller = new AbortController()
    phase = 'downloading'
    progress = null
    error = null
    const currentController = controller
    const current = (async () => {
      try {
        const result = await modelStore.download({
          signal: currentController.signal,
          progress(value) {
            if (currentController.signal.aborted) return
            progress = {
              receivedBytes: value.receivedBytes,
              totalBytes: value.totalBytes,
            }
          },
        })
        model = Object.freeze({ state: 'ready', ready: true, bytes: result.bytes })
      } catch (caught) {
        error = safeError(caught)
        if (error === 'cancelled' || error === 'timed_out') {
          try {
            const checked = await modelStore.status()
            model = Object.freeze({
              state: checked.ready === true ? 'ready' : 'missing',
              ready: checked.ready === true,
              bytes: checked.ready === true ? checked.bytes : null,
            })
          } catch {
            // Keep the bounded cancellation result; a later load/generation rechecks integrity.
          }
        }
      } finally {
        if (controller === currentController) controller = null
        progress = null
        phase = 'idle'
      }
    })()
    operation = current
    void current.finally(() => {
      if (operation === current) operation = null
    }).catch(() => {})
    return snapshot()
  }

  async function cancelDownload() {
    if (!operation || phase !== 'downloading' || !controller) return snapshot()
    controller.abort()
    await operation.catch(() => {})
    return snapshot()
  }

  async function removeModel() {
    await load()
    if (operation) throw failure('busy')
    phase = 'removing'
    error = null
    try {
      await modelStore.remove()
      model = Object.freeze({ state: 'missing', ready: false, bytes: null })
    } catch (caught) {
      error = safeError(caught)
      throw caught
    } finally {
      phase = 'idle'
    }
    return snapshot()
  }

  async function dispose() {
    disposed = true
    controller?.abort()
    await operation?.catch(() => {})
  }

  return Object.freeze({ load, status: snapshot, startDownload, cancelDownload, removeModel, dispose })
}

module.exports = { createLocalAiManager }
