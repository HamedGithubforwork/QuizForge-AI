import {
  expect,
  type Page,
} from '@playwright/test'

const MISSING_DOCUMENT_SHA = '0'.repeat(64)

export type AuthenticatedCanaryOptions = {
  page: Page
  frontendUrl: string
  backendUrl: string
  email: string
  password: string
}

type BrowserFetchResult = {
  status: number
  body: unknown
}

async function readSupabaseAccessToken(
  page: Page,
) {
  return page.evaluate(() => {
    const findAccessToken = (
      value: unknown,
    ): string | null => {
      if (
        value &&
        typeof value === 'object' &&
        'access_token' in value &&
        typeof (
          value as {
            access_token?: unknown
          }
        ).access_token === 'string'
      ) {
        return (
          value as {
            access_token: string
          }
        ).access_token
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const nestedToken =
            findAccessToken(item)

          if (nestedToken) {
            return nestedToken
          }
        }
      }

      if (
        value &&
        typeof value === 'object'
      ) {
        for (
          const nestedValue of Object.values(
            value,
          )
        ) {
          const nestedToken =
            findAccessToken(nestedValue)

          if (nestedToken) {
            return nestedToken
          }
        }
      }

      return null
    }

    for (
      let index = 0;
      index < localStorage.length;
      index += 1
    ) {
      const key = localStorage.key(index)

      if (!key) {
        continue
      }

      const rawValue =
        localStorage.getItem(key)

      if (!rawValue) {
        continue
      }

      try {
        const parsedValue =
          JSON.parse(rawValue)
        const accessToken =
          findAccessToken(parsedValue)

        if (accessToken) {
          return accessToken
        }
      } catch {
        // Ignore unrelated local-storage entries.
      }
    }

    return null
  })
}

async function fetchProtectedSourceFromBrowser(
  page: Page,
  backendUrl: string,
  accessToken: string,
): Promise<BrowserFetchResult> {
  const sourceUrl =
    `${backendUrl.replace(/\/$/, '')}` +
    `/api/documents/${MISSING_DOCUMENT_SHA}` +
    '/pages/1'

  return page.evaluate(
    async ({ url, token }) => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      let body: unknown = null

      try {
        body = await response.json()
      } catch {
        body = null
      }

      return {
        status: response.status,
        body,
      }
    },
    {
      url: sourceUrl,
      token: accessToken,
    },
  )
}

export async function expectAuthenticatedDeploymentBoundary(
  options: AuthenticatedCanaryOptions,
) {
  const {
    page,
    frontendUrl,
    backendUrl,
    email,
    password,
  } = options

  expect(
    email.length,
    'A dedicated canary email must be configured.',
  ).toBeGreaterThan(0)
  expect(
    password.length,
    'A dedicated canary password must be configured.',
  ).toBeGreaterThan(0)

  await page.goto(frontendUrl)

  await expect(
    page.getByRole('heading', {
      name: 'Welcome back',
    }),
  ).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(
    password,
  )
  await page
    .locator('form')
    .getByRole('button', {
      name: 'Log In',
    })
    .click()

  await expect(
    page.getByText(email, {
      exact: true,
    }),
  ).toBeVisible()

  const accessToken =
    await readSupabaseAccessToken(page)

  expect(
    accessToken,
    'The authenticated browser session did not expose a Supabase access token.',
  ).toBeTruthy()

  const protectedResponse =
    await fetchProtectedSourceFromBrowser(
      page,
      backendUrl,
      accessToken!,
    )

  expect(protectedResponse.status).toBe(410)
  expect(protectedResponse.body).toEqual(
    expect.objectContaining({
      detail: expect.stringContaining(
        'Processed document expired or is unavailable.',
      ),
    }),
  )
}
