'use strict'

const path = require('node:path')
const { reviewQuizDistinctness } = require('./local-quiz-distinctness.cjs')
const { createLocalAnswerReview, validateRequest: validateReviewRequest } = require('./local-answer-review.cjs')
const { createCachedLocalDocumentProcessor } = require('./local-document-processing.cjs')
const { createLocalAiDebugReport } = require('./local-ai-debug-report.cjs')
const { MODEL_ID: EXPERIMENTAL_MODEL_ID, createExperimentalSourceGroundedQuizService } =
  require('./experimental-source-grounded-quiz.cjs')
const { filterSourceFactDuplicates } = require('./local-source-facts.cjs')
const { selectEvidencePages } = require('./local-source-selection.cjs')
const { randomUUID } = require('node:crypto')
const {
  LocalAiError,
  createLocalQuizService,
  createLocalDocumentQuizService,
} = require('./local-ai.cjs')
const { createLocalRuntime, createWarmLocalRuntime, verifyRuntime, boundedCpuThreads } = require('./local-runtime.cjs')
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

function isCompletedInferenceProfile(metric) {
  if (!metric || !Number.isSafeInteger(metric.layers) || metric.layers < 0) return false
  return metric.layers === 0 || metric.acceleration === 'gpu' || metric.acceleration === 'unknown'
}

function recordCompletedInferenceProfile(offloadPolicy, metric) {
  if (!offloadPolicy || typeof offloadPolicy.recordInference !== 'function' ||
      !isCompletedInferenceProfile(metric)) return false
  offloadPolicy.recordInference(metric)
  return true
}

function publicReason(value) {
  return QUIZ_REASONS.has(value) ? value : 'runtime_unavailable'
}

function createWindowsLocalAiStack({
  userDataDirectory,
  modelDirectory,
  runtimeDirectory,
  benchmarkModelId = null,
  experimentalSourceGroundedPdf = false,
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
    ...(benchmarkModelId ? { benchmarkModelId } : {}),
  })
  const manager = resources.manager
  const useExperimentalGrounding = experimentalSourceGroundedPdf === true &&
    benchmarkModelId === EXPERIMENTAL_MODEL_ID
  const cachedDocumentProcessor = documentProcessor
    ? createCachedLocalDocumentProcessor(documentProcessor) : null
  const offloadPolicy = createLocalOffloadPolicy({ userDataDirectory, modelSha256: resources.modelSha256 })
  let selectedGpuLayers = null
  let selectedCpuThreads = null
  let selectedContextTokens = null
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
  let quizProgressState = null
  let reviewProgressState = null
  let previousBatchMark = null
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
    runtime = createWarmLocalRuntime(createLocalRuntime({
      directory: runtimeDirectory,
      modelStore: resources.rawModelStore,
      accelerationMode: () => selectedGpuLayers === 0
        ? 'cpu' : (manager.status()?.capability?.acceleration ?? 'cpu'),
      gpuDevice: () => manager.status()?.capability?.hardware?.gpuDevice ?? 'Vulkan0',
      gpuLayerCount: () => selectedGpuLayers ?? 99,
      cpuThreadCount: () => selectedCpuThreads ?? boundedCpuThreads(),
      contextTokens: () => selectedContextTokens ?? 12288,
      gpuFallbackLayers: () => offloadPolicy.fallbackLayers(),
      onGpuStartupFailure: layers => {
        diagnostic('gpu_startup_failed', { layers })
        offloadPolicy.recordFailure(layers)
      },
      onInferenceCompleted: metric => {
        diagnostic('inference_completed', metric)
        // `layers` identifies the requested offload profile whose observed
        // throughput is being measured. Preserve completed samples even when
        // this runtime cannot confirm actual acceleration from its logs; the
        // `acceleration` field remains truthful and is not inferred here.
        recordCompletedInferenceProfile(offloadPolicy, metric)
      },
      onDiagnostic: diagnostic,
      onProcessChange: pid => {
        diagnostic(pid === null ? 'runtime_stopped' : 'runtime_started')
        onRuntimeProcess(pid)
      },
    }), {
      profile: () => [selectedGpuLayers, selectedCpuThreads, selectedContextTokens].join(':'),
      // The CPU runtime retains its existing bounded thread count until
      // measured hardware tuning can pick a faster, verified profile.
      idleMs: 3 * 60 * 1000,
    })
    const provider = createWindowsLocalAiProvider({
      runtime,
      modelStore: resources.modelStore,
      modelId: resources.modelId,
    })
    const createGenerator = activeProvider => createLocalQuizService({
      provider: activeProvider, onValidationIssue: captureQuizValidationIssue,
      onGeneratedResponse: onQuizGeneratedResponse,
      onBatchProgress: value => {
        if (!quizProgressState || quizProgressState.phase !== 'generating') return
        if (!Number.isSafeInteger(value?.completedBatches) ||
            !Number.isSafeInteger(value?.totalBatches) ||
            !Number.isSafeInteger(value?.validQuestions) ||
            value.completedBatches < 0 || value.totalBatches < 1 ||
            value.completedBatches > value.totalBatches || value.validQuestions < 0) return
        const now = performance.now()
        if (value.completedBatches === 0) previousBatchMark = now
        else if (previousBatchMark !== null) {
          diagnostic('batch_completed', {
            batchNumber: value.completedBatches,
            totalBatches: value.totalBatches,
            validQuestions: Math.min(value.validQuestions, quizProgressState.requestedQuestions),
            elapsedMs: now - previousBatchMark,
          })
          previousBatchMark = now
        }
        quizProgressState = Object.freeze({
          ...quizProgressState,
          completedBatches: value.completedBatches,
          totalBatches: value.totalBatches,
          validQuestions: Math.min(value.validQuestions, quizProgressState.requestedQuestions),
          previewQuestions: Array.isArray(value.previewQuestions)
            ? Object.freeze(value.previewQuestions.slice(0, 15).filter(q =>
                typeof q === 'string' && q.length > 0 && q.length <= 180))
            : (quizProgressState.previewQuestions ?? Object.freeze([])),
        })
      },
      onRejectedQuestion: issue => {
        diagnostic('question_rejected', { reason: issue.reason, questionNumber: issue.questionNumber,
          questionType: issue.questionType, sourcePages: issue.sourcePages })
        debugReport.record(issue)
      } })
    answerReview = createLocalAnswerReview({ provider })
    quizService = { async generate(request, options) {
      reviewContext = null
      const epoch = contextEpoch
      previousBatchMark = null
      quizProgressState = Object.freeze({
        phase: 'generating', completedBatches: 0,
        // Start with one request. Only announce multiple batches once the
        // generator confirms that the source can be partitioned safely.
        totalBatches: 1,
        validQuestions: 0,
        requestedQuestions: request?.questionCount ?? 5,
      })
      // Quiz generation, all five-item batches and the distinctness check
      // share one guarded local model process. The scoped provider cannot
      // open another session, and the model stops after this one quiz.
      const produce = async activeProvider => {
        const experimental = useExperimentalGrounding &&
          request?.questionType === 'short_answer' && request?.questionCount === 5
        // Origins are ephemeral, keyed by validated object identity. They are
        // not included in output quizzes, telemetry or persisted history.
        const questionOrigins = new Map()
        const factsByQuestion = new Map()
        let sourceFactDuplicatesRemoved = 0
        const sourceScreen = quiz => {
          const checked = filterSourceFactDuplicates(
            quiz.questions,factsByQuestion)
          sourceFactDuplicatesRemoved += checked.duplicateCount
          return { ...quiz,questions:checked.questions }
        }
        const generator = experimental
          ? createExperimentalSourceGroundedQuizService({
              provider:activeProvider,onValidationIssue:captureQuizValidationIssue,
              onProgress(progress){
                if(!quizProgressState||!['extracting_facts','generating'].includes(progress?.phase))return
                const accepted=Number.isSafeInteger(progress.acceptedQuestions)
                  ?Math.min(request.questionCount,progress.acceptedQuestions):0
                quizProgressState=Object.freeze({
                  ...quizProgressState,phase:progress.phase,
                  candidateCount:progress.candidateCount,
                  topicCount:progress.topicCount??quizProgressState.topicCount??0,
                  evaluatedCandidates:progress.evaluatedCandidates??0,
                  validQuestions:accepted,
                  modelAcceptedCount:progress.modelAcceptedCount??0,
                  repairedCount:progress.repairedCount??0,
                })
                diagnostic('generation_progress',{
                  phase:progress.phase,candidateCount:progress.candidateCount,
                  evaluatedCandidates:progress.evaluatedCandidates??0,
                  verifiedCount:accepted,repairedCount:progress.repairedCount??0,
                })
              },
              onAccepted({question,origin,fact}){
                questionOrigins.set(question,origin)
                factsByQuestion.set(question,fact)
              },
            })
          : createGenerator(activeProvider)
        const generated = await generator.generate(request, options)
        quizProgressState = Object.freeze({
          ...quizProgressState, phase: 'checking_duplicates',
          completedBatches: quizProgressState.totalBatches,
          validQuestions: generated.questions.length,
        })
        if(experimental)diagnostic('checking_duplicates',{
          proposedQuestions:generated.questions.length,
          sourceFacts:generated.generation?.candidateCount??0,
        })
        const distinctnessStarted = performance.now()
        let verified = await reviewQuizDistinctness({
          provider: activeProvider, quiz: experimental
            ? sourceScreen(generated) : generated,
          pages: request.pages, signal: options?.signal,
        })
        let replenishmentAttempted = false
        if(experimental && verified.questions.length < request.questionCount &&
            generated.generation?.candidatesEvaluated <
              generated.generation?.candidateCount &&
            !options?.signal?.aborted){
          // One bounded source-grounded refill from *unused candidate indices*
          // after semantic duplicate review. No new model session is created.
          replenishmentAttempted = true
          try{
            const extra = await generator.generate(request,{
              ...options,startAt:generated.generation.candidatesEvaluated,
              targetCount:request.questionCount-verified.questions.length,
              excludeQuestions:verified.questions.map(q=>q.question),
            })
            verified = await reviewQuizDistinctness({
              provider:activeProvider,
              quiz:sourceScreen({
                ...generated,questions:[...verified.questions,...extra.questions],
              }),
              pages:request.pages,signal:options?.signal,
            })
          }catch(error){
            if(options?.signal?.aborted||error?.code==='cancelled')throw error
            if(!['insufficient_source','quiz_validation_failed'].includes(error?.code))
              throw error
          }
        }
        if(experimental && quizProgressState)quizProgressState=Object.freeze({
          ...quizProgressState,phase:'finalizing_quiz',
          validQuestions:verified.questions.length,
        })
        diagnostic('distinctness_completed', {
          elapsedMs: performance.now() - distinctnessStarted,
          status: verified.generation?.distinctness ?? 'unavailable',
          duplicateCount: verified.generation?.duplicateCount ?? 0,
        })
        return experimental
          ? { ...verified, generation:{
              ...generated.generation,...verified.generation,
              verifiedCount:verified.questions.length,
              modelAcceptedCount:verified.questions.filter(q=>
                questionOrigins.get(q)==='model').length,
              repairedCount:verified.questions.filter(q=>
                questionOrigins.get(q)==='source_repair').length,
              replenishmentAttempted,
              sourceFactUniquenessChecked:true,
              sourceFactDuplicatesRemoved,
              semanticDuplicateReview:verified.generation?.distinctness==='checked'
                ? 'checked':'unavailable',
              partial:verified.questions.length < request.questionCount,
            } } : verified
      }
      const quiz = typeof provider.withSession === 'function'
        ? await provider.withSession(produce, { signal: options?.signal })
        : await produce(provider)
      if (epoch !== contextEpoch) throw new LocalAiError('cancelled')
      reviewContext = { quiz, pages: request.pages.map(page => ({ ...page })) }
      return quiz
    } }
    if (cachedDocumentProcessor) {
      documentQuizService = createLocalDocumentQuizService({
        documentProcessor: cachedDocumentProcessor, quizService,
        sourceSelector: useExperimentalGrounding ? selectEvidencePages : null,
        onSourceSelected(meta){
          if(!useExperimentalGrounding)return
          diagnostic('source_selected',{
            trimmed:meta.trimmed,originalBytes:meta.originalBytes,
            selectedBytes:meta.selectedBytes,
            originalPages:meta.originalPages,selectedPages:meta.selectedPages,
          })
          if(quizProgressState)quizProgressState=Object.freeze({
            ...quizProgressState,phase:'selecting_source',
            originalSourceBytes:meta.originalBytes,
            selectedSourceBytes:meta.selectedBytes,
            selectedPages:meta.selectedPages,
          })
        },
      })
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
      experimentalSourceGroundedPdf: useExperimentalGrounding,
      modelId: resources.modelId,
      execution: 'local',
      constraints: Object.freeze({
        questionCounts: Object.freeze([5, 10, 15]),
        questionTypes: Object.freeze(['multiple_choice', 'true_false', 'short_answer', 'mixed']),
        maxSourceBytes: 8000,
      }),
    })
  }

  async function runQuiz(operation, request = null) {
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
    selectedCpuThreads = selectedGpuLayers === 0 ? offloadPolicy.chooseThreads() : boundedCpuThreads()
    // A compact context is sufficient for short five-question sources;
    // retain the larger context for hard/multi-batch and document requests.
    const sourceLength = Array.isArray(request?.pages)
      ? request.pages.reduce((sum, p) => sum + (p?.text?.length ?? 0), 0) : Infinity
    selectedContextTokens = request?.questionCount === 5 && sourceLength <= 3000
      ? 8192 : 12288
    const capability = manager.status()?.capability
    diagnostic('execution_selected', { layers: selectedGpuLayers, acceleration: selectedGpuLayers === 0 ? 'cpu' : capability?.acceleration,
      logicalCpuCount: capability?.hardware?.logicalCpuCount, selectedCpuThreads, gpuMemoryBytes: capability?.hardware?.gpuMemoryBytes,
      gpuDetected: capability?.hardware?.gpuDetected, totalMemoryBytes: capability?.hardware?.totalMemoryBytes,
      selectedContextTokens })
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
      quizProgressState = null
      reviewProgressState = null
      selectedGpuLayers = null
      selectedCpuThreads = null
      selectedContextTokens = null
      await offloadPolicy.flush()
    }
  }

  async function generateQuiz(request) {
    lastQuizValidationIssue = null
    return traceOperation('quiz', request, () => runQuiz(signal => quizService.generate(request, { signal }), request))
  }

  async function generateDocumentQuiz(request) {
    return traceOperation('document_quiz', request, () => {
      if (!documentQuizService) throw new LocalAiError('runtime_unavailable')
      lastQuizValidationIssue = null
      return runQuiz(signal => {
        if(useExperimentalGrounding)quizProgressState=Object.freeze({
          phase:'extracting_pdf',completedPages:0,totalPages:0,
          validQuestions:0,requestedQuestions:request.questionCount,
        })
        return documentQuizService.generate(request,{
          signal,onProgress:progress=>{
            if(!useExperimentalGrounding||!quizProgressState)return
            quizProgressState=Object.freeze({
              ...quizProgressState,phase:'extracting_pdf',
              pdfPhase:progress.phase,completedPages:progress.completedPages,
              totalPages:progress.totalPages,
            })
            diagnostic('pdf_extraction_progress',{
              phase:progress.phase,completedPages:progress.completedPages,
              totalPages:progress.totalPages,
            })
          },
        })
      },request)
    })
  }

  async function processDocumentInternal(request, options) {
    if (disposed || !cachedDocumentProcessor) throw new LocalAiError('runtime_unavailable')
    if (quizOperation || documentOperation) throw new LocalAiError('busy', { retryable: true })
    const controller = new AbortController()
    documentController = controller
    const currentOperation = Promise.resolve().then(() => cachedDocumentProcessor.processPdf(request, { ...options, signal: controller.signal }))
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
    documentQuizService?.clearCache?.()
    cachedDocumentProcessor?.clearCache?.()
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
    quizProgress: () => quizOperation && quizProgressState
      ? Object.freeze({ ...quizProgressState }) : null,
    reviewProgress: () => quizOperation && reviewProgressState
      ? Object.freeze({ total: reviewProgressState.total,
          decisions: [...reviewProgressState.decisions] }) : null,
    generateQuiz,
    clearQuizReview: () => { contextEpoch++; reviewContext = null; reviewProgressState = null; documentQuizService?.clearCache?.(); cachedDocumentProcessor?.clearCache?.(); void runtime?.cooldown?.().catch(() => {}) },
    reviewLocalAnswers: request => {
      validateReviewRequest(request)
      // Local grading requires the exact quiz and source from this process.
      // An old/history/cloud quiz or an account reset cannot be reviewed with
      // a missing source. Report that explicitly, rather than booting Qwen
      // only to give a generic unavailable/uncertain result.
      if (!reviewContext?.quiz || !Array.isArray(reviewContext.pages)) {
        diagnostic('answer_review_failed', { reason: 'review_context_missing' })
        throw new LocalAiError('review_context_missing')
      }
      return traceOperation('answer_review', {}, () => runQuiz(async signal => {
        reviewProgressState = { total: request.cases.length, decisions: [] }
        const context = { ...reviewContext, signal, onDecision: decision => {
          if (!reviewProgressState || signal.aborted) return
          if (request.cases.some(c => c.question_index === decision.question_index) &&
              !reviewProgressState.decisions.some(d => d.question_index === decision.question_index)) {
            reviewProgressState.decisions.push(decision)
          }
        } }
        // One short-answer submission may contain several answers. Avoid
        // reloading Qwen between each answer, but still release it when the
        // review finishes or is cancelled.
        try {
          if (request.cases.length > 1 && typeof provider.withSession === 'function') {
            return await provider.withSession(scopedProvider =>
              createLocalAnswerReview({ provider: scopedProvider }).review(request, context), { signal })
          }
          return await answerReview.review(request, context)
        } catch (error) {
          // If the model crashes between answers, preserve only decisions
          // already validated and published by the grader. Unreviewed answers
          // are explicitly uncertain; nothing is sent to a cloud provider.
          const completed = reviewProgressState?.decisions ?? []
          if (signal.aborted || completed.length === 0) throw error
          diagnostic('answer_review_partial_recovered', {
            completedCount: completed.length, requestedCount: request.cases.length,
            reason: typeof error?.code === 'string' ? error.code : 'review_unavailable',
          })
          return { decisions: request.cases.map(c =>
            completed.find(d => d.question_index === c.question_index) ?? {
              question_index: c.question_index, verdict: 'uncertain',
              confidence: 0, engine: 'local', credit: null, concepts: [],
              reason: 'Local AI stopped before reviewing this answer. Retry the review or check the source.',
            }) }
        }
      }, { questionCount: 5, pages: reviewContext.pages }))
    },
    processDocument,
    generateDocumentQuiz,
    lastQuizValidationIssue: () => lastQuizValidationIssue,
    cancelQuiz,
    lastAccelerationMode: () => runtime?.lastAccelerationMode() ?? null,
    dispose,
  })
}

module.exports = {
  createWindowsLocalAiStack,
  isCompletedInferenceProfile,
  recordCompletedInferenceProfile,
}
