import {
  expect,
  test,
  type Page,
} from '@playwright/test'


const TEST_EMAIL = 'source-cache@example.com'
const TEST_PASSWORD = 'correct-password'
const TEST_USER_ID = 'source-cache-user'
const ACCESS_TOKEN = 'source-cache-access-token'
const DOCUMENT_SHA256 = 'b'.repeat(64)
const SOURCE_TEXT = (
  'TCP provides reliable ordered delivery from the cached source page.'
)


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
    refresh_token: 'source-cache-refresh-token',
    user: buildUser(),
  }
}


async function mockSupabase(page: Page) {
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildUser()),
      })
    },
  )
}


async function mockBackend(page: Page) {
  let sourceRequestCount = 0

  await page.route(
    '**/api-mock/api/documents/upload',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          filename: 'source-cache.pdf',
          pdf_sha256: DOCUMENT_SHA256,
          page_count: 1,
          character_count: SOURCE_TEXT.length,
          extractable_page_count: 1,
          scanned_likely: false,
          warning: null,
          pages: [
            {
              page_number: 1,
              character_count: SOURCE_TEXT.length,
              preview: SOURCE_TEXT,
            },
          ],
        }),
      })
    },
  )

  await page.route(
    '**/api-mock/api/quizzes/generate',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          title: 'Source Cache Quiz',
          questions: [
            {
              question_type: 'multiple_choice',
              question: 'Which protocol provides reliable delivery?',
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
              explanation: (
                'TCP provides reliable delivery.'
              ),
              source_pages: [1],
            },
          ],
        }),
      })
    },
  )

  await page.route(
    '**/api-mock/api/documents/*/pages/1',
    async (route) => {
      sourceRequestCount += 1

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pdf_sha256: DOCUMENT_SHA256,
          page_number: 1,
          text: SOURCE_TEXT,
        }),
      })
    },
  )

  return {
    getSourceRequestCount: () =>
      sourceRequestCount,
  }
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
  'reopening a source page reuses the account-scoped cache',
  async ({ page }) => {
    await mockSupabase(page)
    const backend = await mockBackend(page)
    await logIn(page)

    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'source-cache.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(
          '%PDF-1.4\n% source cache fixture\n',
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

    await page
      .getByRole('button', {
        name: 'Generate Quiz',
      })
      .click()

    await expect(
      page.getByRole('heading', {
        name: 'Source Cache Quiz',
      }),
    ).toBeVisible()

    const card = page.locator(
      '.question-card',
    )

    await card
      .getByText('TCP', {
        exact: true,
      })
      .click()

    await page
      .getByRole('button', {
        name: 'Check Answers',
      })
      .click()

    expect(
      backend.getSourceRequestCount(),
    ).toBe(0)

    await card
      .getByRole('button', {
        name: 'View Source',
      })
      .click()

    await expect(
      card.getByText(SOURCE_TEXT),
    ).toBeVisible()

    expect(
      backend.getSourceRequestCount(),
    ).toBe(1)

    await card
      .getByRole('button', {
        name: 'Hide Source',
      })
      .click()

    await card
      .getByRole('button', {
        name: 'View Source',
      })
      .click()

    await expect(
      card.getByText(SOURCE_TEXT),
    ).toBeVisible()

    expect(
      backend.getSourceRequestCount(),
    ).toBe(1)
  },
)
