import { chromium } from '@playwright/test'
const origin = 'https://d1580ypiedc2c9.cloudfront.net'
const failures = []
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', error => {
    const value = error.message.replace(/Bearer\s+[^\s]+/gi, '[redacted]')
      .replace(/([?&](?:code|token|state|password|secret)=[^&\s]+)/gi,'[redacted]')
    failures.push('SCRIPT_ERROR: ' + value.slice(0,280))
  })
  page.on('response', response => {
    if (response.url().startsWith(origin + '/assets/') && response.status() >= 400) {
      const name = new URL(response.url()).pathname.split('/').pop()
      failures.push('ASSET_STATUS: ' + response.status() + ' ' + name)
    }
  })
  let response
  try {
    response = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)
  } catch (error) {
    failures.push('NAVIGATION: ' + String(error).slice(0,160))
  }
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0,250)
  const headings = await page.locator('h1,h2,[role="status"]').allTextContents().catch(() => [])
  console.log('STAGING_BROWSER http=' + (response?.status() ?? 'none') + ' app_headings=' + JSON.stringify(headings).slice(0,240) + ' visible_text=' + JSON.stringify(body).slice(0,250))
  for(const error of failures.slice(0,5)) console.log(error)
  if (!body.trim() || failures.length) throw new Error('Staging live frontend did not render correctly.')
  console.log('PASS: anonymous staging landing page rendered in a real browser.')
} finally {
  await browser.close()
}
