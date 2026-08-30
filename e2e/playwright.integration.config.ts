import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4174'
const supabaseUrl =
  process.env.INTEGRATION_SUPABASE_URL ||
  'http://127.0.0.1:54321'
const supabasePublishableKey =
  process.env.INTEGRATION_SUPABASE_PUBLISHABLE_KEY ||
  ''
const apiUrl =
  process.env.INTEGRATION_API_URL ||
  'http://127.0.0.1:8000'

if (!supabasePublishableKey) {
  throw new Error(
    'INTEGRATION_SUPABASE_PUBLISHABLE_KEY is required for local-stack integration tests.',
  )
}

export default defineConfig({
  testDir: './integration-tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-integration-report' }]]
    : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-local-stack',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command:
      'npm --prefix ../frontend run dev -- --host 127.0.0.1 --port 4174',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY:
        supabasePublishableKey,
      VITE_API_URL: apiUrl,
    },
  },
})
