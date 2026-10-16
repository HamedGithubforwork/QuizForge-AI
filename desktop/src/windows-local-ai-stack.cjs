'use strict'

const path = require('node:path')
const {
  LocalAiError,
  createLocalQuizService,
  createLocalDocumentQuizService,
} = require('./local-ai.cjs')
const { createLocalRuntime, verifyRuntime } = require('./local-runtime.cjs')
const { createWindowsLocalAiProvider } = require('./windows-local-ai-provider.cjs')
const { createWindowsLocalAiResources } = require('./windows-local-ai-manager.cjs')

const QUIZ_REASONS = new Set([
  'unsupported_platform',
  'insufficient_memory',
  'insufficient_disk',
  'runtime_acceleration_unavailable',
  'no_eligible_local_profile',
  'model_missing',
  'invalid_model',
  'runtime_invalid',
  'runtime_unavailable',
])

function publicReason(value) {
  return QUIZ_REASONS.has(value) ? value : 'runtime_unavailable'
}

function createWindowsLocalAiStack({
  userDataDirectory,
  modelDirectory,
  runtimeDirectory,
  documentProcessor = null,
  onRuntimeProcess = () => {},
  onQuizValidationIssue = () => {},
} = {}) {
  const resources = createWindowsLocalAiResources({
    userDataDirectory,
    ...(modelDirectory ? { modelDirectory } : {}),
    ...(runtimeDirectory ? { runtimeDirectory } : {}),
  })
  const manager = resources.manager
  let runtime = null
  let quizService = null
  let documentQuizService = null
  let quizOperation = null
  let quizController = null
  let documentOperation = null
  let documentController = null
  let disposed = false

  if (typeof runtimeDirectory === 'string' && path.isAbsolute(runtimeDirectory)) {
    runtime = createLocalRuntime({
      directory: runtimeDirectory,
      modelStore: resources.rawModelStore,
      accelerationMode: () => manager.status()?.capability?.acceleration ?? 'cpu',
      gpuDevice: () => manager.status()?.capability?.hardware?.gpuDevice ?? 'Vulkan0',
      onProcessChange: onRuntimeProcess,
    })
    const provider = createWindowsLocalAiProvider({
      runtime,
      modelStore: resources.modelStore,
      modelId: resources.modelId,
    })
    quizService = createLocalQuizService({ provider, onValidationIssue: onQuizValidationIssue })
    if (documentProcessor) {
      documentQuizService = createLocalDocumentQuizService({ documentProcessor, quizService })
    }
  }

  async function quizStatus() {
    if (disposed) {
      return Object.freeze({ available: false, reason: 'runtime_unavailable', busy: false })
    }
    let status
    try {
      status = await manager.load()
    } catch {
      return Object.freeze({ available: false, reason: 'runtime_unavailable', busy: false })
    }
    if (!status.capability?.localEligible) {
      return Object.freeze({
        available: false,
        reason: publicReason(status.capability?.reasons?.[0] ?? 'unsupported_platform'),
        busy: quizOperation !== null || documentOperation !== null,
      })
    }
    if (status.model?.state === 'invalid') {
      return Object.freeze({ available: false, reason: 'invalid_model', busy: quizOperation !== null || documentOperation !== null })
    }
    if (!status.model?.ready) {
      return Object.freeze({ available: false, reason: 'model_missing', busy: quizOperation !== null || documentOperation !== null })
    }
    if (!quizService || !runtimeDirectory) {
      return Object.freeze({ available: false, reason: 'runtime_unavailable', busy: quizOperation !== null || documentOperation !== null })
    }
    try {
      await verifyRuntime(runtimeDirectory)
    } catch (error) {
      const reason = ['invalid_runtime', 'unexpected_files', 'unsafe_directory', 'invalid_directory', 'invalid_manifest']
        .includes(error?.code) ? 'runtime_invalid' : 'runtime_unavailable'
      return Object.freeze({ available: false, reason, busy: quizOperation !== null || documentOperation !== null })
    }
    return Object.freeze({
      available: true,
      reason: null,
      busy: quizOperation !== null || documentOperation !== null,
      modelId: resources.modelId,
      execution: 'local',
      constraints: Object.freeze({
        questionCount: 5,
        questionType: 'multiple_choice',
        maxSourceBytes: 8000,
      }),
    })
  }

  async function runQuiz(operation) {
    if (disposed) throw new LocalAiError('runtime_unavailable')
    if (quizOperation || documentOperation) throw new LocalAiError('busy', { retryable: true })
    const ready = await quizStatus()
    if (!ready.available) {
      if (ready.reason === 'model_missing') throw new LocalAiError('model_missing')
      if (ready.reason === 'invalid_model') throw new LocalAiError('invalid_model')
      if (ready.reason === 'runtime_invalid') throw new LocalAiError('runtime_invalid')
      throw new LocalAiError('runtime_unavailable', { retryable: true })
    }
    quizController = new AbortController()
    const controller = quizController
    const currentOperation = Promise.resolve().then(() => operation(controller.signal))
    quizOperation = currentOperation
    try {
      return await currentOperation
    } finally {
      if (quizOperation === currentOperation) quizOperation = null
      if (quizController === controller) quizController = null
    }
  }

  async function generateQuiz(request) {
    return runQuiz(signal => quizService.generate(request, { signal }))
  }

  async function generateDocumentQuiz(request) {
    if (!documentQuizService) throw new LocalAiError('runtime_unavailable')
    return runQuiz(signal => documentQuizService.generate(request, { signal }))
  }

  async function processDocument(request, options) {
    if (disposed || !documentProcessor) throw new LocalAiError('runtime_unavailable')
    if (quizOperation || documentOperation) throw new LocalAiError('busy', { retryable: true })
    const controller = new AbortController()
    documentController = controller
    const currentOperation = Promise.resolve().then(() => documentProcessor.processPdf(request, { ...options, signal: controller.signal }))
    documentOperation = currentOperation
    try {
      return await currentOperation
    } finally {
      if (documentOperation === currentOperation) documentOperation = null
      if (documentController === controller) documentController = null
    }
  }

  async function cancelQuiz() {
    const operation = quizOperation
    const documentTask = documentOperation
    quizController?.abort()
    documentController?.abort()
    await Promise.allSettled([operation, documentTask].filter(Boolean))
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    await cancelQuiz().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await manager.dispose().catch(() => {})
  }

  return Object.freeze({
    load: manager.load,
    status: manager.status,
    startDownload: manager.startDownload,
    cancelDownload: manager.cancelDownload,
    removeModel: manager.removeModel,
    quizStatus,
    generateQuiz,
    processDocument,
    generateDocumentQuiz,
    cancelQuiz,
    lastAccelerationMode: () => runtime?.lastAccelerationMode() ?? null,
    dispose,
  })
}

module.exports = { createWindowsLocalAiStack }
