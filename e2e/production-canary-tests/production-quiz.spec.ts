import {
  expect,
  test,
  type Page,
} from '@playwright/test'
import {
  createHmac,
} from 'node:crypto'
import {
  readFileSync,
} from 'node:fs'

const frontendUrl =
  process.env.CANARY_FRONTEND_URL ||
  'https://quizfromnotes.com'

type CanaryFixture = {
  email: string
  password: string
  totp: string
}

function readCanaryFixture(): CanaryFixture {
  const path =
    process.env.CANARY_FIXTURE_PATH || ''

  expect(path.length).toBeGreaterThan(0)

  const value =
    JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<CanaryFixture>

  expect(value.email).toMatch(
    /^qf-prod-canary-[0-9]+@example\.invalid$/,
  )
  expect(value.password?.length).toBeGreaterThan(
    20,
  )
  expect(value.totp).toMatch(
    /^[A-Z2-7]{16,128}$/,
  )

  return {
    email: value.email!,
    password: value.password!,
    totp: value.totp!,
  }
}

function currentTotp(secret: string) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''

  for (
    const character of secret.replace(/=+$/, '')
  ) {
    const index =
      alphabet.indexOf(character)

    if (index < 0) {
      throw new Error(
        'Invalid production canary TOTP secret.',
      )
    }

    bits +=
      index.toString(2).padStart(5, '0')
  }

  const chunks =
    bits.match(/.{8}/g) ?? []
  const key = Buffer.from(
    chunks.map((chunk) =>
      Number.parseInt(chunk, 2),
    ),
  )
  const counter = Buffer.alloc(8)

  counter.writeBigUInt64BE(
    BigInt(
      Math.floor(Date.now() / 30_000),
    ),
  )

  const digest =
    createHmac('sha1', key)
      .update(counter)
      .digest()
  const offset =
    digest[digest.length - 1] & 15
  const code =
    (
      digest.readUInt32BE(offset) &
      0x7fffffff
    ) % 1_000_000

  return String(code).padStart(6, '0')
}

async function signInAndEnrollCanary(
  page: Page,
  fixture: CanaryFixture,
) {
  await page.goto(frontendUrl)

  const signIn =
    page.getByRole('button', {
      name: 'Sign in or create account',
    })

  await expect(signIn).toBeVisible({
    timeout: 30_000,
  })
  await signIn.click()

  const usernameInput =
    page.locator(
      'input[name="username"]:visible',
    )
  const passwordInput =
    page.locator(
      'input[name="password"]:visible',
    )

  await usernameInput.waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await usernameInput.fill(fixture.email)
  await passwordInput.fill(fixture.password)

  await page
    .locator(
      'input[name="signInSubmitButton"]:visible,button[name="signInSubmitButton"]:visible',
    )
    .click()

  const totpInput =
    page.locator(
      'input[name="authentication_code"][id="totpCodeInput"]:visible',
    )

  await totpInput.waitFor({
    state: 'visible',
    timeout: 30_000,
  })

  // The setup OTP cannot be reused in the same period.
  await page.waitForTimeout(
    31_000 - (Date.now() % 30_000),
  )
  await totpInput.fill(
    currentTotp(fixture.totp),
  )

  await page
    .locator(
      'input[type="submit"]:visible,button[type="submit"]:visible',
    )
    .click()

  const productionOrigin =
    new URL(frontendUrl).origin

  await page.waitForURL(
    (url) =>
      url.origin === productionOrigin,
    {
      timeout: 60_000,
    },
  )

  await expect(
    page.getByRole('heading', {
      name: 'Set up your account',
    }),
  ).toBeVisible({
    timeout: 30_000,
  })

  await page
    .getByLabel('Account setup')
    .selectOption('enroll')

  await page
    .getByRole('button', {
      name: 'Continue account setup',
    })
    .click()

  await page
    .getByRole('button', {
      name: 'Confirm account setup',
    })
    .click()

  await expect(
    page.getByRole('heading', {
      name: 'Upload your study material',
    }),
  ).toBeVisible({
    timeout: 30_000,
  })
}

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
