'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  LocalDocumentProcessingError,
  createLocalDocumentProcessor,
} = require('../src/local-document-processing.cjs')

function pdfBytes(value = '%PDF-1.7\nsynthetic PDF bytes') {
  return new Uint8Array(Buffer.from(value))
}

function page(pageNumber, text = 'A grounded source fact. '.repeat(8)) {
  return { pageNumber, text }
}

test('processes requested pages locally and returns a content fingerprint plus full source text', async () => {
  const bytes = pdfBytes()
  let request
  const processor = createLocalDocumentProcessor({
    engine: {
      async processPdf(value) {
        request = value
        return { pageCount: 3, pages: [page(1), page(3)] }
      },
    },
  })
  const result = await processor.processPdf({
    bytes,
    filename: 'folder\\study.pdf',
    selectedPages: [3, 1],
  })

  assert.notEqual(request.bytes, bytes)
  assert.deepEqual(request.selectedPages, [1, 3])
  assert.equal(result.filename, 'study.pdf')
  assert.equal(result.pdfSha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.pageCount, 3)
  assert.equal(result.selectedPageCount, 2)
  assert.equal(result.pages[0].pageNumber, 1)
  assert.equal(result.pages[0].text, page(1).text)
  assert.equal(result.processing, 'local')
  assert.equal(result.scannedLikely, false)
})

test('requires a complete ordered local result when all pages are requested', async () => {
  const processor = createLocalDocumentProcessor({
    engine: { async processPdf() { return { pageCount: 2, pages: [page(1), page(2)] } } },
  })
  const result = await processor.processPdf({ bytes: pdfBytes() })
  assert.deepEqual(result.pages.map(value => value.pageNumber), [1, 2])
  assert.equal(result.pageCount, 2)
})

test('rejects invalid files, excessive bytes, and invalid page selections before invoking the engine', async () => {
  let calls = 0
  const processor = createLocalDocumentProcessor({
    limits: { maxPages: 2 },
    engine: { async processPdf() { calls++; return { pageCount: 1, pages: [page(1)] } } },
  })

  await assert.rejects(processor.processPdf({ bytes: new Uint8Array([1, 2, 3]) }), { code: 'invalid_input' })
  const smallLimit = createLocalDocumentProcessor({
    limits: { maxPdfBytes: 20 },
    engine: { async processPdf() { calls++; return { pageCount: 1, pages: [page(1)] } } },
  })
  await assert.rejects(smallLimit.processPdf({ bytes: pdfBytes('%PDF-'.padEnd(21, 'x')) }), { code: 'input_too_large' })
  for (const selectedPages of [[], [0], [1, 1], [1, 3], [1, 2, 3]]) {
    await assert.rejects(processor.processPdf({ bytes: pdfBytes(), selectedPages }), { code: 'invalid_selection' })
  }
  assert.equal(calls, 0)
})

test('rejects malformed engine output instead of passing mismatched source pages to generation', async () => {
  for (const result of [
    null,
    { pageCount: 1, pages: [] },
    { pageCount: 1, pages: [{ pageNumber: 2, text: 'wrong page' }] },
    { pageCount: 1, pages: [{ pageNumber: 1, text: null }] },
    { pageCount: 1, pages: [{ pageNumber: 1, text: 'x'.repeat(11) }] },
  ]) {
    const processor = createLocalDocumentProcessor({
      limits: { maxCharacters: 10 },
      engine: { async processPdf() { return result } },
    })
    await assert.rejects(processor.processPdf({ bytes: pdfBytes() }), { code: 'invalid_result' })
  }
})

test('checks cancellation before and after the local engine and exposes no private error detail', async () => {
  const controller = new AbortController()
  let calls = 0
  const processor = createLocalDocumentProcessor({
    engine: {
      async processPdf() {
        calls++
        controller.abort(new Error('private path and source text'))
        return { pageCount: 1, pages: [page(1)] }
      },
    },
  })
  await assert.rejects(processor.processPdf({ bytes: pdfBytes() }, { signal: controller.signal }), error => {
    assert.equal(error.code, 'cancelled')
    assert.equal(error.message.includes('private'), false)
    return true
  })
  await assert.rejects(processor.processPdf({ bytes: pdfBytes() }, { signal: controller.signal }), { code: 'cancelled' })
  assert.equal(calls, 1)
})

test('sanitizes engine failures and reports only bounded progress metadata', async () => {
  const progress = []
  const processor = createLocalDocumentProcessor({
    engine: {
      async processPdf({ onProgress }) {
        onProgress({ phase: 'extracting', completedPages: 1, totalPages: 2, text: 'private source' })
        onProgress({ phase: 'extracting', completedPages: 4, totalPages: 2 })
        return { pageCount: 2, pages: [page(1), page(2)] }
      },
    },
  })
  await processor.processPdf({ bytes: pdfBytes() }, { onProgress: value => progress.push(value) })
  assert.deepEqual(progress, [{ phase: 'extracting', completedPages: 1, totalPages: 2 }])

  const broken = createLocalDocumentProcessor({
    engine: { async processPdf() { throw new Error('secret /private/path') } },
  })
  await assert.rejects(broken.processPdf({ bytes: pdfBytes() }), error => {
    assert.equal(error.code, 'processing_failed')
    assert.equal(error.message.includes('secret'), false)
    assert.equal(JSON.stringify(error).includes('/private/path'), false)
    return true
  })
})

test('identifies sparse OCR results without assuming server processing or silently switching providers', async () => {
  const processor = createLocalDocumentProcessor({
    engine: { async processPdf() { return { pageCount: 1, pages: [page(1, 'little text')] } } },
  })
  const result = await processor.processPdf({ bytes: pdfBytes() })
  assert.equal(result.scannedLikely, true)
  assert.match(result.warning, /local OCR/i)
  assert.equal(typeof processor.uploadPdf, 'undefined')
  assert.equal(typeof processor.generateCloud, 'undefined')
})

test('requires a local engine and bounds public errors', () => {
  assert.throws(() => createLocalDocumentProcessor(), TypeError)
  const error = new LocalDocumentProcessingError('private/path')
  assert.equal(error.code, 'processing_failed')
  assert.doesNotMatch(error.message, /private/)
})
