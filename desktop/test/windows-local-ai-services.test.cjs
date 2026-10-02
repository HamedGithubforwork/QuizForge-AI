'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LocalAiError } = require('../src/local-ai.cjs')
const { createWindowsLocalAiServices } = require('../src/windows-local-ai-services.cjs')

const GIB = 1024 ** 3

function capability(overrides = {}) {
  return {
    localEligible: true,
    recommendation: 'enhanced-local-preview',
    modelId: 'qwen3-4b-q4-k-m',
    acceleration: 'cpu',
    releaseReady: false,
    reasons: [],
    hardware: {
      platform: 'win32',
      arch: 'x64',
      totalMemoryBytes: 16 * GIB,
      availableDiskBytes: 20 * GIB,
      logicalCpuCount: 8,
      gpuDetected: false,
      gpuDetection: 'none',
      gpuAccelerationUsable: false,
    },
    requirements: {
      modelBytes: 2497280256,
      reserveDiskBytes: 512 * 1024 ** 2,
      diskRequiredBytes: 2497280256 + 512 * 1024 ** 2,
      minMemoryBytes: 8 * GIB,
    },
    ...overrides,
  }
}

function rawStore({ ready = true } = {}) {
  let installed = ready
  return {
    async status({ signal } = {}) {
      signal?.throwIfAborted()
      return installed
        ? { ready: true, bytes: 2497280256, path: '/models/model.gguf' }
        : { ready: false }
    },
    async download() {
      installed = true
      return { ready: true, bytes: 2497280256, path: '/models/model.gguf' }
    },
    async remove() { installed = false },
  }
}

function localInput() {
  return {
    pages: [
      { pageNumber: 1, text: 'Alpha opened in 2042. Its director is Mira Sen. Alpha has three telescopes.' },
      { pageNumber: 2, text: 'Blue measures heat. Red measures distance. Green measures pressure.' },
    ],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
    focusPages: [],
    avoidQuestions: [],
  }
}

function quizJson() {
  return JSON.stringify({
    title: 'Alpha facts',
    questions: Array.from({ length: 5 }, (_, index) => ({
      question_type: 'multiple_choice',
      question: 'Question ' + (index + 1) + '?',
      choices: ['Correct ' + index, 'Wrong A ' + index, 'Wrong B ' + index, 'Wrong C ' + index],
      correct_index: 0,
      explanation: 'Supported explanation ' + index,
      source_pages: [index % 2 + 1],
    })),
  })
}

function runtimeFactory({ pending = false } = {}) {
  let shutdownCalls = 0
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const factory = () => ({
    async complete(payload, { signal } = {}) {
      assert.equal(payload.temperature, 0.7)
      assert.equal(payload.chat_template_kwargs.enable_thinking, false)
      assert.equal(payload.json_schema.type, 'object')
      if (pending) {
        entered()
        await new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('cancelled', 'AbortError'))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return {
        choices: [{
          message: { content: quizJson() },
          finish_reason: 'stop',
        }],
      }
    },
    async shutdown() { shutdownCalls++ },
  })
  return {
    factory,
    started,
    shutdownCalls: () => shutdownCalls,
  }
}

test('generation status distinguishes missing runtime from missing model', async () => {
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore({ ready: true }),
    capabilityProbe: async () => capability(),
    runtimeDirectory: null,
    platform: 'win32',
    arch: 'x64',
  })
  assert.deepEqual(await service.generationStatus(), {
    available: false,
    busy: false,
    reason: 'runtime_missing',
    supportedQuestionCounts: [5],
    supportedQuestionTypes: ['multiple_choice'],
    serverPdfProcessingRequired: true,
  })
  await assert.rejects(service.generateQuiz(localInput()), { code: 'runtime_missing' })
  await service.dispose()

  const missingModel = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore({ ready: false }),
    capabilityProbe: async () => capability(),
    runtimeDirectory: '/runtime',
    runtimeFactory: runtimeFactory().factory,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal((await missingModel.generationStatus()).reason, 'model_missing')
  await assert.rejects(missingModel.generateQuiz(localInput()), { code: 'model_missing' })
  await missingModel.dispose()
})

test('service produces the existing quiz wire shape through the structured Windows provider', async () => {
  const runtime = runtimeFactory()
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore(),
    capabilityProbe: async () => capability(),
    runtimeDirectory: '/runtime',
    runtimeFactory: runtime.factory,
    platform: 'win32',
    arch: 'x64',
  })
  const status = await service.generationStatus()
  assert.equal(status.available, true)
  assert.equal(status.serverPdfProcessingRequired, true)
  const quiz = await service.generateQuiz(localInput())
  assert.equal(quiz.questions.length, 5)
  assert.equal(quiz.questions[0].correct_answer, 'Correct 0')
  assert.equal(quiz.questions[0].grading.grading_version, 2)
  assert.equal((await service.generationStatus()).busy, false)
  await service.dispose()
  assert.equal(runtime.shutdownCalls(), 1)
})

test('active generation blocks model mutation and explicit cancellation propagates', async () => {
  const runtime = runtimeFactory({ pending: true })
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore(),
    capabilityProbe: async () => capability(),
    runtimeDirectory: '/runtime',
    runtimeFactory: runtime.factory,
    platform: 'win32',
    arch: 'x64',
  })
  const generation = service.generateQuiz(localInput())
  generation.catch(() => {})
  await runtime.started
  assert.equal((await service.generationStatus()).busy, true)
  await assert.rejects(service.startDownload(), { code: 'busy' })
  await assert.rejects(service.removeModel(), { code: 'busy' })
  const cancelled = await service.cancelGeneration()
  assert.equal(cancelled.busy, false)
  await assert.rejects(generation, { code: 'cancelled' })
  await service.dispose()
})

test('hardware ineligibility prevents generation even when model/runtime exist', async () => {
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore(),
    capabilityProbe: async () => capability({
      localEligible: false,
      recommendation: 'cloud-only',
      modelId: null,
      acceleration: null,
      reasons: ['insufficient_memory'],
      requirements: null,
    }),
    runtimeDirectory: '/runtime',
    runtimeFactory: runtimeFactory().factory,
    platform: 'win32',
    arch: 'x64',
  })
  const status = await service.generationStatus()
  assert.equal(status.available, false)
  assert.equal(status.reason, 'insufficient_memory')
  await assert.rejects(service.generateQuiz(localInput()), { code: 'unsupported_platform' })
  await service.dispose()
})

test('dispose aborts generation and is idempotent', async () => {
  const runtime = runtimeFactory({ pending: true })
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore(),
    capabilityProbe: async () => capability(),
    runtimeDirectory: '/runtime',
    runtimeFactory: runtime.factory,
    platform: 'win32',
    arch: 'x64',
  })
  const generation = service.generateQuiz(localInput())
  generation.catch(() => {})
  await runtime.started
  await service.dispose()
  await assert.rejects(generation, { code: 'cancelled' })
  assert.equal(runtime.shutdownCalls(), 1)
  await service.dispose()
  await assert.rejects(service.generateQuiz(localInput()), { code: 'runtime_unavailable' })
})

test('service refuses unsafe runtime paths before constructing native runtime', () => {
  assert.throws(() => createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: rawStore(),
    capabilityProbe: async () => capability(),
    runtimeDirectory: 'relative/runtime',
  }))
})

test('model-store adapter failures remain bounded through service operations', async () => {
  const broken = rawStore({ ready: false })
  broken.download = async () => { throw Object.assign(new Error('/private/path secret'), { code: 'invalid_download' }) }
  const service = createWindowsLocalAiServices({
    userDataDirectory: '/profile',
    rawModelStore: broken,
    capabilityProbe: async () => capability(),
  })
  await service.load()
  await assert.rejects(service.startDownload(), error => {
    assert.ok(error instanceof LocalAiError)
    assert.equal(error.code, 'invalid_download')
    assert.equal(String(error).includes('/private/path'), false)
    return true
  })
  await service.dispose()
})
