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


function publicModelMetadata(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_model_store')
  const fields = ['id', 'displayName', 'repository', 'license']
  if (Object.keys(value).some(key => !fields.includes(key)) ||
      typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(value.id) ||
      typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 120 ||
      typeof value.repository !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.repository) ||
      typeof value.license !== 'string' || !/^[A-Za-z0-9.+-]{2,64}$/.test(value.license)) {
    throw failure('invalid_model_store')
  }
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    repository: value.repository,
    license: value.license,
  })
}

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

function createLocalAiManager({ modelStore, capabilityProbe, modelMetadata = null }) {
  if (!modelStore || typeof modelStore.status !== 'function' ||
      typeof modelStore.download !== 'function' || typeof modelStore.remove !== 'function' ||
      typeof capabilityProbe !== 'function') throw failure('invalid_model_store')

  const metadata = publicModelMetadata(modelMetadata)
  const modelState = (state, ready, bytes) => Object.freeze({
    state,
    ready,
    bytes,
    metadata,
  })

  let initialized = false
  let capability = null
  let model = modelState('missing', false, null)
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
        model = modelState(
          nextModel.ready === true ? 'ready' : 'missing',
          nextModel.ready === true,
          nextModel.ready === true ? nextModel.bytes : null,
        )
      } catch (caught) {
        if (safeError(caught) !== 'invalid_model') throw caught
        model = modelState('invalid', false, null)
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
        model = modelState('ready', true, result.bytes)
      } catch (caught) {
        error = safeError(caught)
        if (error === 'cancelled' || error === 'timed_out') {
          try {
            const checked = await modelStore.status()
            model = modelState(
              checked.ready === true ? 'ready' : 'missing',
              checked.ready === true,
              checked.ready === true ? checked.bytes : null,
            )
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
      model = modelState('missing', false, null)
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
