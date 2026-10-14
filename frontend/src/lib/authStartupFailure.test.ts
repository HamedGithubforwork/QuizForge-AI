import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authStartupFailure, classifyOidcCallbackFailure, IdentitySessionHttpError, OAuthCallbackDiagnostic,
} from './authStartupFailure.ts'

const callback = 'https://quizfromnotes.com/auth/callback'

function classified(query: string, error: unknown): string {
  return authStartupFailure('callback', classifyOidcCallbackFailure(callback + '?' + query, error))
}

test('OAuth callback failures remain distinct from missing sessions and account checks', () => {
  assert.match(authStartupFailure('callback', new Error('invalid state')), /QF-OAUTH-CALLBACK/)
  assert.match(authStartupFailure('session', new Error('missing user')), /QF-SESSION/)
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(403)), /QF-IDENTITY-403/)
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(503)), /QF-IDENTITY-503/)
  assert.match(authStartupFailure('identity', new TypeError('network error')), /QF-IDENTITY-NET/)
})

test('Cognito OAuth redirect errors are recognized from callback query only', () => {
  assert.match(classified('state=synthetic&error=access_denied', new Error('cancelled')), /QF-OAUTH-CANCEL/)
  assert.match(classified('state=synthetic&error=invalid_request&error_description=not-for-display', new Error('invalid request')),
    /QF-OAUTH-PROVIDER-REQUEST/)
  assert.match(classified('state=synthetic&error=server_error', new Error('server error')),
    /QF-OAUTH-PROVIDER-SERVER/)
  assert.match(classified('state=synthetic&error=temporarily_unavailable', new Error('temporarily unavailable')),
    /QF-OAUTH-PROVIDER-SERVER/)
  assert.match(classified('state=synthetic&error=unauthorized_client', new Error('unknown')),
    /QF-OAUTH-PROVIDER-OTHER/)
  assert.match(classified('state=synthetic&error=secret-code-do-not-use', new Error('provider')),
    /QF-OAUTH-PROVIDER-OTHER/)
})

test('OIDC 3.5.0 transaction and nonce checks are preserved and classified', () => {
  for (const error of [
    'No state in response', 'No matching state found in storage', 'State does not match',
    'authority mismatch on settings vs. signin state',
    'client_id mismatch on settings vs. signin state',
  ]) {
    assert.match(classified('code=SYNTHETIC-SECRET-DO-NOT-LEAK&state=synthetic', new Error(error)), /QF-OAUTH-STATE/)
  }
  assert.match(classified('code=synthetic&state=synthetic',
    new Error('nonce in id_token does not match nonce in client storage')), /QF-OAUTH-NONCE/)
  assert.match(classified('state=synthetic', new Error('Expected code in response')), /QF-OAUTH-NO-CODE/)
})

test('token exchange errors are distinct from provider redirects, without exposing responses', () => {
  assert.match(classified('code=synthetic&state=synthetic', { error: 'invalid_grant', error_description: 'hidden' }),
    /QF-OAUTH-TOKEN-GRANT/)
  assert.match(classified('code=synthetic&state=synthetic', { error: 'invalid_client' }),
    /QF-OAUTH-TOKEN-REJECTED/)
  assert.match(classified('code=synthetic&state=synthetic', new TypeError('Failed to fetch')),
    /QF-OAUTH-NETWORK/)
  const timeout = Object.assign(new Error('Network timed out'), { name: 'ErrorTimeout' })
  assert.match(classified('code=synthetic&state=synthetic', timeout), /QF-OAUTH-NETWORK/)
  assert.match(classified('code=synthetic&state=synthetic', new Error('Unknown provider failure')),
    /QF-OAUTH-TOKEN/)
  assert.match(classified('state=synthetic', new Error('Unexpected callback')), /QF-OAUTH-CALLBACK/)
})

test('arbitrary provider URL, code, state, server text and user details never appear', () => {
  const secret = 'SYNTHETIC-SECRET-DO-NOT-LEAK'
  const cases: Array<[string, unknown]> = [
    [`state=${secret}&error=invalid_request&error_description=${secret}`, new Error(secret)],
    [`code=${secret}&state=${secret}`, { error: 'invalid_grant', error_description: secret }],
    [`code=${secret}&state=${secret}`, new TypeError(secret)],
    [`code=${secret}&state=${secret}`, new Error(secret)],
    [`state=${secret}&error=${secret}`, new Error(secret)],
  ]
  for (const [query, error] of cases) {
    const diagnostic = classifyOidcCallbackFailure(callback + '?' + query, error)
    const message = authStartupFailure('callback', diagnostic)
    assert.ok(diagnostic instanceof OAuthCallbackDiagnostic)
    assert.ok(!JSON.stringify(diagnostic).includes(secret))
    assert.ok(!message.includes(secret))
    assert.ok(!/https?:\/\//.test(message))
    assert.ok(message.length < 180)
  }
  for (const [stage, cause] of [
    ['callback', new Error(secret)],
    ['session', new Error(secret)],
    ['identity', new Error(secret)],
    ['identity', new IdentitySessionHttpError(399)],
    ['identity', new IdentitySessionHttpError(599)],
  ] as const) {
    const message = authStartupFailure(stage, cause)
    assert.ok(!message.includes(secret))
    assert.ok(!/https?:\/\//.test(message))
    assert.ok(message.length < 180)
  }
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(599)), /QF-IDENTITY-OTHER/)
})
