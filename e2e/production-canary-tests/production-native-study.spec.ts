import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { currentTotp, readCanaryFixture, signInAndEnrollCanary } from './canary-fixture'

// This Linux/Chromium canary exercises the exact pinned main-process auth/API
// modules against production. Real Windows preload/installer checks run separately.
test('native PKCE identity, saved deck, review and sign-out without model calls', async ({ page, browser }) => {
  const fixture = readCanaryFixture()
  await page.route('https://api.quizfromnotes.com/api/**', route => route.abort('blockedbyclient'))
  await signInAndEnrollCanary(page, fixture)
  const require = createRequire(resolve('package.json'))
  const root = resolve('application-candidate/desktop')
  const config = require(root + '/src/native-runtime.json')
  const { createNativeAuthClient } = require(root + '/src/native-auth-client.cjs')
  const { createNativeSession } = require(root + '/src/native-session.cjs')
  const { createNativeAccount } = require(root + '/src/native-account.cjs')
  const context = await browser.newContext()
  const authPage = await context.newPage()
  const client = await createNativeAuthClient(config)
  const session = createNativeSession({ clientId: config.clientId, client,
    openBrowser: (url: string) => { void authPage.goto(url).catch(() => {}) } })
  const account = createNativeAccount({ session, fetch: (url: string, init: RequestInit) => {
    const target = new URL(url)
    if (target.origin !== 'https://api.quizfromnotes.com' ||
        !(target.pathname === '/identity/session' || target.pathname.startsWith('/api/decks') ||
          ['/api/study-notifications/preferences','/api/study-analytics/summary'].includes(target.pathname)))
      throw new Error('Non-study canary request blocked')
    return fetch(url, init)
  } })
  let deckId: string | undefined
  authPage.on('response', response => {
    // Capture the registered native redirect in memory; no traces, screenshots,
    // callback URLs, tokens or raw provider error text are written to artifacts.
    void response.headerValue('location').then(location => {
      if (location?.startsWith('com.quizfromnotes.desktop.preview:/oauth/callback'))
        return session.handleCallback(location)
    }).catch(() => {})
  })
  const request = async (path: string, method = 'GET', body?: object) => {
    const result = await account.request({path, method, ...(body ? {body:JSON.stringify(body)} : {})})
    if (result.status < 200 || result.status >= 300) throw new Error('Native study API smoke failed')
    return result.body ? JSON.parse(result.body) : null
  }
  try {
    const signingIn = session.signIn()
    // Attach rejection handling immediately while UI steps are in progress.
    void signingIn.catch(() => {})
    await authPage.locator('input[name="username"]:visible').fill(fixture.email)
    await authPage.locator('input[name="password"]:visible').fill(fixture.password)
    await authPage.locator('input[name="signInSubmitButton"]:visible,button[name="signInSubmitButton"]:visible').click()
    const totp = authPage.locator('input[name="authentication_code"][id="totpCodeInput"]:visible')
    await totp.waitFor({state:'visible'})
    await authPage.waitForTimeout(31_000 - (Date.now() % 30_000))
    await totp.fill(currentTotp(fixture.totp))
    await authPage.locator('input[type="submit"]:visible,button[type="submit"]:visible').click()
    await signingIn
    const identity = await account.verify()
    expect(identity.enrolled).toBe(true)
    expect(identity.email === fixture.email).toBe(true)
    const deck = await request('/api/decks','POST',{name:'Native production canary',description:'Synthetic manual study acceptance',cards:[]})
    if (typeof deck.id !== 'string' || !/^[a-f0-9-]{36}$/.test(deck.id)) throw new Error('Invalid synthetic deck response')
    deckId=deck.id
    await request(`/api/decks/${deckId}/cards`,'POST',{cards:[{question_type:'short_answer',question:'Which protocol protects HTTP?',answer:{correct_answer:'TLS'},choices:[],source_pages:[],tags:[]}]})
    const queue = await request(`/api/decks/${deckId}/review?limit=20`)
    expect(queue.cards.length).toBe(1)
    const review = await request(`/api/decks/${deckId}/review`,'POST',{card_id:queue.cards[0].id,rating:3,review_duration_ms:1000})
    expect(review.remaining_due_count).toBe(0)
    await request('/api/study-notifications/preferences')
    await request('/api/study-analytics/summary')
    expect(Boolean(await session.session(true))).toBe(true)
  } catch {
    throw new Error('Native production study acceptance failed; no private provider details retained.')
  } finally {
    try { if (deckId) await request(`/api/decks/${deckId}`,'DELETE') }
    finally { account.clear(); await session.signOut(); await context.close() }
  }
  expect(account.current()).toBeNull()
  await expect(account.request({path:'/api/decks'})).rejects.toThrow()
})
