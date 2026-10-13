import { expect, test, type Page } from '@playwright/test'

const endpoint = 'https://cognito-idp.ca-central-1.amazonaws.com/'
const domain = 'https://quizforge-test.auth.ca-central-1.amazoncognito.com'
const sub = '00000000-0000-0000-0000-000000000101'
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
async function provider(page: Page, options: { confirmed?: boolean; mfa?: boolean; invalidIdentity?: boolean; revokeFails?: boolean; alreadyRegistered?: boolean } = {}) {
  let confirmed = Boolean(options.confirmed)
  let wrongCode = true
  let refreshes = 0
  const operations: string[] = []
  const tokens = () => ({ AuthenticationResult: { AccessToken: refreshes ? 'synthetic-refreshed' : 'synthetic-access',
    RefreshToken: 'synthetic-refresh', ExpiresIn: 300 } })
  await page.route(endpoint, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const operation = route.request().headers()['x-amz-target'].split('.').pop()!
    operations.push(operation)
    const body = route.request().postDataJSON()
    const ok = (json: object) => route.fulfill({ json, headers: cors })
    const fail = (__type: string) => route.fulfill({ status: 400, json: { __type, message: 'secret provider detail' }, headers: cors })
    if (operation === 'SignUp') {
      expect(body.ClientId).toBe('browserclient123')
      expect(body.Username).toBe('learner@example.invalid')
      expect(body.Password).toBe('SyntheticPassword1!')
      expect(body.UserAttributes).toEqual([{ Name: 'email', Value: 'learner@example.invalid' }])
      expect(body).not.toHaveProperty('SecretHash')
      return options.alreadyRegistered ? fail('UsernameExistsException') : ok({ UserConfirmed: false })
    }
    if (operation === 'InitiateAuth') {
      expect(body.ClientId).toBe('browserclient123')
      if (body.AuthFlow === 'REFRESH_TOKEN_AUTH') { refreshes++; expect(body.AuthParameters.REFRESH_TOKEN).toBe('synthetic-refresh'); return ok(tokens()) }
      expect(body.AuthFlow).toBe('USER_PASSWORD_AUTH')
      expect(body.AuthParameters.USERNAME).toBe('learner@example.invalid')
      if (body.AuthParameters.PASSWORD === 'wrong') return fail('NotAuthorizedException')
      expect(body.AuthParameters.PASSWORD).toBe('synthetic-password')
      if (!confirmed) return fail('UserNotConfirmedException')
      return options.mfa ? ok({ ChallengeName: 'SELECT_MFA_TYPE', Session: 'choice',
        ChallengeParameters: { USERNAME: 'canonical', MFAS_CAN_CHOOSE: '["SOFTWARE_TOKEN_MFA","SMS_MFA"]' } }) : ok(tokens())
    }
    if (operation === 'RespondToAuthChallenge') {
      expect(body.ChallengeResponses.USERNAME).toBe('canonical')
      if (body.ChallengeName === 'SELECT_MFA_TYPE') return ok({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'mfa', ChallengeParameters: { USERNAME: 'canonical' } })
      if (body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE === '000000') return fail('CodeMismatchException')
      expect(body.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE).toBe('123456')
      return ok(tokens())
    }
    if (operation === 'GetUser') return ok({ UserAttributes: [
      { Name: 'sub', Value: sub }, { Name: 'email', Value: 'learner@example.invalid' }, { Name: 'email_verified', Value: 'true' },
    ] })
    if (operation === 'ResendConfirmationCode') { expect(body.Username).toBe('learner@example.invalid'); return ok({}) }
    if (operation === 'ConfirmSignUp') {
      expect(body.Username).toBe('learner@example.invalid')
      expect(body).not.toHaveProperty('Password')
      if (body.ConfirmationCode === '000000' && wrongCode) { wrongCode = false; return fail('CodeMismatchException') }
      expect(body.ConfirmationCode).toBe('123456'); confirmed = true; return ok({})
    }
    expect(operation).toBe('RevokeToken'); expect(body.Token).toBe('synthetic-refresh')
    return options.revokeFails ? fail('InternalErrorException') : ok({})
  })
  await page.route('**/identity-mock/identity/session', route => {
    expect(route.request().headers().authorization).toBe('Bearer synthetic-access')
    return route.fulfill({ json: { id: options.invalidIdentity ? 'wrong-user' : `cognito:ca-central-1_BrowserTest:${sub}`,
      email: 'learner@example.invalid', enrolled: true } })
  })
  await page.route('**/api-mock/api/quiz-history**', route => {
    if (!refreshes) return route.fulfill({ status: 401, json: { detail: 'expired' } })
    expect(route.request().headers().authorization).toBe('Bearer synthetic-refreshed')
    return route.fulfill({ json: { items: [], totalCount: 0, hasMore: false, nextCursor: null } })
  })
  await page.route(domain + '/logout**', route => route.fulfill({ status: 302, headers: { location: 'http://localhost:4174/' } }))
  return operations
}
async function openEmail(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Finish email verification' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in with email' })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('learner@example.invalid')
}
async function submitPassword(page: Page, password = 'synthetic-password') {
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function noStoredSecrets(page: Page) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(storage).not.toMatch(/synthetic-(password|access|refresh)|learner@example|123456/)
  expect(page.url()).not.toMatch(/learner|password|123456|token=/)
}

for (const resend of [false, true]) test(`sign-in automatically resumes abandoned verification (${resend ? 'resend' : 'original code'})`, async ({ page }) => {
  const operations = await provider(page)
  await openEmail(page); await submitPassword(page)
  await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toBeVisible()
  await expect(page.getByText('learner@example.invalid', { exact: true })).toBeVisible()
  expect(operations).toEqual(['InitiateAuth'])
  if (resend) {
    await page.getByRole('button', { name: 'Resend confirmation code' }).click()
    await expect(page.getByRole('status')).toContainText('A new code has been requested')
    await expect(page.getByRole('button', { name: 'Please wait before resending' })).toBeDisabled()
    await page.getByLabel('Email confirmation code').fill('000000')
    await page.getByRole('button', { name: 'Confirm my email' }).click()
    await expect(page.getByRole('alert')).toContainText('not accepted')
    await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toBeVisible()
  }
  await page.getByLabel('Email confirmation code').fill('123456')
  await page.getByRole('button', { name: 'Confirm my email' }).click()
  await expect(page.getByRole('status')).toContainText('Email confirmed')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('learner@example.invalid')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  expect(operations.filter(x => x === 'ResendConfirmationCode')).toHaveLength(resend ? 1 : 0)
  await submitPassword(page)
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  await page.getByRole('button', { name: 'My Quiz History', exact: false }).click()
  await expect(page.getByText('No saved quizzes yet')).toBeVisible()
  await noStoredSecrets(page)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose how to continue.' })).toBeVisible()
  expect(operations.at(-1)).toBe('RevokeToken')
})

test('confirmed users sign in directly; invalid credentials cannot enter verification', async ({ page }) => {
  await provider(page, { confirmed: true }); await openEmail(page)
  await submitPassword(page, 'wrong')
  await expect(page.getByRole('alert')).toContainText('Sign-in failed')
  await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await submitPassword(page)
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  await noStoredSecrets(page)
})

test('MFA selection is followed by code verification; a wrong code never signs in', async ({ page }) => {
  await provider(page, { confirmed: true, mfa: true }); await openEmail(page); await submitPassword(page)
  await page.getByLabel('Verification method').selectOption('SOFTWARE_TOKEN_MFA')
  await page.getByRole('button', { name: 'Continue to verification' }).click()
  await page.getByLabel('Sign-in verification code').fill('000000')
  await page.getByRole('button', { name: 'Verify and sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByText('Signed in as learner@example.invalid')).toHaveCount(0)
  await page.getByLabel('Sign-in verification code').fill('123456')
  await page.getByRole('button', { name: 'Verify and sign in' }).click()
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  await noStoredSecrets(page)
})

test('leaving confirmation clears the code; a later login rediscovers the unfinished account', async ({ page }) => {
  await provider(page); await openEmail(page); await submitPassword(page)
  await page.getByLabel('Email confirmation code').fill('123456')
  await page.getByRole('button', { name: 'Back to sign in options' }).click()
  await openEmail(page); await submitPassword(page)
  await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toBeVisible()
  await expect(page.getByLabel('Email confirmation code')).toHaveValue('')
  await noStoredSecrets(page)
})

test('a mismatched backend identity is rejected and the new session revoked', async ({ page }) => {
  const operations = await provider(page, { confirmed: true, invalidIdentity: true })
  await openEmail(page); await submitPassword(page)
  await expect(page.getByRole('alert')).toContainText('Account identity could not be verified')
  await expect(page.getByText('Signed in as learner@example.invalid')).toHaveCount(0)
  expect(operations).toContain('RevokeToken')
})

test('password-session revocation failure still clears local account', async ({ page }) => {
  await provider(page, { confirmed: true, revokeFails: true }); await openEmail(page); await submitPassword(page)
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('session revocation failed')
  await expect(page.getByText('Signed in as learner@example.invalid')).toHaveCount(0)
})

test('forgot password preserves a PKCE transaction through Cognito recovery', async ({ page }) => {
  let called = false
  await page.route(domain + '/forgotPassword**', async route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('client_id')).toBe('browserclient123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.has('password')).toBe(false)
    called = true
    await route.fulfill({ contentType: 'text/html', body: '<h1>Password recovery</h1>' })
  })
  await openEmail(page)
  await page.getByRole('button', { name: 'Forgot your password?' }).click()
  await expect(page.getByRole('heading', { name: 'Password recovery' })).toBeVisible()
  expect(called).toBe(true)
})

test('create account stays on our site and verifies email without hosted Cognito signup', async ({ page }) => {
  const operations = await provider(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await expect(page).not.toHaveURL(/amazoncognito\.com/)
  await page.getByLabel('Email', { exact: true }).fill('Learner@Example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('SyntheticPassword1!')
  await page.getByLabel('Confirm password').fill('SyntheticPassword1!')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible()
  expect(operations).toEqual(['SignUp'])
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await page.getByLabel('Email confirmation code').fill('000000')
  await page.getByRole('button', { name: 'Confirm my email' }).click()
  await expect(page.getByRole('alert')).toContainText('not accepted')
  await page.getByLabel('Email confirmation code').fill('123456')
  await page.getByRole('button', { name: 'Confirm my email' }).click()
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in with email' })).toBeVisible()
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('learner@example.invalid')
  await noStoredSecrets(page)
  await submitPassword(page)
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  expect(operations.filter(x => x === 'SignUp')).toHaveLength(1)
})

test('abandoned signup resumes verification at next app sign-in without another signup', async ({ page }) => {
  const operations = await provider(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Email', { exact: true }).fill('learner@example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('SyntheticPassword1!')
  await page.getByLabel('Confirm password').fill('SyntheticPassword1!')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to sign in options' }).click()
  await openEmail(page)
  await submitPassword(page)
  await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toBeVisible()
  await page.getByRole('button', { name: 'Resend confirmation code' }).click()
  await expect(page.getByRole('status')).toContainText('A new code has been requested')
  await page.getByLabel('Email confirmation code').fill('123456')
  await page.getByRole('button', { name: 'Confirm my email' }).click()
  await submitPassword(page)
  await expect(page.getByText('Signed in as learner@example.invalid')).toBeVisible()
  expect(operations.filter(x => x === 'SignUp')).toHaveLength(1)
  await noStoredSecrets(page)
})

test('duplicate email never creates another user and offers local sign-in with verification', async ({ page }) => {
  const operations = await provider(page, { alreadyRegistered: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Email', { exact: true }).fill('learner@example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('SyntheticPassword1!')
  await page.getByLabel('Confirm password').fill('SyntheticPassword1!')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toContainText('Choose Sign in')
  await page.getByRole('button', { name: 'Already registered? Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in with email' })).toBeVisible()
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('learner@example.invalid')
  await submitPassword(page)
  await expect(page.getByRole('heading', { name: 'Verify your email to continue' })).toBeVisible()
  expect(operations.filter(x => x === 'SignUp')).toHaveLength(1)
  await noStoredSecrets(page)
})
