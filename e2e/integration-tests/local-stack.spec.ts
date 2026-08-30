import { expect, test } from '@playwright/test'

const testEmail =
  process.env.INTEGRATION_TEST_EMAIL ||
  'quizforge-integration@example.com'
const testPassword =
  process.env.INTEGRATION_TEST_PASSWORD ||
  'Integration123!'

function escapePdfText(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function makeTextPdf() {
  const lines = [
    'QuizForge local integration test study material verifies real PDF extraction.',
    'This selectable text intentionally exceeds the scanned-document threshold used by the backend.',
    'The browser sends this PDF through FastAPI while Supabase authenticates the user and Redis caches it.',
  ]

  const textCommands = lines
    .map(
      (line, index) =>
        `${index === 0 ? '' : '0 -18 Td\n'}(${escapePdfText(line)}) Tj`,
    )
    .join('\n')

  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${textCommands}\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]

  objects.forEach((objectBody, index) => {
    offsets.push(
      Buffer.byteLength(pdf, 'ascii'),
    )
    pdf += `${index + 1} 0 obj\n${objectBody}\nendobj\n`
  })

  const xrefOffset =
    Buffer.byteLength(pdf, 'ascii')

  pdf += 'xref\n0 6\n'
  pdf += '0000000000 65535 f \n'

  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })

  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\n'
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'ascii')
}

function waitForDocumentUpload(page: Parameters<typeof test>[0] extends never ? never : any) {
  return page.waitForResponse((response: any) => {
    const url = new URL(response.url())

    return (
      url.pathname === '/api/documents/upload' &&
      response.request().method() === 'POST'
    )
  })
}

test(
  'browser uses real local Supabase, FastAPI, and Redis',
  async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto('/')

    await expect(
      page.getByRole('heading', {
        name: 'Welcome back',
      }),
    ).toBeVisible()

    await page.getByLabel('Email').fill(
      testEmail,
    )
    await page.getByLabel('Password').fill(
      testPassword,
    )
    await page.locator('form').getByRole(
      'button',
      {
        name: 'Log In',
      },
    ).click()

    await expect(
      page.getByText(testEmail),
    ).toBeVisible()

    const historyToggle =
      page.getByRole('button', {
        name: /My Quiz History/,
      })

    await expect(historyToggle).toContainText(
      '1 saved quiz',
    )
    await historyToggle.click()

    const seedCard = page
      .locator('article.history-card')
      .filter({
        hasText: 'Integration Seed Quiz',
      })

    await expect(seedCard).toBeVisible()
    await expect(
      page.getByText('Other User Hidden Quiz'),
    ).toHaveCount(0)

    await seedCard.getByRole('button', {
      name: 'Delete',
    }).click()

    await expect(seedCard).toHaveCount(0)
    await expect(historyToggle).toContainText(
      '0 saved quizzes',
    )

    const fileInput =
      page.locator('input[type="file"]')

    await fileInput.setInputFiles({
      name: 'integration-notes.pdf',
      mimeType: 'application/pdf',
      buffer: makeTextPdf(),
    })

    const processButton =
      page.getByRole('button', {
        name: 'Process PDF',
      })
    const successHeading =
      page.getByRole('heading', {
        name: 'PDF processed successfully',
      })

    const firstUploadPromise =
      waitForDocumentUpload(page)
    await processButton.click()
    const firstUploadResponse =
      await firstUploadPromise

    expect(firstUploadResponse.status()).toBe(200)
    const firstUploadBody =
      await firstUploadResponse.json()
    expect(firstUploadBody.filename).toBe(
      'integration-notes.pdf',
    )
    expect(firstUploadBody.page_count).toBe(1)
    expect(
      firstUploadBody.character_count,
    ).toBeGreaterThan(100)
    await expect(successHeading).toBeVisible()

    // Processing the same PDF again exercises the real Redis document cache hit.
    const secondUploadPromise =
      waitForDocumentUpload(page)
    await processButton.click()
    const secondUploadResponse =
      await secondUploadPromise

    expect(secondUploadResponse.status()).toBe(200)
    await expect(successHeading).toBeVisible()
  },
)
