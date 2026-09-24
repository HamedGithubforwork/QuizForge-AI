import {
  defineConfig,
  devices,
} from '@playwright/test'

export default defineConfig({
  testDir: './production-canary-tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 240_000,
  reporter: 'list',
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-production-canary',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
