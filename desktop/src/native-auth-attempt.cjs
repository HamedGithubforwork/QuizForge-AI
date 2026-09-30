'use strict'

const { randomBytes, createHash, timingSafeEqual } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { AUTH_ORIGIN } = require('./policy.cjs')
const CALLBACK_URL = 'com.quizfromnotes.desktop.preview:/oauth/callback'
const ATTEMPT_LIFETIME_MS = 5 * 60 * 1000

// Main-process transaction primitive only. It performs no IO, registers no OS
// protocol, opens no browser, exchanges no tokens and establishes no identity.
function createAuthorizationAttempt({ clientId, now = () => performance.now() }) {
  if (typeof clientId !== 'string' || !/^[a-z0-9]{1,128}$/.test(clientId)) throw new Error('Invalid native sign-in configuration.')
  let verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const started = now()
  if (!Number.isFinite(started)) throw new Error('Invalid native sign-in clock.')
  let active = true
  const authorization = new URL('/oauth2/authorize', AUTH_ORIGIN)
  authorization.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK_URL,
    scope: 'openid email profile aws.cognito.signin.user.admin', state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString()
  function cancel() { active = false; verifier = undefined }
  function reject() { throw new Error('Invalid or expired native sign-in response.') }
  return {
    authorizationUrl: authorization.href,
    cancel,
    consumeCallback(raw) {
      const elapsed = now() - started
      if (!active || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= ATTEMPT_LIFETIME_MS) { cancel(); reject() }
      if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) reject()
      let url
      try { url = new URL(raw) } catch { reject() }
      if (url.hash || url.username || url.password || raw.split('?')[0] !== CALLBACK_URL) reject()
      const params = url.searchParams
      const returnedState = params.get('state')
      if (params.getAll('state').length !== 1 || typeof returnedState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(returnedState) ||
          !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))) reject()
      // A response for this exact attempt is consumed once, even when denied or
      // malformed. Wrong-state/unrelated callbacks cannot cancel a valid attempt.
      const proof = verifier
      cancel()
      const allowed = new Set(['state', 'code', 'error', 'error_description'])
      if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) reject()
      if (params.has('error')) {
        if (params.has('code') || !params.get('error')) reject()
        throw new Error('Native sign-in was cancelled or rejected.')
      }
      const code = params.get('code')
      if (params.has('error_description') || !code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) reject()
      return {
        url: AUTH_ORIGIN + '/oauth2/token', method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: CALLBACK_URL, code, code_verifier: proof }).toString(),
        nonce,
      }
    },
  }
}

module.exports = { createAuthorizationAttempt, CALLBACK_URL, ATTEMPT_LIFETIME_MS }
