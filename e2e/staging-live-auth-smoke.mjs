// Read-only browser acceptance on the REAL hosted staging site, after publication.
// No credentials, user identities, registration requests, mutation, or screenshots.
import { chromium } from '@playwright/test'

const origin = 'https://d1580ypiedc2c9.cloudfront.net'
const failures = []
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', () => failures.push('JavaScript startup error'))
  page.on('response', response => {
    if (response.url().startsWith(origin + '/assets/') && response.status() >= 400) {
      failures.push('Frontend asset HTTP ' + response.status())
    }
  })
  const home = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (home?.status() !== 200) failures.push('Homepage did not return HTTP 200')
  await page.getByRole('button', { name: 'Create account', exact: true }).waitFor({
    state: 'visible', timeout: 15000,
  }).catch(() => failures.push('Missing Create account button'))
  if (failures.length === 0) {
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    await page.getByRole('heading', { name: 'Create your account', exact: true }).waitFor({
      state: 'visible', timeout: 12000,
    }).catch(() => failures.push('Create account still redirects to hosted Cognito or does not render'))
    if (!page.url().startsWith(origin + '/')) failures.push('Registration unexpectedly left staging origin')
    if (await page.getByLabel('Confirm password').count() !== 1) {
      failures.push('Missing first-party registration form')
    }
    if (failures.length === 0) {
      const rules = page.getByRole('list', { name: 'Password requirements' })
      await rules.waitFor({ state: 'visible', timeout: 12000 })
        .catch(() => failures.push('Password requirement checklist is missing'))
      if (failures.length === 0) {
        if (await rules.locator('li').count() !== 6) failures.push('Expected six password requirements')
        await page.getByLabel('Password', { exact: true }).fill('Abcdef1!')
        try {
          await page.waitForFunction(() =>
            document.querySelectorAll('.signup-password-rules li[data-met="true"]').length === 6,
          null, { timeout: 5000 })
        } catch { failures.push('Live password checklist did not turn green when valid') }
      }
      if (failures.length === 0) {
        await page.getByRole('button', { name: 'Already registered? Sign in' }).click()
      }
      await page.getByRole('heading', { name: 'Sign in with email', exact: true }).waitFor({
        state: 'visible', timeout: 12000,
      }).catch(() => failures.push('App-owned email sign-in did not open'))
      if (!page.url().startsWith(origin + '/')) failures.push('Email sign-in left staging origin')
    }
  }
  if (failures.length) {
    console.error('FAIL: published staging signup browser acceptance: ' + failures.join('; '))
    process.exitCode = 1
  } else {
    console.log('PASS: live staging signup shows all six password checks and returns to app-owned sign in without hosted redirects.')
  }
} finally {
  await browser.close()
}
