'use strict'

// CI-only real PDF.js-to-Windows-Local-AI acceptance. The PDF is generated from
// fixed synthetic text, never from a private user upload.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
const { createPdfJsLocalEngine } = require('../src/pdfjs-local-engine.cjs')
const { createLocalDocumentProcessor } = require('../src/local-document-processing.cjs')
const { FIXTURES, validateSemanticQuiz } = require('./verify-local-product-acceptance.cjs')

function pdfWithTextPages(texts) {
  // Minimal valid text-layer PDF, using ASCII-only fixed synthetic facts.
  const fontId = 3 + texts.length * 2
  const pageIds = texts.map((_, i) => 3 + i * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') +
      '] /Count ' + texts.length + ' >>',
  ]
  for (let i = 0; i < texts.length; i++) {
    const content = 'BT /F1 11 Tf 48 750 Td (' +
      texts[i].replace(/[\\()]/g, c => '\\' + c) + ') Tj ET'
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ' +
      '<< /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + (pageIds[i] + 1) + ' 0 R >>',
      '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' +
      content + '\nendstream',
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n'
  }
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  if (![process.argv[2], process.argv[3], process.argv[4]].every(Boolean)) {
    throw new Error('Usage: node verify-local-pdf-native-stack.cjs RUNTIME MODEL REPORT')
  }
  const fixture = FIXTURES.find(item => item.id === 'selected_pages')
  assert.ok(fixture)
  const bytes = pdfWithTextPages([
    'Unused page: decoyium and page three must not be tested.',
    fixture.selectedPages[0].text,
    'Unused page three: all objects are painted gold, but this page was not selected.',
    fixture.selectedPages[1].text,
  ])
  const userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-pdf-native-'))
  const report = { schema: 1, fixture: fixture.id, outcome: 'running',
    stage: 'initializing', errorCode: null, extractedPages: [], questionCount: 0,
    validationReason: null }
  let stack
  try {
    // No cloud extraction is allowed: PDF.js and Qwen both run locally.
    stack = createWindowsLocalAiStack({
      userDataDirectory,
      runtimeDirectory: path.resolve(process.argv[2]),
      modelDirectory: path.resolve(process.argv[3]),
      documentProcessor: createLocalDocumentProcessor({ engine: createPdfJsLocalEngine() }),
      onQuizValidationIssue(issue) {
        if (typeof issue?.reason === 'string' && /^[a-z_]{1,64}$/.test(issue.reason)) {
          report.validationReason = issue.reason
        }
      },
    })
    report.stage = 'extracting_real_pdf_bytes'
    const extracted = await stack.processDocument({
      bytes, filename: 'synthetic-reference.pdf', selectedPages: [2, 4],
    })
    report.extractedPages = extracted.pages.map(page => page.pageNumber)
    assert.deepEqual(report.extractedPages, [2, 4])
    assert.equal(extracted.scannedLikely, false)
    assert.match(extracted.pages[0].text, /Aster casing material is cobalt/)
    assert.match(extracted.pages[1].text, /Boreal casing material is glass/)
    assert.equal(extracted.pages.some(page => /decoyium|painted gold/i.test(page.text)), false)
    report.stage = 'generating_5_source_grounded_questions'
    const result = await stack.generateDocumentQuiz({
      bytes, filename: 'synthetic-reference.pdf', selectedPages: [2, 4],
      questionCount: 5, difficulty: fixture.difficulty, questionType: 'multiple_choice',
    })
    assert.equal(result.processing, 'local')
    assert.deepEqual(result.selectedPages, [2, 4])
    report.questionCount = result.quiz.questions.length
    report.stage = 'validating_factual_accuracy_uniqueness'
    validateSemanticQuiz(result.quiz, fixture)
    report.outcome = 'pass'
    report.stage = 'complete'
    console.log('PASS: real PDF.js extraction -> Windows Qwen -> five distinct grounded quiz questions')
  } catch (error) {
    report.outcome = 'failed'
    report.errorCode = typeof error?.code === 'string' &&
      /^[a-z_]{1,64}$/.test(error.code) ? error.code
      : error?.name === 'AssertionError' ? 'semantic_assertion_failed' : 'unclassified'
    console.error('Real PDF-to-local-quiz failed at', report.stage, report.errorCode)
    throw error
  } finally {
    await fs.writeFile(path.resolve(process.argv[4]), JSON.stringify(report, null, 2) + '\n')
    await stack?.dispose().catch(() => {})
    await fs.rm(userDataDirectory, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('PDF acceptance failed:', error?.code || error?.message || 'unknown')
    process.exitCode = 1
  })
}
module.exports = { pdfWithTextPages }
