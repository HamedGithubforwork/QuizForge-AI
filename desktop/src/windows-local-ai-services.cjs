'use strict'

const path = require('node:path')
const { LocalAiError, createLocalQuizGenerator } = require('./local-ai.cjs')
const { createLocalRuntime } = require('./local-runtime.cjs')
const { CANDIDATE } = require('./local-model-store.cjs')
const { createWindowsLocalAiProvider } = require('./windows-local-ai-provider.cjs')
const { createWindowsLocalAiStorage } = require('./windows-local-ai-manager.cjs')

const safeFailure = (code, retryable = false) =>
  new LocalAiError(code, { retryable })

function mapUnavailableReason(status) {
  if (!status?.capability?.localEligible) return 'unsupported_platform'
  if (status.model?.state === 'invalid') return 'invalid_model'
  if (!status.model?.ready) return 'model_missing'
  return null
}

function createWindowsLocalAiServices({
  userDataDirectory,
  runtimeDirectory = null,
  rawModelStore = null,
  capabilityProbe = null,
  runtimeFactory = createLocalRuntime,
  providerFactory = createWindowsLocalAiProvider,
  generatorFactory = createLocalQuizGenerator,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (runtimeDirectory !== null &&
      (typeof runtimeDirectory !== 'string' || !path.isAbsolute(runtimeDirectory))) {
    throw new Error('Local AI runtime configuration is invalid.')
  }

  const storage = createWindowsLocalAiStorage({
    userDataDirectory,
    rawModelStore,
    capabilityProbe,
  })

  let runtime = null
  let provider = null
  let generator = null
  if (runtimeDirectory !== null) {
    runtime = runtimeFactory({
      directory: runtimeDirectory,
      modelStore: storage.rawModelStore,
      platform,
      arch,
    })
    provider = providerFactory({
      runtime,
      modelStore: storage.modelStore,
      modelId: CANDIDATE.id,
      platform,
      arch,
    })
    generator = generatorFactory({ provider })
  }

  let generationPhase = 'idle'
  let generationController = null
  let generationOperation = null
  let disposed = false

  async function readiness() {
    const status = await storage.manager.load()
    const unavailable = mapUnavailableReason(status)
    return {
      status,
      reason: unavailable ?? (runtime ? null : 'runtime_missing'),
    }
  }

  async function generationStatus() {
    const { reason } = await readiness()
    return Object.freeze({
      available: reason === null,
      busy: generationPhase !== 'idle',
      reason,
      supportedQuestionCounts: Object.freeze([5]),
      supportedQuestionTypes: Object.freeze(['multiple_choice']),
      serverPdfProcessingRequired: true,
    })
  }

  function ensureOpen() {
    if (disposed) throw safeFailure('runtime_unavailable')
  }

  async function startDownload() {
    ensureOpen()
    if (generationPhase !== 'idle') throw safeFailure('busy', true)
    return storage.manager.startDownload()
  }

  async function removeModel() {
    ensureOpen()
    if (generationPhase !== 'idle') throw safeFailure('busy', true)
    return storage.manager.removeModel()
  }

  async function generateQuiz(input) {
    ensureOpen()
    if (generationPhase !== 'idle') throw safeFailure('busy', true)
    generationPhase = 'checking'
    const controller = new AbortController()
    generationController = controller
    try {
      const { reason } = await readiness()
      controller.signal.throwIfAborted()
      if (reason !== null) {
        const code = ['invalid_model', 'model_missing', 'runtime_missing'].includes(reason)
          ? reason
          : 'unsupported_platform'
        throw safeFailure(code)
      }
      generationPhase = 'generating'
      const operation = generator.generate(input, { signal: controller.signal })
      generationOperation = operation
      return await operation
    } finally {
      generationOperation = null
      if (generationController === controller) generationController = null
      generationPhase = 'idle'
    }
  }

  async function cancelGeneration() {
    if (generationController) generationController.abort()
    await generationOperation?.catch(() => {})
    return generationStatus()
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    generationController?.abort()
    await generationOperation?.catch(() => {})
    await Promise.all([
      storage.manager.dispose(),
      runtime?.shutdown?.(),
    ])
  }

  return Object.freeze({
    load: () => storage.manager.load(),
    status: () => storage.manager.status(),
    startDownload,
    cancelDownload: () => storage.manager.cancelDownload(),
    removeModel,
    generationStatus,
    generateQuiz,
    cancelGeneration,
    dispose,
  })
}

module.exports = {
  createWindowsLocalAiServices,
}
