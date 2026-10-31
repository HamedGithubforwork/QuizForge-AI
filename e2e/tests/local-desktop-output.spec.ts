import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Runs on Windows in Local AI product acceptance, using the *actual output*
// from the preceding pinned-model biology run, not a hand-written quiz.
// Browser automation substitutes only native sign-in/PDF IPC; the packaged
// Electron launch and real PDF parser are tested separately.
const reportPath = process.env.QFN_LOCAL_BIOLOGY_REPORT
test.skip(!reportPath, 'Requires the model-generated biology evidence from Windows product acceptance')

type BiologyFixture = {
  pdfSha256: string
  characterCount: number
  pages: { pageNumber: number; text: string }[]
}
type ModelQuestion = {
  question: string
  correct_index: number
  correct_answer: string
  choices: string[]
  source_pages: number[]
}
type ModelQuiz = { title: string; questions: ModelQuestion[] }

const biology: BiologyFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../desktop/test/fixtures/biology-study-notes.json'), 'utf8'),
)

function readModelQuiz(): ModelQuiz {
  if (!reportPath) throw new Error('QFN_LOCAL_BIOLOGY_REPORT is required')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  expect(report.outcome).toBe('pass')
  expect(report.pdfSha256).toBe(biology.pdfSha256)
  expect(report.quiz?.questions).toHaveLength(5)
  return report.quiz as ModelQuiz
}

// A genuinely well-formed, synthetic PDF for exercising the file picker.
// The native PDF extraction step is a controlled bridge stub here.
function syntheticPdf(): Buffer {
  const objects: string[] = []
  const pageRefs: string[] = []
  for (let i = 0; i < biology.pages.length; i++) {
    pageRefs.push(String(3 + i * 2) + ' 0 R')
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = '<< /Type /Pages /Kids [' + pageRefs.join(' ') +
    '] /Count ' + biology.pages.length + ' >>'
  for (let i = 0; i < biology.pages.length; i++) {
    const pageId = 3 + i * 2
    const contentId = pageId + 1
    objects[pageId - 1] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' +
      (3 + biology.pages.length * 2) + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'
    const preview = biology.pages[i].text.slice(0, 120)
      .replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
      .replace(/[^\x20-\x7e]/g, ' ')
    const stream = 'BT /F1 10 Tf 36 740 Td (' + preview + ') Tj ET'
    objects[contentId - 1] = '<< /Length ' + Buffer.byteLength(stream) +
      ' >>\nstream\n' + stream + '\nendstream'
  }
  objects[2 + biology.pages.length * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += String(index + 1) + ' 0 obj\n' + object + '\nendobj\n'
  }
  const xref = Buffer.byteLength(pdf)
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n'
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return Buffer.from(pdf)
}

async function openDesktopUi(
  page: Page, quiz: ModelQuiz, returnEmpty = false, practiceQuiz?: ModelQuiz,
) {
  await page.addInitScript(({ fixture, generated, empty, practiceResult }) => {
    const calls = { pdf: 0, generate: 0, requests: [] as unknown[], quizRequests: [] as unknown[] }
    const account = { userId: 'local-ui-e2e', email: 'local-ui@example.test', enrolled: true }
    const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body), contentType: 'application/json' })
    Object.assign(window, {
      __localOutputProbe: calls,
      quizFromNotesDesktop: {
        version: 1,
        status: async () => ({ available: true, account }),
        signIn: async () => account,
        signOut: async () => {},
        openAccountWebsite: async () => {},
        request: async (request: { path: string }) => {
          calls.requests.push(request.path)
          if (request.path === '/api/documents/jobs') return json({ jobs: [] })
          if (request.path.startsWith('/api/quiz-history')) return json({ items: [], next_cursor: null })
          if (request.path === '/api/decks') return json([])
          return json({})
        },
        reminderStatus: async () => ({ supported: false, enabled: false }),
        enableReminders: async () => {},
        disableReminders: async () => {},
        localAiStatus: async () => ({ model: { ready: true }, capability: { acceleration: 'cpu' } }),
        startLocalAiModelDownload: async () => ({}),
        cancelLocalAiModelDownload: async () => ({}),
        removeLocalAiModel: async () => ({}),
        localAiQuizStatus: async () => ({
          available: true, reason: null, busy: false,
          modelId: 'qwen3-4b-q4-k-m', execution: 'local',
          constraints: {
            questionCounts: [5, 10, 15],
            questionTypes: ['multiple_choice', 'true_false', 'short_answer', 'mixed'],
            maxSourceBytes: 8000,
          },
        }),
        processLocalPdf: async (request: { bytes: Uint8Array; filename: string }) => {
          calls.pdf++
          if (new TextDecoder().decode(request.bytes.slice(0, 4)) !== '%PDF') {
            return { ok: false, error: 'invalid_input' }
          }
          return { ok: true, document: {
            filename: request.filename, pdfSha256: fixture.pdfSha256,
            pageCount: fixture.pages.length, characterCount: fixture.characterCount,
            extractablePageCount: fixture.pages.length, scannedLikely: false,
            warning: null, pages: fixture.pages,
          } }
        },
        generateLocalAiQuiz: async (request: {
          pages: { pageNumber: number; text: string }[];
          questionCount: number; difficulty: string; questionType: string;
          practice?: { focusPages?: number[]; avoidQuestions: string[] };
        }) => {
          calls.generate++
          calls.quizRequests.push(request)
          if (request.questionCount !== 5 || request.difficulty !== 'easy' ||
              request.questionType !== 'multiple_choice' ||
              JSON.stringify(request.pages) !== JSON.stringify(fixture.pages)) {
            return { ok: false, error: 'invalid_request' }
          }
          if (request.practice) {
            return practiceResult
              ? { ok: true, quiz: practiceResult }
              : { ok: false, error: 'insufficient_source' }
          }
          return { ok: true, quiz: empty
            ? { title: 'Empty quiz', questions: [] }
            : generated }
        },
        cancelLocalAiQuiz: async () => {},
        loadSourcePageText: async () => '',
      },
    })
  }, { fixture: biology, generated: quiz, empty: returnEmpty, practiceResult: practiceQuiz })
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByText('Signed in as local-ui@example.test')).toBeVisible()
  await page.getByLabel('Study material PDF').setInputFiles({
    name: 'synthetic-biology-study-notes.pdf',
    mimeType: 'application/pdf',
    buffer: syntheticPdf(),
  })
  await page.getByRole('button', { name: 'Process PDF on this computer' }).click()
  await expect(page.getByRole('heading', { name: 'Quiz settings' })).toBeVisible()
  await expect(page.getByLabel('Generation engine')).toHaveValue('local')
  await page.getByLabel('Difficulty').selectOption('easy')
  await page.getByRole('button', { name: 'Generate Locally' }).click()
  return pageErrors
}

test('the real model output becomes five visible, answerable questions and a results screen', async ({ page }) => {
  const quiz = readModelQuiz()
  const errors = await openDesktopUi(page, quiz)
  await expect(page.locator('#quiz-start')).toBeVisible()
  await expect(page.locator('.question-card')).toHaveCount(5)
  await expect(page.locator('#quiz-start')).toContainText(quiz.title)
  for (const [index, question] of quiz.questions.entries()) {
    const card = page.locator('.question-card').nth(index)
    await expect(card.locator('h3')).toHaveText(question.question)
    await expect(card.locator('input[type=radio]')).toHaveCount(4)
    await card.locator('input[type=radio]').nth(question.correct_index).check()
    await expect(card.locator('input[type=radio]').nth(question.correct_index)).toBeChecked()
  }
  await expect(page.getByText('5 of 5 answered')).toBeVisible()
  await page.getByRole('button', { name: 'Check Answers' }).click()
  await expect(page.locator('#quiz-results')).toBeVisible()
  await expect(page.locator('#quiz-results')).toContainText('5 / 5 correct')
  const result = await page.evaluate(() => (window as unknown as {
    __localOutputProbe: { pdf: number; generate: number; requests: string[] }
  }).__localOutputProbe)
  expect(result.pdf).toBe(1)
  expect(result.generate).toBe(1)
  expect(result.requests.some(request => request.includes('/api/quizzes/generate'))).toBe(false)
  expect(errors).toEqual([])
})

test('an empty success response shows an error instead of a blank quiz', async ({ page }) => {
  const errors = await openDesktopUi(page, readModelQuiz(), true)
  await expect(page.getByRole('alert')).toContainText('Local AI returned an empty or incomplete quiz')
  await expect(page.locator('.question-card')).toHaveCount(0)
  await expect(page.locator('#quiz-results')).toHaveCount(0)
  expect(errors).toEqual([])
})
 
test('Practice Weak Areas prioritizes missed pages while retaining PDF context and shows a playable quiz', async ({ page }) => {
  const original = readModelQuiz()
  const followup: ModelQuiz = {
    title: 'Weak Areas Follow-up Quiz',
    questions: original.questions.map(question => ({
      ...question,
      question: 'Follow-up: ' + question.question,
    })),
  }
  const errors = await openDesktopUi(page, original, false, followup)
  await expect(page.locator('.question-card')).toHaveCount(5)
  const missed = original.questions[0]
  const wrongIndex = (missed.correct_index + 1) % 4
  for (const [index, question] of original.questions.entries()) {
    await page.locator('.question-card').nth(index)
      .locator('input[type=radio]')
      .nth(index === 0 ? wrongIndex : question.correct_index)
      .check()
  }
  await page.getByRole('button', { name: 'Check Answers' }).click()
  await expect(page.locator('#quiz-results')).toContainText('4 / 5 correct')
  await page.getByRole('button', { name: 'Practice Weak Areas' }).click()
  await expect(page.locator('#quiz-start')).toContainText('Weak Areas Follow-up Quiz')
  await expect(page.locator('.question-card')).toHaveCount(5)
  await expect(page.locator('#quiz-results')).toHaveCount(0)
  const probe = await page.evaluate(() => (window as unknown as {
    __localOutputProbe: {
      generate: number;
      requests: string[];
      quizRequests: Array<{ pages: { pageNumber: number }[];
        practice?: { focusPages: number[]; avoidQuestions: string[] } }>;
    };
  }).__localOutputProbe)
  expect(probe.generate).toBe(2)
  expect(probe.quizRequests[1].pages.map(p => p.pageNumber))
    .toEqual(biology.pages.map(p => p.pageNumber))
  expect(probe.quizRequests[1].practice?.focusPages)
    .toEqual(original.questions[0].source_pages)
  expect(probe.quizRequests[1].practice?.avoidQuestions)
    .toEqual([original.questions[0].question])
  expect(probe.requests.some(request => request.includes('/api/quizzes/generate'))).toBe(false)
  expect(errors).toEqual([])
})

test('failed weak-area practice reports its error beside the completed quiz', async ({ page }) => {
  const original = readModelQuiz()
  const errors = await openDesktopUi(page, original)
  for (const [index, question] of original.questions.entries()) {
    const wrongIndex = (question.correct_index + 1) % 4
    await page.locator('.question-card').nth(index)
      .locator('input[type=radio]').nth(index === 0 ? wrongIndex : question.correct_index).check()
  }
  await page.getByRole('button', { name: 'Check Answers' }).click()
  await page.getByRole('button', { name: 'Practice Weak Areas' }).click()
  await expect(page.locator('#quiz-results').getByRole('alert'))
    .toContainText('Could not build weak-area practice')
  await expect(page.locator('#quiz-results').getByRole('alert'))
    .toContainText('Local AI')
  await expect(page.locator('.question-card')).toHaveCount(5)
  expect(errors).toEqual([])
})
