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
      await page.getByRole('button', { name: 'Back to sign in options' }).click()
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
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
    console.log('PASS: hosted staging renders app-owned signup and email login without Cognito hosted-page redirect.')
  }
} finally {
  await browser.close()
}
