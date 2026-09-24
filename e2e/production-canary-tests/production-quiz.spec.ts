import {
  expect,
  test,
} from '@playwright/test'

import {
  expectAuthenticatedDeploymentBoundary,
} from '../support/authenticatedCanary'

const frontendUrl =
  process.env.CANARY_FRONTEND_URL ||
  'https://quizfromnotes.com'
const backendUrl =
  process.env.CANARY_BACKEND_URL ||
  'https://api.quizfromnotes.com'
const email =
  process.env.QUIZFORGE_CANARY_EMAIL || ''
const password =
  process.env.QUIZFORGE_CANARY_PASSWORD || ''

function escapePdfText(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function buildSyntheticStudyPdf() {
  const lines = [
    'QuizForge production end to end canary notes.',
    'TCP provides reliable ordered delivery of a byte stream.',
    'TCP acknowledges received data and retransmits missing data.',
    'UDP sends independent datagrams without guaranteeing delivery or ordering.',
    'DNS translates domain names into IP addresses.',
    'A DNS cache temporarily stores previous lookup results.',
    'Routers forward packets between different networks.',
    'An IP address identifies a network interface for packet delivery.',
    'A port number identifies an application endpoint on a host.',
    'HTTPS protects HTTP traffic by using TLS encryption.',
    'TLS certificates authenticate the server to the client.',
    'These facts are synthetic and exist only for this production canary.',
  ]

  const streamLines = [
    'BT',
    '/F1 11 Tf',
    '72 740 Td',
  ]

  lines.forEach((line, index) => {
    if (index > 0) {
      streamLines.push('0 -18 Td')
    }

    streamLines.push(
      `(${escapePdfText(line)}) Tj`,
    )
  })

  streamLines.push('ET')

  const stream =
    streamLines.join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ]

  let pdf =
    '%PDF-1.4\n% QuizForge canary\n'
  const offsets = [0]

  objects.forEach((object, index) => {
    offsets.push(
      Buffer.byteLength(pdf, 'ascii'),
    )
    pdf +=
      `${index + 1} 0 obj\n${object}\nendobj\n`
  })

  const xrefOffset =
    Buffer.byteLength(pdf, 'ascii')

  pdf +=
    `xref\n0 ${objects.length + 1}\n`
  pdf +=
    '0000000000 65535 f \n'

  offsets.slice(1).forEach((offset) => {
    pdf +=
      `${offset.toString().padStart(10, '0')} 00000 n \n`
  })

  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf +=
    `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'ascii')
}

test(
  'live production user can process a PDF and generate a five-question AI quiz',
  async ({ page }) => {
    test.setTimeout(240_000)

    let authError: unknown = null

    for (
      let attempt = 0;
      attempt < 2;
      attempt += 1
    ) {
      try {
        await expectAuthenticatedDeploymentBoundary({
          page,
          frontendUrl,
          backendUrl,
          email,
          password,
        })
        authError = null
        break
      } catch (error) {
        authError = error

        if (attempt === 0) {
          await page.waitForTimeout(10_000)
          await page.goto(frontendUrl)
        }
      }
    }

    if (authError) {
      throw authError
    }

    await page
      .getByLabel('Study material PDF')
      .setInputFiles({
        name: 'quizforge-production-canary.pdf',
        mimeType: 'application/pdf',
        buffer: buildSyntheticStudyPdf(),
      })

    const uploadResponsePromise =
      page.waitForResponse(
        (response) =>
          response.url().includes(
            '/api/documents/upload',
          ) &&
          response.request().method() ===
            'POST',
        {
          timeout: 90_000,
        },
      )

    await page
      .getByRole('button', {
        name: 'Process PDF',
      })
      .click()

    const uploadResponse =
      await uploadResponsePromise

    expect(uploadResponse.status()).toBe(200)

    await expect(
      page.getByRole('heading', {
        name: 'PDF processed successfully',
      }),
    ).toBeVisible({
      timeout: 30_000,
    })

    await page
      .getByLabel('Difficulty')
      .selectOption('easy')
    await page
      .getByLabel('Question type')
      .selectOption('multiple_choice')

    const generationResponsePromise =
      page.waitForResponse(
        (response) =>
          response.url().includes(
            '/api/quizzes/generate',
          ) &&
          response.request().method() ===
            'POST',
        {
          timeout: 180_000,
        },
      )

    await page
      .getByRole('button', {
        name: 'Generate Quiz',
      })
      .click()

    const generationResponse =
      await generationResponsePromise

    expect(generationResponse.status()).toBe(
      200,
    )

    const generated =
      await generationResponse.json() as {
        questions?: unknown[]
      }

    expect(
      generated.questions?.length,
    ).toBe(5)

    await expect(
      page.getByText(
        'AI-generated quiz',
        {
          exact: true,
        },
      ),
    ).toBeVisible({
      timeout: 30_000,
    })

    await expect(
      page.getByText('5 questions', {
        exact: true,
      }),
    ).toBeVisible()

    const questionCards =
      page.locator('article.question-card')

    await expect(questionCards).toHaveCount(5)

    for (
      let index = 0;
      index < 5;
      index += 1
    ) {
      await questionCards
        .nth(index)
        .locator('input[type="radio"]')
        .first()
        .check()
    }

    await page
      .getByRole('button', {
        name: 'Check Answers',
      })
      .click()

    await expect(
      page.getByText('Quiz complete', {
        exact: true,
      }),
    ).toBeVisible({
      timeout: 30_000,
    })
  },
)
