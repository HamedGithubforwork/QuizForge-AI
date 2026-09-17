import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://localhost:4174'
export default defineConfig({
  testDir: './cognito-tests', fullyParallel: false, workers: 1, forbidOnly: Boolean(process.env.CI),
  retries: 0, reporter: 'list',
  // Never record tokens/passwords in network traces, screenshots or videos.
  use: { baseURL, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm --prefix ../frontend run dev -- --host localhost --port 4174', url: baseURL,
    reuseExistingServer: false, timeout: 120_000,
    env: { ...process.env, VITE_AUTH_PROVIDER: 'cognito', VITE_COGNITO_STAGING: 'true',
      VITE_COGNITO_USER_POOL_ID: 'ca-central-1_BrowserTest', VITE_COGNITO_CLIENT_ID: 'browserclient123',
      VITE_COGNITO_DOMAIN: 'https://quizforge-test.auth.ca-central-1.amazoncognito.com',
      VITE_API_URL: baseURL + '/api-mock', VITE_IDENTITY_API_URL: baseURL + '/identity-mock',
      VITE_SUPABASE_URL: baseURL + '/supabase-mock', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable' },
  },
})
