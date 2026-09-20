import {
  expect,
  test,
  type Page,
} from '@playwright/test'

const TEST_EMAIL = 'student@example.com'
const TEST_PASSWORD = 'correct-password'
const TEST_USER_ID = 'e2e-user-id'
const ACCESS_TOKEN = 'e2e-access-token'
const DOCUMENT_SHA256 = 'a'.repeat(64)

const gradingNone = {
  grading_version: 2,
  grading_mode: 'none',
  answer_groups: [],
  required_group_count: 0,
  numeric_value: 0,
  numeric_tolerance: 0,
  numeric_unit: '',
}

function buildUser() {
  const now = new Date().toISOString()

  return {
    id: TEST_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_EMAIL,
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    created_at: now,
    updated_at: now,
    app_metadata: {
      provider: 'email',
      providers: ['email'],
    },
    user_metadata: {},
    identities: [],
  }
}

function buildSession() {
  return {
    access_token: ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at:
      Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e-refresh-token',
    user: buildUser(),
  }
}

function makeQuestion(
  question: string,
  choices: string[],
  explanation: string,
  sourcePage: number,
) {
  return {
    question_type: 'multiple_choice',
    question,
    choices,
    correct_index: 0,
    correct_answer: choices[0],
    accepted_answers: [choices[0]],
    grading: gradingNone,
    explanation,
    source_pages: [sourcePage],
  }
}

const firstQuiz = {
  title: 'E2E Networking Basics',
  questions: [
    makeQuestion(
      'Which protocol provides reliable ordered delivery?',
      ['TCP', 'UDP', 'ARP', 'ICMP'],
      'TCP provides reliable, ordered delivery.',
      1,
    ),
    makeQuestion(
      'Which protocol is connectionless?',
      ['UDP', 'TCP', 'SSH', 'TLS'],
      'UDP is a connectionless transport protocol.',
      1,
    ),
    makeQuestion(
      'Which protocol maps IPv4 addresses to MAC addresses?',
      ['ARP', 'DNS', 'HTTP', 'FTP'],
      'ARP resolves an IPv4 address to a link-layer address.',
      2,
    ),
    makeQuestion(
      'Which protocol resolves host names to IP addresses?',
      ['DNS', 'ARP', 'ICMP', 'SSH'],
      'DNS resolves names to network addresses.',
      2,
    ),
    makeQuestion(
      'Which protocol is commonly used for web requests?',
      ['HTTP', 'ARP', 'ICMP', 'NTP'],
      'HTTP is used for web requests and responses.',
      2,
    ),
  ],
}

const practiceQuiz = {
  title: 'Targeted TCP Practice',
  questions: firstQuiz.questions.map(
    (question, index) => ({
      ...question,
      question:
        `Practice ${index + 1}: ${question.question}`,
    }),
  ),
}

const sourcePageText: Record<number, string> = {
  1: 'TCP provides reliable ordered delivery. UDP is a connectionless transport protocol.',
  2: 'ARP maps IPv4 addresses to MAC addresses. DNS resolves host names to IP addresses. HTTP is used for web requests.',
}

async function mockSupabase(
  page: Page,
  options: {
    validLogin?: boolean
  } = {},
) {
  const historyRows: Record<string, unknown>[] = []

  await page.route(
    '**/supabase-mock/auth/v1/token**',
    async (route) => {
      if (options.validLogin === false) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'invalid_credentials',
            message: 'Invalid login credentials',
          }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildSession()),
      })
    },
  )

  await page.route(
    '**/supabase-mock/auth/v1/user',
    async (route) => {
      expect(
        route.request().headers().authorization,
      ).toBe(`Bearer ${ACCESS_TOKEN}`)

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildUser()),
      })
    },
  )

  await page.route(
    '**/api-mock/api/quiz-history**',
    async (route) => {
      const request = route.request()
      expect(request.headers().authorization).toBe(`Bearer ${ACCESS_TOKEN}`)

      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            new URL(request.url()).pathname.endsWith('/document')
              ? historyRows
              : { items: historyRows, totalCount: historyRows.length, hasMore: false, nextCursor: null },
          ),
        })
        return
      }

      if (request.method() === 'POST') {
        const rawPayload =
          request.postDataJSON() as
            | Record<string, unknown>
            | Record<string, unknown>[]

        const payload = Array.isArray(rawPayload)
          ? rawPayload[0]
          : rawPayload

        expect(payload).not.toHaveProperty('user_id')
        historyRows.unshift({
          ...payload,
          user_id: buildUser().id,
          id: `history-${historyRows.length + 1}`,
          created_at: new Date().toISOString(),
        })

        await route.fulfill({
          status: 201,
          body: '',
        })
        return
      }

      if (request.method() === 'DELETE') {
        await route.fulfill({
          status: 204,
          body: '',
        })
        return
      }

      await route.fulfill({
        status: 405,
        body: '',
      })
    },
  )
}

async function mockBackend(page: Page) {
  let generationCount = 0
  let sourceRequestCount = 0

  await page.route('**/api-mock/api/documents/jobs', route => route.fulfill({ status: 404, json: { detail: 'Background processing disabled' } }))

  await page.route(
    '**/api-mock/api/documents/upload',
    async (route) => {
      expect(
        route.request().headers().authorization,
      ).toBe(`Bearer ${ACCESS_TOKEN}`)

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          filename: 'e2e-notes.pdf',
          pdf_sha256: DOCUMENT_SHA256,
          page_count: 2,
          character_count: 1560,
          extractable_page_count: 2,
          scanned_likely: false,
          warning: null,
          pages: [
            {
              page_number: 1,
              character_count: 780,
              preview:
                'TCP provides reliable ordered delivery. UDP is connectionless.',
            },
            {
              page_number: 2,
              character_count: 780,
              preview:
                'ARP maps IPv4 addresses to MAC addresses. DNS resolves host names.',
            },
          ],
        }),
      })
    },
  )

  await page.route(
    '**/api-mock/api/documents/*/pages/*',
    async (route) => {
      expect(
        route.request().headers().authorization,
      ).toBe(`Bearer ${ACCESS_TOKEN}`)

      const url = new URL(
        route.request().url(),
      )
      const segments =
        url.pathname.split('/')
      const pageNumber = Number(
        segments[segments.length - 1],
      )

      expect(url.pathname).toContain(
        DOCUMENT_SHA256,
      )

      sourceRequestCount += 1

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pdf_sha256: DOCUMENT_SHA256,
          page_number: pageNumber,
          text: sourcePageText[pageNumber],
        }),
      })
    },
  )

  await page.route(
    '**/api-mock/api/quizzes/generate',
    async (route) => {
      expect(
        route.request().headers().authorization,
      ).toBe(`Bearer ${ACCESS_TOKEN}`)

      const requestBody =
        route.request().postData() ?? ''

      expect(requestBody).toContain(
        'name="document_sha256"',
      )
      expect(requestBody).toContain(
        DOCUMENT_SHA256,
      )
      expect(requestBody).not.toContain(
        'filename="e2e-notes.pdf"',
      )
      expect(requestBody).not.toContain(
        'name="file"',
      )

      generationCount += 1

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          generationCount === 1
            ? firstQuiz
            : practiceQuiz,
        ),
      })
    },
  )

  return {
    getGenerationCount: () =>
      generationCount,
    getSourceRequestCount: () =>
      sourceRequestCount,
  }
}

for (const selected of [false, true]) {
test(`background PDF ${selected ? 'selected pages' : 'all pages'} reports progress, resumes after refresh and generates without reupload`, async ({ page }) => {
  await mockSupabase(page)
  await mockBackend(page)
  const id = '11111111-1111-4111-8111-111111111111'
  let submitted = false
  let complete = false
  let uploads = 0
  const base = { job_id: id, filename: 'e2e-notes.pdf', status: 'queued', completed_pages: 0, total_pages: 2,
    selected_pages: selected ? [2, 5] : [],
    expires_at: new Date(Date.now() + 3600000).toISOString(), error: null, result: null }
  const result = { filename: 'e2e-notes.pdf', pdf_sha256: DOCUMENT_SHA256, page_count: 2, character_count: 1560,
    extractable_page_count: 2, scanned_likely: false, warning: null,
    pages: [{ page_number: selected ? 2 : 1, character_count: 780, preview: sourcePageText[1] },
      { page_number: selected ? 5 : 2, character_count: 780, preview: sourcePageText[2] }] }
  await page.route('**/api-mock/api/documents/jobs', route => route.fulfill({ json: { jobs: submitted ? [base] : [], supports_page_selection: true } }))
  await page.route('**/api-mock/api/documents/upload', route => {
    if (selected) expect(route.request().postData()).toContain('name="page_selection"\r\n\r\n2,5')
    else expect(route.request().postData()).not.toContain('name="page_selection"')
    uploads += 1
    submitted = true
    return route.fulfill({ status: 202, json: base })
  })
  await page.route(`**/api-mock/api/documents/jobs/${id}`, route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    return route.fulfill({ json: complete ? { ...base, status: 'succeeded', completed_pages: 2, result }
      : { ...base, status: 'processing', completed_pages: 1 } })
  })
  await logIn(page)
  await page.locator('input[type="file"]').setInputFiles({ name: 'e2e-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic') })
  if (selected) {
    const selection = page.getByLabel('Pages to process (optional)')
    await selection.fill('5-2')
    await page.getByRole('button', { name: 'Process PDF', exact: true }).click()
    await expect(page.getByText('Page ranges must be between 1 and 100, in ascending order.')).toBeVisible()
    expect(uploads).toBe(0)
    await selection.fill('5, 2, 5')
  }
  await page.getByRole('button', { name: 'Process PDF', exact: true }).click()
  await expect(page.getByRole('progressbar', { name: 'PDF pages processed' })).toHaveAttribute('value', '1')
  await expect(page.getByText('Processed 1 of 2 pages.')).toBeVisible()
  await expect(page.locator('input[type="file"]')).toBeDisabled()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume e2e-notes.pdf' })).toBeVisible()
  complete = true
  await page.getByRole('button', { name: 'Resume e2e-notes.pdf' }).click()
  await expect(page.getByText('PDF processed successfully')).toBeVisible()
  if (selected) await expect(page.getByText('Source pages: 2, 5.')).toBeVisible()
  await page.getByRole('button', { name: 'Generate Quiz', exact: true }).click()
  await expect(page.getByRole('heading', { name: firstQuiz.title })).toBeVisible()
  expect(uploads).toBe(1)
})
}

test('background PDF cancellation discards the job and permits a new upload', async ({ page }) => {
  await mockSupabase(page)
  await mockBackend(page)
  const id = '22222222-2222-4222-8222-222222222222'
  let cancelled = false
  const job = { job_id: id, filename: 'e2e-notes.pdf', status: 'queued', completed_pages: 0, total_pages: null,
    expires_at: new Date(Date.now() + 3600000).toISOString(), error: null, result: null }
  await page.route('**/api-mock/api/documents/upload', route => route.fulfill({ status: 202, json: job }))
  await page.route(`**/api-mock/api/documents/jobs/${id}`, route => {
    if (route.request().method() === 'DELETE') {
      cancelled = true
      return route.fulfill({ status: 204 })
    }
    expect(cancelled).toBe(false)
    return route.fulfill({ json: job })
  })
  await logIn(page)
  await page.locator('input[type="file"]').setInputFiles({ name: 'e2e-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic') })
  await page.getByRole('button', { name: 'Process PDF', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel and discard PDF' }).click()
  await expect(page.getByRole('status')).toHaveText('PDF processing cancelled.')
  await expect(page.getByRole('button', { name: 'Process PDF', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Resume e2e-notes.pdf' })).toHaveCount(0)
  expect(cancelled).toBe(true)
})

async function submitLogin(
  page: Page,
  password = TEST_PASSWORD,
) {
  await page.getByLabel('Email').fill(TEST_EMAIL)
  await page.getByLabel('Password').fill(password)

  await page
    .locator('form')
    .getByRole('button', {
      name: 'Log In',
    })
    .click()
}

async function logIn(page: Page) {
  await page.goto('/')
  await submitLogin(page)

  await expect(
    page.getByText('Signed in as'),
  ).toBeVisible()

  await expect(
    page.getByText(TEST_EMAIL),
  ).toBeVisible()
}

test(
  'logs in and completes the PDF, quiz, history, and weak-area workflow',
  async ({ page }) => {
    await mockSupabase(page)
    const backend =
      await mockBackend(page)

    await logIn(page)

    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'e2e-notes.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(
          '%PDF-1.4\n% QuizForge E2E fixture\n',
        ),
      })

    await page
      .getByRole('button', {
        name: 'Process PDF',
      })
      .click()

    await expect(
      page.getByText('PDF processed successfully'),
    ).toBeVisible()

    await expect(
      page.getByText('1,560'),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Generate Quiz',
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: firstQuiz.title,
      }),
    ).toBeVisible()

    const cards = page.locator('.question-card')
    const answers = [
      'UDP',
      'UDP',
      'ARP',
      'DNS',
      'HTTP',
    ]

    for (
      let index = 0;
      index < answers.length;
      index += 1
    ) {
      await cards
        .nth(index)
        .getByText(answers[index], {
          exact: true,
        })
        .click()
    }

    await page
      .getByRole('button', {
        name: 'Check Answers',
      })
      .click()

    await expect(
      page.getByText('80%', {
        exact: true,
      }).first(),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: '4 / 5 correct',
      }),
    ).toBeVisible()

    await expect(
      page.getByText(
        'TCP provides reliable, ordered delivery.',
      ),
    ).toBeVisible()

    expect(
      backend.getSourceRequestCount(),
    ).toBe(0)

    await cards
      .nth(0)
      .getByRole('button', {
        name: 'View Source',
      })
      .click()

    await expect(
      cards
        .nth(0)
        .getByText(
          sourcePageText[1],
        ),
    ).toBeVisible()

    expect(
      backend.getSourceRequestCount(),
    ).toBeGreaterThan(0)

    await page
      .getByRole('button', {
        name: 'Save Result',
      })
      .click()

    await expect(
      page.getByText(
        'Quiz result saved to your history.',
      ),
    ).toBeVisible()

    const historyToggle =
      page.getByRole('button', {
        name: /My Quiz History/,
      })

    await expect(
      historyToggle,
    ).toContainText(
      'Open to load saved quizzes',
    )

    await historyToggle.click()

    await expect(
      page
        .locator('.history-card')
        .getByRole('heading', {
          name: firstQuiz.title,
        }),
    ).toBeVisible()

    await expect(
      historyToggle,
    ).toContainText('1 saved quiz')

    await page
      .getByRole('button', {
        name: 'Practice Weak Areas',
      })
      .click()

    await expect(
      page.getByText('Weak Areas Practice'),
    ).toBeVisible()

    await expect(
      page.getByText('Targeted practice'),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: practiceQuiz.title,
      }),
    ).toBeVisible()

    expect(
      backend.getGenerationCount(),
    ).toBe(2)
  },
)

test(
  'shows an authentication error for invalid credentials',
  async ({ page }) => {
    await mockSupabase(page, {
      validLogin: false,
    })

    await page.goto('/')
    await submitLogin(
      page,
      'wrong-password',
    )

    await expect(
      page.getByText(
        'Invalid login credentials',
      ),
    ).toBeVisible()
  },
)
