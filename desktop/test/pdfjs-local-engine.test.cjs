'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLocalDocumentProcessor } = require('../src/local-document-processing.cjs')
const { createPdfJsLocalEngine } = require('../src/pdfjs-local-engine.cjs')

function pdfWithTextPages(texts) {
  const fontId = 3 + texts.length * 2
  const pageIds = texts.map((_, index) => 3 + index * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`,
  ]
  for (let index = 0; index < texts.length; index++) {
    const pageId = pageIds[index]
    const contentId = pageId + 1
    const content = `BT /F1 12 Tf 72 720 Td (${texts[index]}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let data = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(data))
    data += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(data)
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) data += `${String(offset).padStart(10, '0')} 00000 n \n`
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new Uint8Array(Buffer.from(data, 'latin1'))
}

function processor(limits) {
  return createLocalDocumentProcessor({ engine: createPdfJsLocalEngine(), ...(limits ? { limits } : {}) })
}

test('extracts selectable text locally and honors a selected-page subset', async () => {
  const bytes = pdfWithTextPages([
    'Alpha has a copper key.',
    'Beta stores maps in a glass case.',
  ])
  const result = await processor().processPdf({ bytes, filename: 'notes.pdf', selectedPages: [2] })
  assert.equal(result.processing, 'local')
  assert.equal(result.pageCount, 2)
  assert.deepEqual(result.pages.map(page => page.pageNumber), [2])
  assert.match(result.pages[0].text, /Beta stores maps in a glass case/)
  assert.equal(result.pages[0].text.includes('Alpha has a copper key'), false)
})

test('extracts every page in document order when no page subset is selected', async () => {
  const result = await processor().processPdf({ bytes: pdfWithTextPages(['First fact.', 'Second fact.']) })
  assert.deepEqual(result.pages.map(page => page.pageNumber), [1, 2])
  assert.match(result.pages[0].text, /First fact/)
  assert.match(result.pages[1].text, /Second fact/)
})

test('rejects page references outside the document and stops when the text bound is exceeded', async () => {
  const bytes = pdfWithTextPages(['A source sentence.'])
  await assert.rejects(processor().processPdf({ bytes, selectedPages: [2] }), { code: 'invalid_selection' })
  await assert.rejects(processor({ maxCharacters: 8 }).processPdf({ bytes }), { code: 'text_too_large' })
  await assert.rejects(processor({ maxPages: 1 }).processPdf({
    bytes: pdfWithTextPages(['First page.', 'Second page.']),
  }), { code: 'too_many_pages' })
})

test('uses local PDF.js resource paths and cancels the local loading task', async () => {
  let options
  let rejectLoading
  let destroyed = false
  const engine = createPdfJsLocalEngine({
    async getDocument() {
      return value => {
        options = value
        return {
          promise: new Promise((_, reject) => { rejectLoading = reject }),
          async destroy() { destroyed = true; rejectLoading(new Error('aborted')) },
        }
      }
    },
  })
  const controller = new AbortController()
  const processing = engine.processPdf({
    bytes: pdfWithTextPages(['Fact.']), selectedPages: null,
    limits: { maxPages: 100, maxCharacters: 1000 }, signal: controller.signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(processing, { code: 'cancelled' })
  assert.equal(destroyed, true)
  assert.equal(options.url, undefined)
  assert.match(options.cMapUrl, /^file:/)
  assert.match(options.standardFontDataUrl, /^file:/)
  assert.match(options.wasmUrl, /^file:/)
  assert.equal(options.useWorkerFetch, false)
  assert.equal(options.isEvalSupported, false)
})
