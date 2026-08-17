import {
  expect,
  test,
  type Page,
} from '@playwright/test'

const TEST_EMAIL = 'student@example.com'
const TEST_PASSWORD = 'correct-password'
const TEST_USER_ID = 'e2e-user-id'
const ACCESS_TOKEN = 'e2e-access-token'

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
      Math.floor(Date.now() / 1000) +
      3600,
    refresh_token: 'e2e-refresh-token',
    user: buildUser(),
  }
}

async function mockSupabase(
  page: Page,
  options: {
    validLogin?: boolean
  } = {},
) {
  const historyRows: Record<
    string,
    unknown
  >[] = []

  await page.route(
    '**/supabase-mock/auth/v1/token**',
    async (route) => {
      if (options.validLogin === false) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'invalid_credentials',
            message:
              'Invalid login credentials',
          }),
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          buildSession(),
        ),
      })
    },
  )

  await page.route(
    '**/supabase-mock/auth/v1/user',
    async (route) => {
      expect(
        route.request().headers()[
          'authorization'
        ],
      ).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      )

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          buildUser(),
        ),
      })
    },
  )

  await page.route(
    '**/supabase-mock/rest/v1/quiz_history**',
    async (route) => {
      const request = route.request()

      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            historyRows,
          ),
        })
        return
      }

      if (request.method() === 'POST') {
        const rawPayload =
          request.postDataJSON() as
            | Record<string, unknown>
            | Record<string, unknown>[]

        const payload = Array.isArray(
          rawPayload,
        )
          ? rawPayload[0]
          : rawPayload

        historyRows.unshift({
          ...payload,
          id: `history-${historyRows.length + 1}`,
          created_at:
            new Date().toISOString(),
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

  return historyRows
}

const firstQuiz = {
  title: 'E2E Networking Basics',
  questions: [
    {
      question_type:
        'multiple_choice',
      question:
        'Which protocol provides reliable ordered delivery?',
      choices: [
        'TCP',
        'UDP',
        'ARP',
        'ICMP',
      ],
      correct_index: 0,
      correct_answer: 'TCP',
      accepted_answers: ['TCP'],
      grading: {
        grading_version: 2,
        grading_mode: 'none',
        answer_groups: [],
        required_group_count: 0,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'TCP provides reliable, ordered delivery.',
      source_pages: [1],
    },
    {
      question_type:
        'multiple_choice',
      question:
        'Which protocol is connectionless?',
      choices: [
        'UDP',
        'TCP',
        'SSH',
        'TLS',
      ],
      correct_index: 0,
      correct_answer: 'UDP',
      accepted_answers: ['UDP'],
      grading: {
        grading_version: 2,
        grading_mode: 'none',
        answer_groups: [],
        required_group_count: 0,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'UDP is a connectionless transport protocol.',
      source_pages: [1],
    },
    {
      question_type:
        'multiple_choice',
      question:
        'Which protocol maps IPv4 addresses to MAC addresses?',
      choices: [
        'ARP',
        'DNS',
        'HTTP',
        'FTP',
      ],
      correct_index: 0,
      correct_answer: 'ARP',
      accepted_answers: ['ARP'],
      grading: {
        grading_version: 2,
        grading_mode: 'none',
        answer_groups: [],
        required_group_count: 0,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'ARP resolves an IPv4 address to a link-layer address.',
      source_pages: [2],
    },
    {
      question_type:
        'multiple_choice',
      question:
        'Which protocol resolves host names to IP addresses?',
      choices: [
        'DNS',
        'ARP',
        'ICMP',
        'SSH',
      ],
      correct_index: 0,
      correct_answer: 'DNS',
      accepted_answers: ['DNS'],
      grading: {
        grading_version: 2,
        grading_mode: 'none',
        answer_groups: [],
        required_group_count: 0,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'DNS resolves names to network addresses.',
      source_pages: [2],
    },
    {
      question_type:
        'multiple_choice',
      question:
        'Which protocol is commonly used for web requests?',
      choices: [
        'HTTP',
        'ARP',
        'ICMP',
        'NTP',
      ],
      correct_index: 0,
      correct_answer: 'HTTP',
      accepted_answers: ['HTTP'],
      grading: {
        grading_version: 2,
        grading_mode: 'none',
        answer_groups: [],
        required_group_count: 0,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'HTTP is used for web requests and responses.',
      source_pages: [2],
    },
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

async function mockBackend(
  page: Page,
) {
  let generationCount = 0

  await page.route(
    '**/api-mock/api/documents/upload',
    async (route) => {
      expect(
        route.request().headers()[
          'authorization'
        ],
      ).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      )

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          filename: 'e2e-notes.pdf',
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
              text:
                'TCP provides reliable ordered delivery. UDP is a connectionless transport protocol.',
            },
            {
              page_number: 2,
              character_count: 780,
              preview:
                'ARP maps IPv4 addresses to MAC addresses. DNS resolves host names.',
              text:
                'ARP maps IPv4 addresses to MAC addresses. DNS resolves host names to IP addresses. HTTP is used for web requests.',
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
        route.request().headers()[
          'authorization'
        ],
      ).toBe(
        `Bearer ${ACCESS_TOKEN}`,
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

  return () => generationCount
}

async function logIn(page: Page) {
  await page.goto('/')

  await page
    .getByLabel('Email')
    .fill(TEST_EMAIL)

  await page
    .getByLabel('Password')
    .fill(TEST_PASSWORD)

  await page
    .getByRole('button', {
      name: 'Log In',
    })
    .click()

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
    const getGenerationCount =
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
      page.getByText(
        'PDF processed successfully',
      ),
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

    const cards =
      page.locator('.question-card')

    await cards
      .nth(0)
      .getByText('UDP', {
        exact: true,
      })
      .click()

    await cards
      .nth(1)
      .getByText('UDP', {
        exact: true,
      })
      .click()

    await cards
      .nth(2)
      .getByText('ARP', {
        exact: true,
      })
      .click()

    await cards
      .nth(3)
      .getByText('DNS', {
        exact: true,
      })
      .click()

    await cards
      .nth(4)
      .getByText('HTTP', {
        exact: true,
      })
      .click()

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
          'TCP provides reliable ordered delivery. UDP is a connectionless transport protocol.',
        ),
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

    await expect(
      page.getByText('1 saved quiz'),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: /My Quiz History/,
      })
      .click()

    await expect(
      page.locator('.history-content')
        .getByText(firstQuiz.title),
    ).toBeVisible()

    await page
      .getByRole('button', {
        name: 'Practice Weak Areas',
      })
      .click()

    await expect(
      page.getByText(
        'Weak Areas Practice',
      ),
    ).toBeVisible()

    await expect(
      page.getByText(
        'Targeted practice',
      ),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', {
        name: practiceQuiz.title,
      }),
    ).toBeVisible()

    expect(
      getGenerationCount(),
    ).toBe(2)
  },
)

test(
  'shows an authentication error for invalid credentials',
  async ({ page }) => {
    await mockSupabase(
      page,
      {
        validLogin: false,
      },
    )

    await page.goto('/')

    await page
      .getByLabel('Email')
      .fill(TEST_EMAIL)

    await page
      .getByLabel('Password')
      .fill('wrong-password')

    await page
      .getByRole('button', {
        name: 'Log In',
      })
      .click()

    await expect(
      page.getByText(
        'Invalid login credentials',
      ),
    ).toBeVisible()
  },
)
