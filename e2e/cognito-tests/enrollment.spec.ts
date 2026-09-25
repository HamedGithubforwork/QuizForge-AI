import { expect, test, type Page, type Route } from '@playwright/test'
import { createHash } from 'node:crypto'

const domain = 'https://quizforge-test.auth.ca-central-1.amazoncognito.com'
const subject = '00000000-0000-0000-0000-000000000101'
const jwt = (claims: object) => [Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'), 'test-signature'].join('.')

async function setup(page: Page, options: { badNonce?: boolean; badState?: boolean; staleState?: boolean; wrongIdentity?: boolean; enrolled?: boolean; unverified?: boolean; revokeFails?: boolean } = {}) {
  let authorize: URL
  let authorizationPath = ''
  let tokenCalls = 0
  let refreshCalls = 0
  let revoked = false
  let enrolled = Boolean(options.enrolled)
  let challengeCount = 0
  let confirmationCount = 0
  let mode = ''
  let historyCalls = 0
  const authenticatedAt = Math.floor(Date.now() / 1000)
  if (options.staleState) await page.addInitScript(() => {
    if (location.pathname === '/auth/callback') for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('quizforge.cognito.state.')) {
        const state = JSON.parse(sessionStorage.getItem(key)!)
        state.created = Math.floor(Date.now() / 1000) - 660
        sessionStorage.setItem(key, JSON.stringify(state))
      }
    }
  })
  const completeAuthorization = async (route: Route) => {
    authorize = new URL(route.request().url())
    authorizationPath = authorize.pathname
    expect(['/oauth2/authorize', '/signup']).toContain(authorizationPath)
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('nonce')).toBeTruthy()
    expect(authorize.searchParams.get('client_secret')).toBeNull()
    const callback = new URL(authorize.searchParams.get('redirect_uri')!)
    expect(callback.pathname).toBe('/auth/callback')
    callback.searchParams.set('code', 'synthetic-code')
    callback.searchParams.set('state', options.badState ? 'unmatched-state' : authorize.searchParams.get('state')!)
    await route.fulfill({ status: 302, headers: { location: callback.href } })
  }
  await page.route(domain + '/oauth2/authorize**', completeAuthorization)
  await page.route(domain + '/signup**', completeAuthorization)
  await page.route(domain + '/oauth2/token', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    const form = new URLSearchParams(route.request().postData()!)
    expect(form.get('client_id')).toBe('browserclient123')
    expect(form.has('client_secret')).toBe(false)
    if (form.get('grant_type') === 'authorization_code') {
      tokenCalls++
      expect(form.get('code')).toBe('synthetic-code')
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'))
    } else {
      expect(form.get('grant_type')).toBe('refresh_token'); refreshCalls++
      expect(form.get('refresh_token')).toBe('synthetic-refresh')
    }
    const now = Math.floor(Date.now() / 1000)
    await route.fulfill({ json: { access_token: refreshCalls ? 'synthetic-refreshed-access' : 'synthetic-access',
      refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 300,
      id_token: jwt({ sub: subject, email: 'cognito@example.invalid', iss: 'https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_BrowserTest',
        aud: 'browserclient123', exp: now + 300, iat: now, auth_time: authenticatedAt,
        nonce: options.badNonce ? 'wrong' : authorize.searchParams.get('nonce') }) },
      headers: { 'access-control-allow-origin': '*' } })
  })
  await page.route(domain + '/oauth2/revoke', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    expect(new URLSearchParams(route.request().postData()!).get('token')).toBe('synthetic-refresh')
    revoked = true
    await route.fulfill({ status: options.revokeFails ? 500 : 200, body: '', headers: { 'access-control-allow-origin': '*' } })
  })
  await page.route(domain + '/logout**', async route => {
    expect(new URL(route.request().url()).searchParams.get('logout_uri')).toBe('http://localhost:4174/')
    await route.fulfill({ status: 302, headers: { location: 'http://localhost:4174/' } })
  })
  await page.route('**/identity-mock/identity/**', async route => {
    expect(route.request().headers().authorization).toMatch(/^Bearer synthetic-/)
    const path = new URL(route.request().url()).pathname
    if (options.unverified) return route.fulfill({ status: 403, json: { detail: 'A verified email address is required.' } })
    if (path.endsWith('/session')) return route.fulfill({ json: { enrolled, id: options.wrongIdentity ? 'other-user' : `cognito:ca-central-1_BrowserTest:${subject}`, email: 'cognito@example.invalid' } })
    const data = route.request().postDataJSON()
    expect(data.user_id).toBeUndefined()
    if (path.endsWith('/challenge')) {
      challengeCount++; mode = data.mode
      if (mode === 'link') expect(route.request().headers()['x-legacy-authorization']).toBe('Bearer synthetic-legacy')
      else expect(route.request().headers()['x-legacy-authorization']).toBeUndefined()
      return route.fulfill({ json: { nonce: 'n'.repeat(43), expires_in: 300 } })
    }
    expect(path).toMatch(/\/confirm$/)
    expect(data).toEqual({ mode, nonce: 'n'.repeat(43) })
    if (mode === 'link') expect(route.request().headers()['x-legacy-authorization']).toBe('Bearer synthetic-legacy')
    confirmationCount++; enrolled = true
    await route.fulfill({ status: 204 })
  })
  const user = { id: 'legacy-user', email: 'legacy@example.invalid', aud: 'authenticated',
    app_metadata: {}, user_metadata: {}, created_at: '2026-01-01', factors: [] }
  await page.route('**/supabase-mock/auth/v1/token**', route => route.fulfill({ json: {
    access_token: 'synthetic-legacy', refresh_token: 'synthetic-legacy-refresh', token_type: 'bearer', expires_in: 300, user } }))
  await page.route('**/supabase-mock/auth/v1/user', route => route.fulfill({ json: user }))
  await page.route('**/api-mock/api/quiz-history**', async route => {
    historyCalls++
    if (route.request().headers().authorization === 'Bearer synthetic-access') return route.fulfill({ status: 401, json: { detail: 'expired' } })
    expect(route.request().headers().authorization).toBe('Bearer synthetic-refreshed-access')
    await route.fulfill({ json: { items: [], totalCount: 0, hasMore: false, nextCursor: null } })
  })
  return { counts: () => ({ authorizationPath, tokenCalls, refreshCalls, revoked, challengeCount, confirmationCount, historyCalls }) }
}

async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

async function createAccount(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
}

test('PKCE callback enrolls only after confirmation, refreshes bearer and revokes on logout', async ({ page }) => {
  const state = await setup(page)
  await login(page)
  expect(state.counts().authorizationPath).toBe('/oauth2/authorize')
  await expect(page.getByRole('heading', { name: 'Set up your staging account' })).toBeVisible()
  expect(page.url()).toBe('http://localhost:4174/')
  await page.getByLabel('Account setup', { exact: true }).selectOption('enroll')
  await page.getByRole('button', { name: 'Continue account setup' }).click()
  await expect(page.getByText('Create a separate account with empty history?', { exact: false })).toBeVisible()
  expect(state.counts().confirmationCount).toBe(0)
  await page.getByRole('button', { name: 'Confirm account setup' }).click()
  await expect(page.getByText('Signed in as cognito@example.invalid')).toBeVisible()
  await page.getByRole('button', { name: 'My Quiz History', exact: false }).click()
  await expect.poll(() => state.counts().historyCalls).toBeGreaterThan(0)
  await expect(page.getByText('No saved quizzes yet')).toBeVisible()
  expect(state.counts().refreshCalls).toBe(1)
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(JSON.stringify(storage)).not.toMatch(/synthetic-(access|refresh|legacy)|code_verifier|synthetic-code/)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  expect(state.counts().revoked).toBe(true)
  expect(state.counts().confirmationCount).toBe(1)
})

test('create account starts at the dedicated Cognito signup endpoint with PKCE', async ({ page }) => {
  const state = await setup(page)
  await createAccount(page)
  expect(state.counts().authorizationPath).toBe('/signup')
  await expect(page.getByRole('heading', { name: 'Set up your staging account' })).toBeVisible()
  expect(state.counts().tokenCalls).toBe(1)
})

test('existing history linking sends fresh dual proof without storing legacy session', async ({ page }) => {
  const state = await setup(page)
  await login(page)
  await page.getByLabel('Existing account email').fill('legacy@example.invalid')
  await page.getByLabel('Existing account password').fill('synthetic-test-password')
  await page.getByRole('button', { name: 'Continue account setup' }).click()
  await expect(page.getByText('Link this Cognito account', { exact: false })).toBeVisible()
  expect(state.counts().confirmationCount).toBe(0)
  await page.getByRole('button', { name: 'Confirm account setup' }).click()
  await expect(page.getByText('Signed in as cognito@example.invalid')).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
})

for (const option of ['badState', 'badNonce', 'staleState', 'wrongIdentity', 'unverified'] as const) {
  test(`rejects ${option} before account enrollment`, async ({ page }) => {
    const state = await setup(page, { [option]: true })
    await login(page)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Set up your staging account' })).toHaveCount(0)
    expect(state.counts().challengeCount).toBe(0)
    expect(page.url()).not.toContain('code=')
    if (option === 'badState' || option === 'staleState') expect(state.counts().tokenCalls).toBe(0)
  })
}

test('revocation failure clears local account and reports the failure', async ({ page }) => {
  await setup(page, { enrolled: true, revokeFails: true })
  await login(page)
  await expect(page.getByText('Signed in as cognito@example.invalid')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('session revocation failed')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
