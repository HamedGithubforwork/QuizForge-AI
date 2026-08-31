import { test } from '@playwright/test'

import {
  expectAuthenticatedDeploymentBoundary,
} from '../support/authenticatedCanary'

const frontendUrl =
  process.env.CANARY_FRONTEND_URL ||
  'https://quiz-forge-ai-nine.vercel.app'
const backendUrl =
  process.env.CANARY_BACKEND_URL ||
  'https://quizforge-ai-api.onrender.com'
const email =
  process.env.QUIZFORGE_CANARY_EMAIL || ''
const password =
  process.env.QUIZFORGE_CANARY_PASSWORD || ''

test(
  'deployed browser session is accepted by the protected backend',
  async ({ page }) => {
    test.setTimeout(90_000)

    await expectAuthenticatedDeploymentBoundary({
      page,
      frontendUrl,
      backendUrl,
      email,
      password,
    })
  },
)
