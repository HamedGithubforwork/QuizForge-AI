import {
  defineConfig,
  devices,
} from '@playwright/test'

const mode = process.env.CANARY_MODE || 'study'
if (!['study', 'native_study', 'paid_quiz'].includes(mode)) {
  throw new Error('Unknown production canary mode')
}

export default defineConfig({
  testDir: './production-canary-tests',
  testMatch: mode === 'native_study' ? 'production-native-study.spec.ts' : mode === 'study' ? 'production-study.spec.ts' : 'production-quiz.spec.ts',
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
