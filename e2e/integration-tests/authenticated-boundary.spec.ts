import { test } from '@playwright/test'

import {
  expectAuthenticatedDeploymentBoundary,
} from '../support/authenticatedCanary'

const frontendUrl = 'http://127.0.0.1:4174'
const backendUrl =
  process.env.INTEGRATION_API_URL ||
  'http://127.0.0.1:8000'
const email =
  process.env.INTEGRATION_TEST_EMAIL ||
  'quizforge-integration@example.com'
const password =
  process.env.INTEGRATION_TEST_PASSWORD ||
  'Integration123!'

test(
  'authenticated browser session crosses the real local backend boundary',
  async ({ page }) => {
    test.setTimeout(60_000)

    await expectAuthenticatedDeploymentBoundary({
      page,
      frontendUrl,
      backendUrl,
      email,
      password,
    })
  },
)
