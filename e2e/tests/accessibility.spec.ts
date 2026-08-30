import {
  expect,
  test,
  type Page,
} from '@playwright/test'

const TEST_EMAIL = 'student@example.com'
const TEST_PASSWORD = 'correct-password'
const TEST_USER_ID = 'accessibility-user-id'
const ACCESS_TOKEN = 'accessibility-access-token'

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
    refresh_token: 'accessibility-refresh-token',
    user: buildUser(),
  }
}

async function mockLogin(page: Page) {
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
    '**/supabase-mock/rest/v1/quiz_history**',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Content-Range': '0-0/0',
        },
        body: '[]',
      })
    },
  )
}

test(
  'auth controls expose labels and live error feedback',
  async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByRole('heading', {
        name: 'QuizForge AI',
        level: 1,
      }),
    ).toBeVisible()

    await expect(
      page.getByLabel('Email'),
    ).toBeVisible()

    await expect(
      page.getByLabel('Password'),
    ).toBeVisible()

    await expect(
      page.getByRole('button', {
        name: 'Log In',
        pressed: true,
      }),
    ).toBeVisible()

    await page
      .locator('form')
      .getByRole('button', {
        name: 'Log In',
      })
      .click()

    await expect(
      page.getByRole('alert'),
    ).toHaveText('Enter your email address.')
  },
)

test(
  'signed-in PDF upload control has an accessible name',
  async ({ page }) => {
    await mockLogin(page)
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
      page.getByText('Signed in as'),
    ).toBeVisible()

    await expect(
      page.getByLabel('Study material PDF'),
    ).toBeVisible()
  },
)
