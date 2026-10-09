'use strict'

const path = require('node:path')
const {
  LocalAiError,
  createLocalQuizService,
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
  onRuntimeProcess = () => {},
  onQuizValidationIssue = () => {},
} = {}) {
  const resources = createWindowsLocalAiResources({
    userDataDirectory,
    ...(modelDirectory ? { modelDirectory } : {}),
  })
  const manager = resources.manager
  let runtime = null
  let quizService = null
  let quizOperation = null
  let quizController = null
  let disposed = false

  if (typeof runtimeDirectory === 'string' && path.isAbsolute(runtimeDirectory)) {
    runtime = createLocalRuntime({
      directory: runtimeDirectory,
      modelStore: resources.rawModelStore,
      onProcessChange: onRuntimeProcess,
    })
    const provider = createWindowsLocalAiProvider({
      runtime,
      modelStore: resources.modelStore,
      modelId: resources.modelId,
    })
    quizService = createLocalQuizService({ provider, onValidationIssue: onQuizValidationIssue })
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
        busy: quizOperation !== null,
      })
    }
    if (status.model?.state === 'invalid') {
      return Object.freeze({ available: false, reason: 'invalid_model', busy: quizOperation !== null })
    }
    if (!status.model?.ready) {
      return Object.freeze({ available: false, reason: 'model_missing', busy: quizOperation !== null })
    }
    if (!quizService || !runtimeDirectory) {
      return Object.freeze({ available: false, reason: 'runtime_unavailable', busy: quizOperation !== null })
    }
    try {
      await verifyRuntime(runtimeDirectory)
    } catch (error) {
      const reason = ['invalid_runtime', 'unexpected_files', 'unsafe_directory', 'invalid_directory', 'invalid_manifest']
        .includes(error?.code) ? 'runtime_invalid' : 'runtime_unavailable'
      return Object.freeze({ available: false, reason, busy: quizOperation !== null })
    }
    return Object.freeze({
      available: true,
      reason: null,
      busy: quizOperation !== null,
      modelId: resources.modelId,
      execution: 'local',
      constraints: Object.freeze({
        questionCount: 5,
        questionType: 'multiple_choice',
        maxSourceBytes: 8000,
      }),
    })
  }

  async function generateQuiz(request) {
    if (disposed) throw new LocalAiError('runtime_unavailable')
    if (quizOperation) throw new LocalAiError('busy', { retryable: true })
    const ready = await quizStatus()
    if (!ready.available) {
      if (ready.reason === 'model_missing') throw new LocalAiError('model_missing')
      if (ready.reason === 'invalid_model') throw new LocalAiError('invalid_model')
      if (ready.reason === 'runtime_invalid') throw new LocalAiError('runtime_invalid')
      throw new LocalAiError('runtime_unavailable', { retryable: true })
    }
    quizController = new AbortController()
    const controller = quizController
    const operation = quizService.generate(request, { signal: controller.signal })
    quizOperation = operation
    try {
      return await operation
    } finally {
      if (quizOperation === operation) quizOperation = null
      if (quizController === controller) quizController = null
    }
  }

  async function cancelQuiz() {
    const operation = quizOperation
    if (!operation || !quizController) return
    quizController.abort()
    await operation.catch(() => {})
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
    cancelQuiz,
    dispose,
  })
}

module.exports = { createWindowsLocalAiStack }
