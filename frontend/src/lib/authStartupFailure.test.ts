import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authStartupFailure, IdentitySessionHttpError } from './authStartupFailure.ts'

test('OAuth callback failure is distinct from a missing session and account checks', () => {
  assert.match(authStartupFailure('callback', new Error('invalid state')), /QF-OAUTH-CALLBACK/)
  assert.match(authStartupFailure('session', new Error('missing user')), /QF-SESSION/)
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(403)), /QF-IDENTITY-403/)
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(503)), /QF-IDENTITY-503/)
  assert.match(authStartupFailure('identity', new TypeError('network error')), /QF-IDENTITY-NET/)
})

test('known OAuth cancellation maps to an actionable fixed diagnostic', () => {
  assert.match(authStartupFailure('callback', { error: 'access_denied' }), /QF-OAUTH-CANCEL/)
  assert.match(authStartupFailure('callback', { error: 'invalid_request' }), /QF-OAUTH-CALLBACK/)
})

test('arbitrary provider, token, URL, and server text never reach user-facing errors', () => {
  const secret = 'SYNTHETIC-SECRET-DO-NOT-LEAK'
  for (const [stage, cause] of [
    ['callback', { error: 'invalid_request', error_description: secret, state: secret }],
    ['callback', new Error(secret)],
    ['session', new Error(secret)],
    ['identity', new Error(secret)],
    ['identity', new IdentitySessionHttpError(399)],
    ['identity', new IdentitySessionHttpError(599)],
  ] as const) {
    const message = authStartupFailure(stage, cause)
    assert.ok(!message.includes(secret))
    assert.ok(!/https?:\/\//.test(message))
    assert.ok(message.length < 175)
  }
  assert.match(authStartupFailure('identity', new IdentitySessionHttpError(599)), /QF-IDENTITY-OTHER/)
})
