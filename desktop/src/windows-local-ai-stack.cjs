'use strict'

const path = require('node:path')
const { reviewQuizDistinctness } = require('./local-quiz-distinctness.cjs')
const { createLocalAnswerReview, validateRequest: validateReviewRequest } = require('./local-answer-review.cjs')
const { createLocalAiDebugReport } = require('./local-ai-debug-report.cjs')
const { randomUUID } = require('node:crypto')
const {
  LocalAiError,
  createLocalQuizService,
  createLocalDocumentQuizService,
} = require('./local-ai.cjs')
const { createLocalRuntime, verifyRuntime } = require('./local-runtime.cjs')
const { createWindowsLocalAiProvider } = require('./windows-local-ai-provider.cjs')
const { createWindowsLocalAiResources } = require('./windows-local-ai-manager.cjs')
const { createLocalOffloadPolicy } = require('./local-offload-policy.cjs')

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
  onDiagnostic = () => {},
  onQuizValidationIssue = () => {},
  onQuizGeneratedResponse = null,
} = {}) {
  const resources = createWindowsLocalAiResources({
    userDataDirectory,
    ...(modelDirectory ? { modelDirectory } : {}),
    ...(runtimeDirectory ? { runtimeDirectory } : {}),
  })
  const manager = resources.manager
  const offloadPolicy = createLocalOffloadPolicy({ userDataDirectory })
  let selectedGpuLayers = null
  let runtime = null
  let quizService = null
  let answerReview = null
  let reviewContext = null
  let contextEpoch = 0
  let documentQuizService = null
  let quizOperation = null
  let quizController = null
  let documentOperation = null
  let documentController = null
  let disposed = false
  let lastQuizValidationIssue = null
  const debugReport = createLocalAiDebugReport()
  let activeOperationId = null
  function diagnostic(event, fields = {}) {
    try { onDiagnostic(event, { operationId: activeOperationId, ...fields }) } catch {}
  }
  async function traceOperation(kind, request, operation) {
    const operationId = randomUUID()
    const ownsTrace = activeOperationId === null
    if (ownsTrace) activeOperationId = operationId
    const debugAttempt = ownsTrace && ['quiz', 'document_quiz'].includes(kind)
    if (debugAttempt) debugReport.begin({ operationId, questionCount: request?.questionCount,
      difficulty: request?.difficulty, questionType: request?.questionType })
    const started = performance.now()
    diagnostic('operation_started', { operationId, kind, questionCount: request?.questionCount,
      difficulty: request?.difficulty, questionType: request?.questionType })
    try {
      const result = await operation()
      diagnostic('operation_completed', { operationId, kind, elapsedMs: performance.now() - started,
        returnedCount: (result?.quiz ?? result)?.questions?.length })
      return result
    } catch (error) {
      diagnostic('operation_failed', { operationId, kind, elapsedMs: performance.now() - started, reason: error?.code })
      throw error
    } finally {
      if (debugAttempt) debugReport.finish()
      if (ownsTrace) activeOperationId = null
    }
  }

  function captureQuizValidationIssue(issue) {
    // Preserve only the validator's fixed reason code. Never retain quiz text,
    // source excerpts, or rejected candidate details from the diagnostic.
    if (issue && typeof issue.reason === 'string' && /^[a-z_]{1,64}$/.test(issue.reason)) {
      lastQuizValidationIssue = issue.reason
    }
    diagnostic('validation_failed', { reason: issue?.reason, attempt: issue?.attempt })
    try { onQuizValidationIssue(issue) } catch {}
  }

  if (typeof runtimeDirectory === 'string' && path.isAbsolute(runtimeDirectory)) {
    runtime = createLocalRuntime({
      directory: runtimeDirectory,
      modelStore: resources.rawModelStore,
      accelerationMode: () => selectedGpuLayers === 0
        ? 'cpu' : (manager.status()?.capability?.acceleration ?? 'cpu'),
      gpuDevice: () => manager.status()?.capability?.hardware?.gpuDevice ?? 'Vulkan0',
      gpuLayerCount: () => selectedGpuLayers ?? 99,
      gpuFallbackLayers: () => offloadPolicy.fallbackLayers(),
      onGpuStartupFailure: layers => {
        diagnostic('gpu_startup_failed', { layers })
        offloadPolicy.recordFailure(layers)
      },
      onInferenceCompleted: metric => {
        diagnostic('inference_completed', metric)
        if (metric.layers === 0 || metric.acceleration === 'gpu') {
          offloadPolicy.recordInference(metric)
        }
      },
      onDiagnostic: diagnostic,
      onProcessChange: pid => {
        diagnostic(pid === null ? 'runtime_stopped' : 'runtime_started')
        onRuntimeProcess(pid)
      },
    })
    const provider = createWindowsLocalAiProvider({
      runtime,
      modelStore: resources.modelStore,
      modelId: resources.modelId,
    })
    const generator = createLocalQuizService({ provider, onValidationIssue: captureQuizValidationIssue,
      onGeneratedResponse: onQuizGeneratedResponse,
      onRejectedQuestion: issue => {
        diagnostic('question_rejected', { reason: issue.reason, questionNumber: issue.questionNumber,
          questionType: issue.questionType, sourcePages: issue.sourcePages })
        debugReport.record(issue)
      } })
    answerReview = createLocalAnswerReview({ provider })
    quizService = { async generate(request, options) {
      reviewContext = null
      const epoch = contextEpoch
      const generated = await generator.generate(request, options)
      const quiz = await reviewQuizDistinctness({ provider, quiz: generated, pages: request.pages, signal: options?.signal })
      if (epoch !== contextEpoch) throw new LocalAiError('cancelled')
      reviewContext = { quiz, pages: request.pages.map(page => ({ ...page })) }
      return quiz
    } }
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
        questionCounts: Object.freeze([5, 10, 15]),
        questionTypes: Object.freeze(['multiple_choice', 'true_false', 'short_answer', 'mixed']),
        maxSourceBytes: 8000,
      }),
    })
  }

  async function runQuiz(operation) {
    const epoch = contextEpoch
    if (disposed) throw new LocalAiError('runtime_unavailable')
    if (quizOperation || documentOperation) throw new LocalAiError('busy', { retryable: true })
    const ready = await quizStatus()
    if (!ready.available) {
      diagnostic('availability_failed', { reason: ready.reason })
      if (ready.reason === 'model_missing') throw new LocalAiError('model_missing')
      if (ready.reason === 'invalid_model') throw new LocalAiError('invalid_model')
      if (ready.reason === 'runtime_invalid') throw new LocalAiError('runtime_invalid')
      throw new LocalAiError('runtime_unavailable', { retryable: true })
    }
    // Cache only token counts, elapsed inference time and hardware signature.
    // No PDF text, question content or model output is ever persisted.
    await offloadPolicy.prepare(manager.status()?.capability?.hardware)
    selectedGpuLayers = offloadPolicy.choose()
    const capability = manager.status()?.capability
    diagnostic('execution_selected', { layers: selectedGpuLayers, acceleration: selectedGpuLayers === 0 ? 'cpu' : capability?.acceleration,
      logicalCpuCount: capability?.hardware?.logicalCpuCount, gpuMemoryBytes: capability?.hardware?.gpuMemoryBytes,
      gpuDetected: capability?.hardware?.gpuDetected, totalMemoryBytes: capability?.hardware?.totalMemoryBytes })
    if (disposed) throw new LocalAiError('runtime_unavailable')
    if (epoch !== contextEpoch) throw new LocalAiError('cancelled')
    if (quizOperation || documentOperation) throw new LocalAiError('busy')
    quizController = new AbortController()
    const controller = quizController
    const currentOperation = Promise.resolve().then(() => operation(controller.signal))
    quizOperation = currentOperation
    try {
      return await currentOperation
    } finally {
      if (quizOperation === currentOperation) quizOperation = null
      if (quizController === controller) quizController = null
      selectedGpuLayers = null
      await offloadPolicy.flush()
    }
  }

  async function generateQuiz(request) {
    lastQuizValidationIssue = null
    return traceOperation('quiz', request, () => runQuiz(signal => quizService.generate(request, { signal })))
  }

  async function generateDocumentQuiz(request) {
    return traceOperation('document_quiz', request, () => {
      if (!documentQuizService) throw new LocalAiError('runtime_unavailable')
      lastQuizValidationIssue = null
      return runQuiz(signal => documentQuizService.generate(request, { signal }))
    })
  }

  async function processDocumentInternal(request, options) {
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

  function processDocument(request, options) {
    return traceOperation('pdf', request, () => processDocumentInternal(request, options))
  }

  async function cancelQuiz() {
    if (quizOperation || documentOperation) diagnostic('cancel_requested')
    const operation = quizOperation
    const documentTask = documentOperation
    quizController?.abort()
    documentController?.abort()
    await Promise.allSettled([operation, documentTask].filter(Boolean))
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    debugReport.clear()
    reviewContext = null
    await cancelQuiz().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await manager.dispose().catch(() => {})
  }

  return Object.freeze({
    armDetailedDebug: debugReport.arm,
    detailedDebugReport: debugReport.report,
    clearDetailedDebug: debugReport.clear,
    load: manager.load,
    status: manager.status,
    startDownload: manager.startDownload,
    cancelDownload: manager.cancelDownload,
    removeModel: manager.removeModel,
    quizStatus,
    generateQuiz,
    clearQuizReview: () => { contextEpoch++; reviewContext = null },
    reviewLocalAnswers: request => {
      validateReviewRequest(request)
      return traceOperation('answer_review', {}, () => runQuiz(signal =>
        answerReview.review(request, { ...reviewContext, signal })))
    },
    processDocument,
    generateDocumentQuiz,
    lastQuizValidationIssue: () => lastQuizValidationIssue,
    cancelQuiz,
    lastAccelerationMode: () => runtime?.lastAccelerationMode() ?? null,
    dispose,
  })
}

module.exports = { createWindowsLocalAiStack }
