// A packaged-Electron UI smoke test. Only the native IPC responses are
// replaced inside this short-lived test process; no authentication bypass,
// mock model, or test flag is shipped in the product.
import { _electron, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const exe = path.resolve(process.argv[2] || '')
if (!fs.existsSync(exe)) throw new Error('Packaged preview executable not found: ' + exe)
const fixture = JSON.parse(fs.readFileSync(
  path.resolve('desktop/test/fixtures/biology-study-notes.json'), 'utf8'))

const answers = [
  ['Which organelle stores most DNA?', ['Ribosome','Nucleus','Cell wall','Mitochondrion'], 1],
  ['What process uses light to make glucose?', ['Respiration','Diffusion','Photosynthesis','Osmosis'], 2],
  ['What is the function of ribosomes?', ['Protein synthesis','Water transport','DNA storage','Lipid digestion'], 0],
  ['What molecule carries genetic information?', ['ATP','Glucose','Oxygen','DNA'], 3],
  ['Which process needs energy to move against a concentration gradient?', ['Diffusion','Osmosis','Active transport','Evaporation'], 2],
]
const quiz = {
  title: 'Packaged Local AI UI output acceptance',
  questions: answers.map(([question, choices, correct_index], i) => ({
    question_type: 'multiple_choice',
    question,
    choices,
    correct_index,
    correct_answer: choices[correct_index],
    accepted_answers: [choices[correct_index]],
    explanation: 'Synthetic source-backed test answer.',
    source_pages: [fixture.pages[i % fixture.pages.length].pageNumber],
  })),
}

function pdfBytes() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  ]
  const body = 'BT /F1 12 Tf 36 740 Td (Synthetic biology notes for Windows UI acceptance) Tj ET'
  objects.push('<< /Length ' + Buffer.byteLength(body) + ' >>\nstream\n' + body + '\nendstream')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n'
  }
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n'
  return Buffer.from(pdf + 'trailer\n<< /Size ' + (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}

const errors = []
let electron
try {
  electron = await _electron.launch({ executablePath: exe, args: [], timeout: 90000 })
  const page = await electron.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await electron.evaluate(({ ipcMain }, { fixture, quiz }) => {
    const calls = { pdf: 0, generated: 0 }
    globalThis.__qfnOutputE2e = calls
    const account = { userId: 'e2e-only-local-account', email: 'ui-test@example.test', enrolled: true }
    function register(name, handler) {
      const channel = 'qfn:' + name
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => handler(...args))
    }
    const response = value => ({ status: 200, body: JSON.stringify(value), contentType: 'application/json' })
    register('status', () => ({ available: true, account }))
    register('request', request => {
      if (request.path === '/api/documents/jobs') return response({ jobs: [] })
      if (request.path.startsWith('/api/quiz-history')) return response({ items: [], next_cursor: null })
      if (request.path === '/api/decks') return response([])
      return response({})
    })
    register('localAiStatus', () => ({ model: { ready: true } }))
    register('localAiQuizStatus', () => ({
      available: true, reason: null, busy: false, modelId: 'qwen3-4b-q4-k-m', execution: 'local',
      constraints: { questionCounts: [5,10,15],
        questionTypes: ['multiple_choice','true_false','short_answer','mixed'], maxSourceBytes: 8000 },
    }))
    register('processLocalPdf', request => {
      calls.pdf++
      if (!request?.bytes || request.bytes.byteLength < 8) return { ok: false, error: 'invalid_input' }
      return { ok: true, document: {
        filename: request.filename, pdfSha256: fixture.pdfSha256,
        pageCount: fixture.pages.length, characterCount: fixture.characterCount,
        extractablePageCount: fixture.pages.length, scannedLikely: false,
        warning: null, pages: fixture.pages,
      } }
    })
    register('generateLocalAiQuiz', request => {
      calls.generated++
      if (request.questionCount !== 5 || request.difficulty !== 'easy' ||
          request.questionType !== 'multiple_choice' ||
          JSON.stringify(request.pages) !== JSON.stringify(fixture.pages)) {
        return { ok: false, error: 'invalid_request' }
      }
      return { ok: true, quiz }
    })
    register('cancelLocalAiQuiz', () => {})
    register('loadSourcePageText', () => '')
  }, { fixture, quiz })

  await page.reload()
  await expect(page.getByText('Signed in as ui-test@example.test')).toBeVisible({ timeout: 20000 })
  await page.getByLabel('Study material PDF').setInputFiles({
    name: 'synthetic-biology-test.pdf', mimeType: 'application/pdf', buffer: pdfBytes(),
  })
  await page.getByRole('button', { name: 'Process PDF on this computer' }).click()
  await expect(page.getByRole('heading', { name: 'Quiz settings' })).toBeVisible()
  await expect(page.getByLabel('Generation engine')).toHaveValue('local')
  await page.getByLabel('Difficulty').selectOption('easy')
  await page.getByRole('button', { name: 'Generate Locally' }).click()
  await expect(page.locator('.question-card')).toHaveCount(5, { timeout: 20000 })
  for (const [index, item] of quiz.questions.entries()) {
    const card = page.locator('.question-card').nth(index)
    await expect(card.locator('h3')).toHaveText(item.question)
    await expect(card.locator('input[type=radio]')).toHaveCount(4)
    await card.locator('input[type=radio]').nth(item.correct_index).check()
  }
  await page.getByRole('button', { name: 'Check Answers' }).click()
  await expect(page.locator('#quiz-results')).toContainText('5 / 5 correct')
  const counts = await electron.evaluate(() => globalThis.__qfnOutputE2e)
  if (counts.pdf !== 1 || counts.generated !== 1) {
    throw new Error('Packaged IPC processing/generation calls did not each occur once: ' + JSON.stringify(counts))
  }
  expect(errors).toEqual([])
  console.log('PASS: packaged Electron PDF upload, five visible quiz cards, selected answers, and results screen')
} catch (error) {
  console.error('Packaged Local AI UI output acceptance failed:', error?.stack || error)
  process.exitCode = 1
} finally {
  if (electron) await electron.close().catch(() => {})
}
