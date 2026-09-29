import { expect, test } from '@playwright/test'
import { readCanaryFixture, signInAndEnrollCanary } from './canary-fixture'

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

// This live canary intentionally performs exactly one paid quiz generation.
test(
  'live production Cognito user can process a PDF and generate a five-question AI quiz',
  async ({ page }) => {
    test.setTimeout(300_000)

    const fixture =
      readCanaryFixture()

    await signInAndEnrollCanary(
      page,
      fixture,
    )

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

    expect(
      [200, 202],
    ).toContain(
      uploadResponse.status(),
    )

    await expect(
      page.getByRole('heading', {
        name: 'PDF processed successfully',
      }),
    ).toBeVisible({
      timeout: 120_000,
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
      page
        .locator('#quiz-start')
        .getByText('5 questions', {
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

    // Reuse the one generated quiz to validate the persistent study loop.
    await page
      .getByRole('button', {
        name: 'Save as Study Deck',
      })
      .click()

    const deckNameInput =
      page.getByLabel('Deck name')

    await expect(
      deckNameInput,
    ).toBeVisible()

    await deckNameInput.fill(
      'Production Canary Deck',
    )

    const createDeckResponse =
      page.waitForResponse(
        (response) =>
          response.url().endsWith(
            '/api/decks',
          ) &&
          response.request().method() ===
            'POST',
        {
          timeout: 30_000,
        },
      )

    await page
      .getByRole('button', {
        name: 'Save 5 as Deck',
      })
      .click()

    expect(
      (
        await createDeckResponse
      ).status(),
    ).toBe(201)

    await expect(
      page.getByText(
        'Saved "Production Canary Deck" with 5 cards.',
        {
          exact: true,
        },
      ),
    ).toBeVisible({
      timeout: 30_000,
    })

    await page
      .getByRole('button', {
        name: 'Decks',
        exact: true,
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'My Decks',
      }),
    ).toBeVisible({
      timeout: 30_000,
    })

    const canaryDeck =
      page.locator(
        'button.deck-tile',
      ).filter({
        hasText:
          'Production Canary Deck',
      })

    await expect(
      canaryDeck,
    ).toHaveCount(1)
    await canaryDeck.click()

    await expect(
      page.getByRole('heading', {
        name:
          'Production Canary Deck',
      }),
    ).toBeVisible({
      timeout: 30_000,
    })

    await expect(
      page.getByRole('button', {
        name: 'Review 5 Due',
      }),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Review 5 Due',
      })
      .click()

    await expect(
      page.getByRole('button', {
        name: 'Show Answer',
      }),
    ).toBeVisible({
      timeout: 30_000,
    })

    await page
      .getByRole('button', {
        name: 'Show Answer',
      })
      .click()

    const reviewResponse =
      page.waitForResponse(
        (response) =>
          /\/api\/decks\/[^/]+\/review(?:\?|$)/.test(
            new URL(
              response.url(),
            ).pathname,
          ) &&
          response.request().method() ===
            'POST',
        {
          timeout: 30_000,
        },
      )

    await page
      .getByRole('button', {
        name: /Good/,
      })
      .click()

    expect(
      (
        await reviewResponse
      ).status(),
    ).toBe(200)

    await expect(
      page.locator(
        '.review-session-count',
      ),
    ).toContainText('4 due')
  },
)
