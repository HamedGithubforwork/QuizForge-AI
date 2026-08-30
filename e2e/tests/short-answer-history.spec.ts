import {
  expect,
  test,
  type Page,
} from '@playwright/test'

const TEST_EMAIL = 'student@example.com'
const TEST_PASSWORD = 'correct-password'
const TEST_USER_ID = 'e2e-short-answer-user'
const ACCESS_TOKEN = 'e2e-short-answer-token'
const DOCUMENT_SHA256 = 'a'.repeat(64)

const shortAnswerQuiz = {
  title: 'E2E Short Answer Treatments',
  questions: [
    {
      question_type: 'short_answer',
      question:
        'Name the three first-line psychological treatments.',
      choices: [],
      correct_index: -1,
      correct_answer:
        'Cognitive behavioural therapy, interpersonal therapy, and behavioural activation',
      accepted_answers: [
        'CBT, IPT, and BA',
      ],
      grading: {
        grading_version: 2,
        grading_mode: 'concepts',
        answer_groups: [
          [
            'cognitive behavioural therapy',
            'cognitive behavioral therapy',
            'CBT',
          ],
          [
            'interpersonal therapy',
            'IPT',
          ],
          [
            'behavioural activation',
            'behavioral activation',
            'BA',
          ],
        ],
        required_group_count: 3,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'The source lists CBT, IPT, and behavioural activation as first-line treatments.',
      source_pages: [1],
    },
  ],
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
    refresh_token: 'e2e-short-answer-refresh',
    user: buildUser(),
  }
}

async function mockSupabase(page: Page) {
  const historyRows: Record<string, unknown>[] = []
  let historyGetCount = 0

  await page.route(
    '**/supabase-mock/auth/v1/token**',
    async (route) => {
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
    '**/supabase-mock/rest/v1/quiz_history**',
    async (route) => {
      const request = route.request()

      if (request.method() === 'GET') {
        historyGetCount += 1

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(historyRows),
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

        historyRows.unshift({
          ...payload,
          id: `short-history-${historyRows.length + 1}`,
          created_at: new Date().toISOString(),
        })

        await route.fulfill({
          status: 201,
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

  return {
    getHistoryGetCount: () => historyGetCount,
  }
}

async function mockBackend(page: Page) {
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
          filename: 'e2e-short-answer.pdf',
          pdf_sha256: DOCUMENT_SHA256,
          page_count: 1,
          character_count: 420,
          extractable_page_count: 1,
          scanned_likely: false,
          warning: null,
          pages: [
            {
              page_number: 1,
              character_count: 420,
              preview:
                'First-line treatments include CBT, IPT, and behavioural activation.',
              text:
                'First-line psychological treatments include cognitive behavioural therapy (CBT), interpersonal therapy (IPT), and behavioural activation (BA).',
            },
          ],
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
      expect(
        route.request().postData(),
      ).toContain('short_answer')

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(shortAnswerQuiz),
      })
    },
  )
}

async function logIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(TEST_EMAIL)
  await page
    .getByLabel('Password')
    .fill(TEST_PASSWORD)

  await page
    .locator('form')
    .getByRole('button', {
      name: 'Log In',
    })
    .click()

  await expect(
    page.getByText(TEST_EMAIL),
  ).toBeVisible()
}

test(
  'keeps a correct short answer correct after saving and reopening history',
  async ({ page }) => {
    const historyRequests =
      await mockSupabase(page)
    await mockBackend(page)
    await logIn(page)

    await expect(
      page.getByRole('button', {
        name: /My Quiz History/,
      }),
    ).toContainText(
      'Open to load saved quizzes',
    )
    expect(
      historyRequests.getHistoryGetCount(),
    ).toBe(0)

    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'e2e-short-answer.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(
          '%PDF-1.4\n% Short-answer history E2E fixture\n',
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

    await page
      .locator('.setting-group')
      .filter({
        hasText: 'Question type',
      })
      .locator('select')
      .selectOption('short_answer')

    await page
      .getByRole('button', {
        name: 'Generate Quiz',
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: shortAnswerQuiz.title,
      }),
    ).toBeVisible()

    await page
      .locator('.short-answer-input')
      .fill('CBT IPT behavioural activation')

    await page
      .getByRole('button', {
        name: 'Check Answers',
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: '1 / 1 correct',
      }),
    ).toBeVisible()

    await expect(
      page
        .locator('.question-card')
        .getByText('Correct', {
          exact: true,
        }),
    ).toBeVisible()

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

    expect(
      historyRequests.getHistoryGetCount(),
    ).toBe(0)

    await page
      .getByRole('button', {
        name: /My Quiz History/,
      })
      .click()

    await expect(
      page
        .locator('.history-card')
        .getByRole('heading', {
          name: shortAnswerQuiz.title,
        }),
    ).toBeVisible()

    expect(
      historyRequests.getHistoryGetCount(),
    ).toBeGreaterThan(0)

    const shortAnswerPerformance =
      page
        .locator('.performance-row')
        .filter({
          hasText: 'Short Answer',
        })

    await expect(
      shortAnswerPerformance,
    ).toContainText('1 / 1')

    await expect(
      shortAnswerPerformance,
    ).toContainText('100%')

    await expect(
      page.getByText(
        'No weak areas detected for this PDF',
      ),
    ).toBeVisible()
  },
)
