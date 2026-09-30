'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createNativeAuthClient } = require('../src/native-auth-client.cjs')
const { createAuthorizationAttempt } = require('../src/native-auth-attempt.cjs')
const { AUTH_ORIGIN } = require('../src/policy.cjs')
const poolId = 'ca-central-1_Synthetic'
const clientId = 'desktop123'
const subject = '00000000-0000-0000-0000-000000000001'
const issuer = `https://cognito-idp.ca-central-1.amazonaws.com/${poolId}`
let signing
async function fixture(options = {}) {
  const jose = await import('jose')
  signing ??= jose.generateKeyPair('RS256', { extractable: true })
  const keys = await signing
  const jwk = { ...await jose.exportJWK(keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' }
  const attempt = createAuthorizationAttempt({ clientId })
  const url = new URL(attempt.authorizationUrl)
  const callback = `${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=synthetic-code`
  const request = attempt.consumeCallback(callback)
  const now = Math.floor(Date.now() / 1000)
  const base = { sub: subject, iss: issuer, iat: now - 10, exp: now + 290, auth_time: now - 20 }
  const accessClaims = { ...base, token_use: 'access', client_id: clientId, scope: 'aws.cognito.signin.user.admin', ...options.access }
  async function sign(payload, header = {}) { return new jose.SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key', ...header }).sign(keys.privateKey) }
  const access = await sign(accessClaims, options.header)
  const id = await sign({ ...base, token_use: 'id', aud: clientId, nonce: request.nonce,
    email: 'synthetic@example.invalid', email_verified: true,
    at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url'), ...options.id })
  const response = { access_token: access, id_token: id, refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 300, ...options.response }
  const calls = []
  const client = await createNativeAuthClient({ poolId, clientId, fetchImpl: async (target, init) => {
    calls.push({ target, init })
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.ok(init.signal instanceof AbortSignal)
    if (target === issuer + '/.well-known/jwks.json') return options.jwksResponse ? options.jwksResponse() : new Response(JSON.stringify({ keys: [jwk] }))
    assert.ok([AUTH_ORIGIN + '/oauth2/token', AUTH_ORIGIN + '/oauth2/revoke'].includes(target))
    if (target.endsWith('/revoke')) return new Response('', { status: options.revokeStatus || 200 })
    return options.httpResponse ? options.httpResponse() : new Response(JSON.stringify(response))
  } })
  return { client, request, calls, response }
}

test('exchanges PKCE proof and verifies real RSA signatures, nonce and matching identity', async () => {
  const { client, request, calls } = await fixture()
  const session = await client.exchange(request)
  assert.equal(session.userId, `cognito:${poolId}:${subject}`)
  assert.equal(session.email, 'synthetic@example.invalid')
  assert.equal(session.refreshToken, 'synthetic-refresh')
  assert.ok(session.expiresAt > Date.now() && session.expiresAt < Date.now() + 300_000)
  assert.equal(calls.filter(call => call.target.endsWith('/jwks.json')).length, 1)
  assert.equal(new URLSearchParams(calls[0].init.body).get('code'), 'synthetic-code')
})

test('rejects invalid signatures, claims, nonce and token substitution with generic errors', async () => {
  for (const options of [
    { access: { client_id: 'otherclient' } }, { access: { iss: 'https://untrusted.invalid' } },
    { access: { token_use: 'id' } }, { access: { scope: 'openid' } }, { access: { aud: clientId } },
    { access: { exp: 1 } }, { access: { iat: 4_000_000_000 } }, { access: { auth_time: 0 } },
    { access: { exp: Math.floor(Date.now() / 1000) + 7200 } }, { access: { iat: '1' } },
    { id: { aud: 'otherclient' } }, { id: { aud: [clientId, 'otherclient'] } },
    { id: { nonce: 'wrong' } }, { id: { token_use: 'access' } }, { id: { at_hash: 'wrong' } },
    { id: { sub: '00000000-0000-0000-0000-000000000002' } }, { id: { email_verified: false } },
    { id: { auth_time: 1 } }, { id: { email: '' } },
    { header: { jku: 'https://untrusted.invalid' } }, { header: { kid: 'unknown' } },
    { response: { access_token: 'not.a.jwt' } }, { response: { id_token: 'not.a.jwt' } },
    { response: { refresh_token: '' } }, { response: { token_type: 'other' } },
    { response: { expires_in: '300' } }, { response: { expires_in: 7200 } },
  ]) {
    const { client, request } = await fixture(options)
    await assert.rejects(client.exchange(request), { message: 'Native sign-in could not be verified. Please sign in again.' })
  }
  const { client, request, response } = await fixture()
  response.access_token = response.access_token.slice(0, -20) + 'a'.repeat(20)
  await assert.rejects(client.exchange(request), /could not be verified/)
})

test('bounds HTTP bodies, rejects redirects/non-JSON and never leaks provider errors', async () => {
  for (const httpResponse of [
    () => new Response('private error', { status: 400 }),
    () => new Response('', { status: 302, headers: { Location: 'https://untrusted.invalid' } }),
    () => new Response('not JSON'), () => new Response('[]'),
    () => new Response('x'.repeat(65_537)),
  ]) {
    const { client, request } = await fixture({ httpResponse })
    await assert.rejects(client.exchange(request), { message: 'Native sign-in could not be verified. Please sign in again.' })
  }
})

test('refresh verifies the same subject, preserves a non-rotated refresh token, and revokes', async () => {
  const { client, request, response, calls } = await fixture()
  const session = await client.exchange(request)
  delete response.refresh_token
  assert.equal((await client.refresh(session)).refreshToken, session.refreshToken)
  await assert.rejects(client.refresh({ ...session, subject: '00000000-0000-0000-0000-000000000002' }), /could not be verified/)
  await client.revoke(session.refreshToken)
  assert.equal(calls.at(-1).target, AUTH_ORIGIN + '/oauth2/revoke')
  assert.equal(new URLSearchParams(calls.at(-1).init.body).get('client_id'), clientId)
  const failed = await fixture({ revokeStatus: 500 })
  await assert.rejects(failed.client.revoke('synthetic-refresh'), /revocation could not be confirmed/)
})

test('rejects unreviewed configuration and mismatched/smuggled exchange inputs before HTTP', async () => {
  for (const config of [{ poolId: 'us-east-1_Other', clientId }, { poolId, clientId: '*' }]) {
    await assert.rejects(createNativeAuthClient(config), /could not be verified/)
  }
  const { client, request, calls } = await fixture()
  for (const body of [request.body + '&client_secret=private', request.body.replace('desktop123', 'otherclient'), request.body + '&code=two']) {
    await assert.rejects(client.exchange({ ...request, body }), /could not be verified/)
  }
  assert.equal(calls.length, 0)
})


test('unusable or oversized signing-key responses have no fallback', async () => {
  for (const jwksResponse of [
    () => new Response('x'.repeat(65_537)), () => new Response(JSON.stringify({ keys: [] })),
    () => new Response(JSON.stringify({ keys: Array(9).fill({}) })),
    () => new Response('', { status: 302 }), () => { throw new Error('private network failure') },
  ]) {
    const { client, request } = await fixture({ jwksResponse })
    await assert.rejects(client.exchange(request), { message: 'Native sign-in could not be verified. Please sign in again.' })
  }
})
