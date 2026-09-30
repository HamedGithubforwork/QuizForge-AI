'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createAuthorizationAttempt, CALLBACK_URL, ATTEMPT_LIFETIME_MS } = require('../src/native-auth-attempt.cjs')
const { AUTH_ORIGIN } = require('../src/policy.cjs')
function fixture() {
  let clock = 1000
  const attempt = createAuthorizationAttempt({ clientId: 'syntheticclient', now: () => clock })
  const authorize = new URL(attempt.authorizationUrl)
  const state = authorize.searchParams.get('state')
  return { attempt, authorize, state, callback: `${CALLBACK_URL}?state=${state}&code=synthetic-code`, setClock: value => { clock = value } }
}

test('creates a unique bounded S256 authorization attempt and consumes its proof once', () => {
  const { attempt, authorize, state, callback } = fixture()
  assert.equal(authorize.origin, AUTH_ORIGIN)
  assert.equal(authorize.pathname, '/oauth2/authorize')
  assert.equal(authorize.searchParams.get('response_type'), 'code')
  assert.equal(authorize.searchParams.get('redirect_uri'), CALLBACK_URL)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.match(state, /^[A-Za-z0-9_-]{43}$/)
  const other = fixture()
  assert.notEqual(other.state, state)
  assert.notEqual(other.authorize.searchParams.get('nonce'), authorize.searchParams.get('nonce'))
  const request = attempt.consumeCallback(callback)
  assert.equal(request.url, AUTH_ORIGIN + '/oauth2/token')
  assert.equal(request.method, 'POST')
  assert.equal(request.redirect, 'error')
  const body = new URLSearchParams(request.body)
  assert.equal(body.get('client_id'), 'syntheticclient')
  assert.equal(body.get('code'), 'synthetic-code')
  assert.equal(body.get('redirect_uri'), CALLBACK_URL)
  assert.equal(body.has('client_secret'), false)
  assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/)
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'))
  assert.equal(request.nonce, authorize.searchParams.get('nonce'))
  assert.equal(attempt.authorizationUrl.includes(body.get('code_verifier')), false)
  assert.throws(() => attempt.consumeCallback(callback), /Invalid or expired/)
})

test('unrelated URLs and wrong state never consume the active attempt', () => {
  for (const transform of [
    url => url.replace('com.quizfromnotes.desktop.preview:', 'https:'),
    url => url.replace('/oauth/callback', '//untrusted/oauth/callback'),
    url => url.replace('/oauth/callback', '/oauth/other'),
    url => url.replace(/state=[^&]+/, 'state=' + encodeURIComponent('é'.repeat(43))),
    url => url.replace('/oauth/callback', '/oauth/extra/../callback'),
    url => url + '#fragment', url => ' ' + url,
    url => url.replace('state=', 'state=wrong'),
    url => url + '&state=another', url => 'not a URL', url => url + 'x'.repeat(8192),
  ]) {
    const { attempt, callback } = fixture()
    assert.throws(() => attempt.consumeCallback(transform(callback)), /Invalid or expired/)
    assert.equal(attempt.consumeCallback(callback).method, 'POST')
  }
})

test('rejects parameter smuggling, token callbacks and provider failures without leaking values', () => {
  for (const query of [
    'code=one&code=two', 'access_token=secret', 'code=one&error=denied',
    'code=one&redirect_uri=https://untrusted.invalid', 'code=', 'code=%0Asecret',
    'code=one&error_description=private', 'error=denied&error_description=private',
  ]) {
    const { attempt, state, callback } = fixture()
    assert.throws(() => attempt.consumeCallback(`${CALLBACK_URL}?state=${state}&${query}`), error => {
      assert.match(error.message, /^(Invalid or expired native sign-in response\.|Native sign-in was cancelled or rejected\.)$/)
      return true
    })
    assert.throws(() => attempt.consumeCallback(callback), /Invalid or expired/)
  }
})

test('expiry, clock failure and explicit cancellation invalidate the transaction', () => {
  for (const time of [1000 + ATTEMPT_LIFETIME_MS, 999, NaN, Infinity]) {
    const { attempt, callback, setClock } = fixture()
    setClock(time)
    assert.throws(() => attempt.consumeCallback(callback), /Invalid or expired/)
    setClock(1000)
    assert.throws(() => attempt.consumeCallback(callback), /Invalid or expired/)
  }
  const { attempt, callback } = fixture()
  attempt.cancel()
  assert.throws(() => attempt.consumeCallback(callback), /Invalid or expired/)
  for (const clientId of ['', 'client&redirect_uri=bad', null, 'a'.repeat(129)]) {
    assert.throws(() => createAuthorizationAttempt({ clientId }), /configuration/)
  }
})
