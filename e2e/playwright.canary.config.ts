import {
  defineConfig,
  devices,
} from '@playwright/test'

export default defineConfig({
  testDir: './canary-tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'html',
          {
            open: 'never',
            outputFolder:
              'playwright-canary-report',
          },
        ],
      ]
    : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-deployed-canary',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
