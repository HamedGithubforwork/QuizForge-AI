import { expect, test, type Page, type Route } from '@playwright/test'
import { createHash } from 'node:crypto'

const domain = 'https://quizforge-test.auth.ca-central-1.amazoncognito.com'
const subject = '00000000-0000-0000-0000-000000000101'
const jwt = (claims: object) => [Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'), 'test-signature'].join('.')

async function setup(page: Page, options: { badNonce?: boolean; badState?: boolean; staleState?: boolean; wrongIdentity?: boolean; enrolled?: boolean; unverified?: boolean; revokeFails?: boolean; googleExistingLink?: boolean } = {}) {
  let authorize: URL
  let authorizationPath = ''
  let googleProvider = false
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
    googleProvider = authorize.searchParams.get('identity_provider') === 'Google'
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
      if (mode === 'link' && options.googleExistingLink) {
        expect(route.request().headers()['x-cognito-link-authorization']).toBe('Bearer synthetic-cognito-local')
        expect(route.request().headers()['x-legacy-authorization']).toBeUndefined()
      } else if (mode === 'link') {
        expect(route.request().headers()['x-legacy-authorization']).toBe('Bearer synthetic-legacy')
      } else {
        expect(route.request().headers()['x-legacy-authorization']).toBeUndefined()
      }
      return route.fulfill({ json: { nonce: 'n'.repeat(43), expires_in: 300 } })
    }
    expect(path).toMatch(/\/confirm$/)
    expect(data).toEqual({ mode, nonce: 'n'.repeat(43) })
    if (mode === 'link' && options.googleExistingLink) {
      expect(route.request().headers()['x-cognito-link-authorization']).toBe('Bearer synthetic-cognito-local')
      expect(route.request().headers()['x-legacy-authorization']).toBeUndefined()
    } else if (mode === 'link') {
      expect(route.request().headers()['x-legacy-authorization']).toBe('Bearer synthetic-legacy')
    }
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
  return { counts: () => ({ authorizationPath, googleProvider, tokenCalls, refreshCalls, revoked, challengeCount, confirmationCount, historyCalls }) }
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

test('Google login links an existing Cognito account only after password and MFA verification', async ({ page }) => {
  const state = await setup(page, { googleExistingLink: true })
  let directAuthCalls = 0
  let mfaCalls = 0
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  await page.route('https://cognito-idp.ca-central-1.amazonaws.com/', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const target = route.request().headers()['x-amz-target']
    const body = route.request().postDataJSON()
    if (target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
      directAuthCalls++
      expect(body.AuthFlow).toBe('USER_PASSWORD_AUTH')
      expect(body.AuthParameters).toEqual({ USERNAME: 'existing@example.invalid', PASSWORD: 'synthetic-test-password' })
      return route.fulfill({ json: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'mfa-session',
        ChallengeParameters: { USERNAME: 'existing@example.invalid' } }, headers: cors })
    }
    if (target === 'AWSCognitoIdentityProviderService.RespondToAuthChallenge') {
      mfaCalls++
      expect(body.ChallengeName).toBe('SOFTWARE_TOKEN_MFA')
      expect(body.Session).toBe('mfa-session')
      expect(body.ChallengeResponses).toEqual({ USERNAME: 'existing@example.invalid', SOFTWARE_TOKEN_MFA_CODE: '123456' })
      return route.fulfill({ json: { AuthenticationResult: { AccessToken: 'synthetic-cognito-local' } }, headers: cors })
    }
    throw new Error('Unexpected direct Cognito request')
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your staging account' })).toBeVisible()
  expect(state.counts().googleProvider).toBe(true)
  await page.getByLabel('Account setup', { exact: true }).selectOption('link-cognito')
  await page.getByLabel('Existing Quiz From Notes email').fill('existing@example.invalid')
  await page.getByLabel('Existing Quiz From Notes password').fill('synthetic-test-password')
  await page.getByRole('button', { name: 'Continue account setup' }).click()
  await expect(page.getByText('Confirm ownership of your existing Quiz From Notes account')).toBeVisible()
  expect(state.counts().challengeCount).toBe(0)
  await page.getByLabel('Existing-account verification code').fill('123456')
  await page.getByRole('button', { name: 'Verify existing account' }).click()
  await expect(page.getByText('Link this Cognito account', { exact: false })).toBeVisible()
  expect(state.counts().challengeCount).toBe(1)
  await page.getByRole('button', { name: 'Confirm account setup' }).click()
  await expect(page.getByText('Signed in as cognito@example.invalid')).toBeVisible()
  expect(state.counts().confirmationCount).toBe(1)
  expect(directAuthCalls).toBe(1)
  expect(mfaCalls).toBe(1)
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(JSON.stringify(storage)).not.toContain('synthetic-cognito-local')
  expect(JSON.stringify(storage)).not.toContain('synthetic-test-password')
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

for (const hasExistingDeck of [false, true]) {
  test(`manual deck creation and first card work with ${hasExistingDeck ? 'an existing library' : 'an empty library'}`, async ({ page }) => {
    await setup(page, { enrolled: true })
    const id = '00000000-0000-4000-8000-000000000201'
    const now = '2026-09-01T12:00:00Z'
    const emptyDeck = {
      id, name: 'Biology notes', description: null, exam_date: null,
      study_intensity: 'balanced', card_count: 0, due_count: 0, next_due_at: null,
      created_at: now, updated_at: now, cards: [] as Record<string, unknown>[],
    }
    let created: typeof emptyDeck | null = null
    let createCalls = 0
    let rejectNextCreate = hasExistingDeck
    await page.route('**/api-mock/api/decks**', async route => {
      const request = route.request()
      expect(request.headers().authorization).toMatch(/^Bearer synthetic-/)
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.endsWith('/decks')) {
        createCalls++
        expect(request.postDataJSON()).toEqual({ name: 'Biology notes', description: 'My own questions', cards: [] })
        if (rejectNextCreate) {
          rejectNextCreate = false
          return route.fulfill({ status: 503, json: { detail: 'Please try again shortly.' } })
        }
        created = { ...emptyDeck, ...request.postDataJSON() }
        return route.fulfill({ status: 201, json: created })
      }
      if (request.method() === 'POST' && path.endsWith('/cards')) {
        expect(created).not.toBeNull()
        const payload = request.postDataJSON()
        expect(payload.cards).toHaveLength(1)
        expect(payload.cards[0].question).toBe('What is a cell?')
        expect(payload.cards[0].answer.correct_answer).toBe('The basic unit of life.')
        created = { ...created!, card_count: 1, due_count: 1, next_due_at: now, cards: [{
          ...payload.cards[0], id: '00000000-0000-4000-8000-000000000301', deck_id: id,
          fsrs_state: 1, fsrs_step: 0, stability: null, difficulty: null, due_at: now,
          last_reviewed_at: null, review_count: 0, lapse_count: 0, suspended: false,
          progress_reset_at: null, created_at: now, updated_at: now,
        }] }
        return route.fulfill({ json: created })
      }
      if (path.endsWith('/decks')) return route.fulfill({ json: [
        ...(hasExistingDeck ? [{ ...emptyDeck, id: '00000000-0000-4000-8000-000000000202', name: 'Existing deck' }] : []),
        ...(created ? [created] : []),
      ] })
      if (path.endsWith('/' + id) && created) return route.fulfill({ json: created })
      return route.fulfill({ status: 404, json: { detail: 'Not found' } })
    })
    await login(page)
    await page.getByRole('button', { name: 'Decks', exact: true }).click()
    await page.getByRole('button', { name: '+ Create Deck', exact: true }).click()
    const form = page.getByRole('form', { name: 'Create a study deck' })
    await form.getByLabel('Deck name', { exact: true }).fill('   ')
    await form.getByRole('button', { name: 'Create Deck', exact: true }).click()
    await expect(form.getByRole('alert')).toHaveText('Enter a deck name.')
    expect(createCalls).toBe(0)
    await form.getByLabel('Deck name', { exact: true }).fill('  Biology notes  ')
    await form.getByLabel('Description (optional)', { exact: true }).fill('My own questions')
    await form.getByRole('button', { name: 'Create Deck', exact: true }).click()
    if (hasExistingDeck) {
      await expect(form.getByRole('alert')).toHaveText('Please try again shortly.')
      await expect(form.getByLabel('Deck name', { exact: true })).toHaveValue('  Biology notes  ')
      await form.getByRole('button', { name: 'Create Deck', exact: true }).click()
    }
    await expect(page).toHaveURL(new RegExp('/decks/' + id + '$'))
    await expect(page.getByRole('heading', { name: 'Biology notes', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '+ Add Card', exact: true }).first().click()
    await page.getByLabel('Question', { exact: true }).fill('What is a cell?')
    await page.getByLabel('Correct answer', { exact: true }).fill('The basic unit of life.')
    await page.getByRole('button', { name: 'Add Card', exact: true }).click()
    await expect(page.getByText('What is a cell?', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Decks', exact: true }).click()
    await expect(page.getByRole('button', { name: /Biology notes/ })).toBeVisible()
    expect(createCalls).toBe(hasExistingDeck ? 2 : 1)
    await page.getByRole('button', { name: '+ Create Deck', exact: true }).click()
    await page.getByRole('form', { name: 'Create a study deck' }).getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('form', { name: 'Create a study deck' })).toHaveCount(0)
    expect(createCalls).toBe(hasExistingDeck ? 2 : 1)
  })
}
