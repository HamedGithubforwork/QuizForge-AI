import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cognitoConfiguration, providerFrom, publicLegacyKey, secureEndpoint } from './authConfig.ts'

const valid = { VITE_COGNITO_STAGING: 'true', VITE_COGNITO_USER_POOL_ID: 'ca-central-1_Test',
  VITE_COGNITO_CLIENT_ID: 'client123', VITE_COGNITO_DOMAIN: 'https://test.auth.ca-central-1.amazoncognito.com',
  VITE_API_URL: 'https://api.example.test', VITE_IDENTITY_API_URL: 'https://identity.example.test' }

test('Supabase is the unchanged default; invalid providers fail closed', () => {
  for (const value of [undefined, '', ' ', 'supabase', ' SUPABASE ']) assert.equal(providerFrom(value), 'supabase')
  assert.equal(providerFrom('cognito'), 'cognito')
  assert.throws(() => providerFrom('other'))
})
test('Cognito requires explicit staging, Canadian issuer and trusted AWS domain', () => {
  const config = cognitoConfiguration(valid, 'https://staging.example.test')
  assert.equal(config.smsMfaEnabled, false)
  assert.equal(config.redirect, 'https://staging.example.test/auth/callback')
  assert.equal(config.logout, 'https://staging.example.test/')
  assert.equal(config.authority, 'https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test')
  for (const [key, values] of Object.entries({ VITE_COGNITO_STAGING: [undefined, 'false'],
    VITE_COGNITO_USER_POOL_ID: [undefined, 'us-east-1_Test', 'ca-central-1_x/path'],
    VITE_COGNITO_CLIENT_ID: [undefined, 'secret/client'],
    VITE_COGNITO_DOMAIN: [undefined, 'http://test.auth.ca-central-1.amazoncognito.com',
      'https://test.auth.ca-central-1.amazoncognito.com.evil.test', 'https://test.auth.ca-central-1.amazoncognito.com/'],
    VITE_API_URL: [undefined], VITE_IDENTITY_API_URL: [undefined] })) {
    for (const value of values) assert.throws(() => cognitoConfiguration({ ...valid, [key]: value }, 'https://staging.example.test'))
  }
})
test('Bearer transport rejects public plaintext, credentials, query strings and fragments', () => {
  for (const url of ['http://example.test', 'http://localhost.evil.test', 'ftp://example.test',
    'https://user@example.test', 'https://:password@example.test', 'https://example.test?token=x',
    'https://example.test#token=x', 'bad']) assert.throws(() => secureEndpoint(url))
  assert.equal(secureEndpoint('http://localhost:4173/'), 'http://localhost:4173')
  assert.equal(secureEndpoint('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(secureEndpoint('https://example.test///'), 'https://example.test')
})

test('Production configuration requires exact domain, API and legacy account source', () => {
  const production = { ...valid, VITE_COGNITO_STAGING: undefined, VITE_COGNITO_ENVIRONMENT: 'production',
    VITE_API_URL: 'https://api.quizfromnotes.com', VITE_IDENTITY_API_URL: 'https://api.quizfromnotes.com',
    VITE_SUPABASE_URL: 'https://vfxmsvphgcaizqnbyjip.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_public_key_12345' }
  assert.equal(cognitoConfiguration(production, 'https://quizfromnotes.com').environment, 'production')
  for (const origin of ['https://www.quizfromnotes.com', 'https://staging.test', 'http://localhost:4173']) {
    assert.throws(() => cognitoConfiguration(production, origin))
  }
  for (const change of [{ VITE_COGNITO_STAGING: 'true' }, { VITE_COGNITO_ENVIRONMENT: 'prod' },
    { VITE_API_URL: 'https://staging-api.quizfromnotes.com' }, { VITE_IDENTITY_API_URL: 'https://foreign.test' },
    { VITE_SUPABASE_URL: 'https://foreign.supabase.co' }, { VITE_SUPABASE_PUBLISHABLE_KEY: '' }]) {
    assert.throws(() => cognitoConfiguration({ ...production, ...change }, 'https://quizfromnotes.com'))
  }
})

test('SMS MFA feature flag is explicit and boolean', () => {
  assert.equal(
    cognitoConfiguration(
      { ...valid, VITE_COGNITO_SMS_MFA_ENABLED: 'true' },
      'https://staging.example.test',
    ).smsMfaEnabled,
    true,
  )
  assert.equal(
    cognitoConfiguration(
      { ...valid, VITE_COGNITO_SMS_MFA_ENABLED: 'false' },
      'https://staging.example.test',
    ).smsMfaEnabled,
    false,
  )
  assert.throws(() =>
    cognitoConfiguration(
      { ...valid, VITE_COGNITO_SMS_MFA_ENABLED: 'yes' },
      'https://staging.example.test',
    ),
  )
})

test('Production configuration accepts only public legacy key types', () => {
  const token = (role: string, ref = 'vfxmsvphgcaizqnbyjip') => `header.${btoa(JSON.stringify({ role, ref }))}.signature`
  assert.equal(publicLegacyKey(token('anon')), true)
  for (const key of [token('service_role'), token('authenticated'), token('anon', 'foreign'),
    'sb_secret_synthetic_secret_key_12345', 'bad', 'header.bnVsbA.signature']) assert.equal(publicLegacyKey(key), false)
})
