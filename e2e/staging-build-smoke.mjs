// This runs BEFORE any staging S3 publication, against a credentialless local
// server of the exact built assets. A green npm build alone does not prove
// React/Cognito initialization succeeds in a real browser.
import { chromium } from '@playwright/test'

const origin = 'http://127.0.0.1:4179'
const failures = []
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', error => {
    // No private network, user or account credentials in this smoke test.
    // Do not reveal source or full JavaScript traces in logs.
    failures.push('JavaScript startup error: ' + error.name)
  })
  page.on('response', response => {
    if (response.url().startsWith(origin + '/assets/') && response.status() >= 400) {
      failures.push('Asset HTTP error: ' + response.status())
    }
  })
  const response = await page.goto(origin + '/', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  })
  const login = page.getByRole('button', { name: 'Sign in', exact: true })
  await login.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {
    failures.push('Public staging sign-in button did not render')
  })
  if (response?.status() !== 200) failures.push('Homepage HTTP status not 200')
  if (failures.length) {
    console.error('FAIL: staging frontend could not initialize safely: ' + failures.join('; '))
    process.exitCode = 1
  } else {
    console.log('PASS: exact staging build renders real public Cognito login in Chromium.')
  }
} finally {
  await browser.close()
}
