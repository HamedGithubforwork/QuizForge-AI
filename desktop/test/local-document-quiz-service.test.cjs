'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { LocalAiError } = require('../src/local-ai-provider.cjs')
const {
  LocalDocumentQuizError,
  createLocalDocumentQuizService,
} = require('../src/local-document-quiz-service.cjs')

const bytes = new Uint8Array(Buffer.from('%PDF-1.7\nlocal test input'))
const hash = 'a'.repeat(64)
const quiz = Object.freeze({ title: 'Local quiz', questions: Object.freeze([]) })
const localDocument = (overrides = {}) => ({
  processing: 'local',
  pdfSha256: hash,
  pageCount: 2,
  scannedLikely: false,
  pages: [{ pageNumber: 2, text: 'A local fact supported by this page.' }],
  ...overrides,
})

function setup({ document = localDocument(), processError, quizError } = {}) {
  const calls = { process: [], generate: [] }
  const service = createLocalDocumentQuizService({
    documentProcessor: {
      async processPdf(input, options) {
        calls.process.push({ input, options })
        if (processError) throw processError
        return document
      },
    },
    quizService: {
      async generate(input, options) {
        calls.generate.push({ input, options })
        if (quizError) throw quizError
        return quiz
      },
    },
  })
  return { service, calls }
}

test('passes PDF bytes through local processing and sends only validated page text to Local AI', async () => {
  const { service, calls } = setup()
  const progress = () => {}
  const controller = new AbortController()
  const result = await service.generate({
    bytes,
    filename: 'notes.pdf',
    selectedPages: [2],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }, { signal: controller.signal, onProgress: progress })

  assert.deepEqual(calls.process[0].input, { bytes, filename: 'notes.pdf', selectedPages: [2] })
  assert.equal(calls.process[0].options.signal, controller.signal)
  assert.equal(calls.process[0].options.onProgress, progress)
  assert.deepEqual(calls.generate[0].input, {
    pages: [{ pageNumber: 2, text: 'A local fact supported by this page.' }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(calls.generate[0].options.signal, controller.signal)
  assert.deepEqual(result, {
    processing: 'local', documentSha256: hash, pageCount: 2, selectedPages: [2], quiz,
  })
  assert.equal(typeof service.uploadPdf, 'undefined')
  assert.equal(typeof service.generateCloud, 'undefined')
})

test('rejects unsupported quiz requests before reading the PDF', async () => {
  const { service, calls } = setup()
  await assert.rejects(service.generate({ bytes, difficulty: 'medium', questionCount: 4, questionType: 'multiple_choice' }),
    { code: 'invalid_request' })
  await assert.rejects(service.generate({ bytes, difficulty: 'easy', questionCount: 5, questionType: 'short_answer' }),
    { code: 'invalid_request' })
  await assert.rejects(service.generate({ bytes, difficulty: 'easy', questionCount: 5, questionType: 'multiple_choice', cloud: true }),
    { code: 'invalid_request' })
  await assert.rejects(service.generate({ bytes, selectedPages: Array.from({ length: 21 }, (_, i) => i + 1),
    difficulty: 'easy', questionCount: 5, questionType: 'multiple_choice' }), { code: 'invalid_request' })
  assert.equal(calls.process.length, 0)
})

test('never generates from scanned or invalid local processor results', async () => {
  for (const document of [
    localDocument({ scannedLikely: true }),
    localDocument({ processing: 'cloud' }),
    localDocument({ pdfSha256: 'not-a-hash' }),
    localDocument({ pages: [{ pageNumber: 3, text: 'outside the document' }] }),
    localDocument({ pages: [{ pageNumber: 2, text: '   ' }] }),
    localDocument({ pages: Array.from({ length: 21 }, (_, i) => ({ pageNumber: i + 1, text: 'page text' })) }),
  ]) {
    const { service, calls } = setup({ document })
    await assert.rejects(service.generate({ bytes, questionCount: 5, difficulty: 'hard', questionType: 'multiple_choice' }))
    assert.equal(calls.generate.length, 0)
  }
})

test('bounds source text using UTF-8 bytes before passing it to the quiz service', async () => {
  const { service, calls } = setup({
    document: localDocument({ pages: [{ pageNumber: 1, text: 'é'.repeat(4500) }] }),
  })
  await assert.rejects(service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' }),
    { code: 'source_too_large' })
  assert.equal(calls.generate.length, 0)
})

test('maps document engine failures safely and preserves only trusted Local AI errors', async () => {
  const broken = setup({ processError: new Error('private path and note text') })
  await assert.rejects(broken.service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' }), error => {
    assert.equal(error.code, 'processing_failed')
    assert.doesNotMatch(error.message, /private|note text/)
    return true
  })
  assert.equal(broken.calls.generate.length, 0)

  const oversized = setup({ processError: Object.assign(new Error('private'), { code: 'input_too_large' }) })
  await assert.rejects(oversized.service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' }),
    { code: 'document_too_large', message: 'This PDF is too large for local processing.' })

  const unexpectedQuizError = setup({ quizError: new Error('secret model path') })
  await assert.rejects(unexpectedQuizError.service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' }), error => {
    assert.equal(error.code, 'generation_failed')
    assert.doesNotMatch(error.message, /secret/)
    return true
  })

  const invalidQuiz = new LocalAiError('quiz_validation_failed')
  const generation = setup({ quizError: invalidQuiz })
  await assert.rejects(generation.service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' }),
    error => error === invalidQuiz)
})

test('checks cancellation before processing, between stages, and after generation', async () => {
  const before = setup()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(before.service.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' },
    { signal: alreadyAborted.signal }), { code: 'cancelled' })
  assert.equal(before.calls.process.length, 0)

  const controller = new AbortController()
  const cancelDuringProcessing = createLocalDocumentQuizService({
    documentProcessor: { async processPdf() { controller.abort(); return localDocument() } },
    quizService: { async generate() { assert.fail('generation should not start after cancellation') } },
  })
  await assert.rejects(cancelDuringProcessing.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' },
    { signal: controller.signal }), { code: 'cancelled' })

  const later = new AbortController()
  const cancelAfterGeneration = createLocalDocumentQuizService({
    documentProcessor: { async processPdf() { return localDocument() } },
    quizService: { async generate() { later.abort(); return quiz } },
  })
  await assert.rejects(cancelAfterGeneration.generate({ bytes, questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice' },
    { signal: later.signal }), { code: 'cancelled' })
})

test('requires both local services and exposes bounded public error codes', () => {
  assert.throws(() => createLocalDocumentQuizService(), TypeError)
  const error = new LocalDocumentQuizError('secret/path')
  assert.equal(error.code, 'processing_failed')
  assert.doesNotMatch(error.message, /secret/)
})
