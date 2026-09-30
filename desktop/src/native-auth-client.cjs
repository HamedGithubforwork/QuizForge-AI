'use strict'

const { createHash } = require('node:crypto')
const { AUTH_ORIGIN } = require('./policy.cjs')
const { CALLBACK_URL } = require('./native-auth-attempt.cjs')
const MAX_BODY = 65_536
const MAX_TOKEN = 16_384
const USER_SCOPE = 'aws.cognito.signin.user.admin'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function invalid() { throw new Error('Native sign-in could not be verified. Please sign in again.') }
function token(value) { return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN && !/[\x00-\x20\x7f]/.test(value) }

// Main-process-only. The fetch override exists for deterministic HTTP tests;
// application callers must use the default transport and reviewed configuration.
async function createNativeAuthClient({ poolId, clientId, fetchImpl = globalThis.fetch }) {
  if (typeof poolId !== 'string' || !/^ca-central-1_[A-Za-z0-9]{1,55}$/.test(poolId) ||
      typeof clientId !== 'string' || !/^[a-z0-9]{1,128}$/.test(clientId)) invalid()
  const { createRemoteJWKSet, customFetch, jwtVerify, decodeProtectedHeader } = await import('jose')
  const issuer = `https://cognito-idp.ca-central-1.amazonaws.com/${poolId}`
  const jwksUrl = issuer + '/.well-known/jwks.json'
  async function boundedJson(url, options = {}, allowEmpty = false) {
    const timeout = AbortSignal.timeout(8000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await fetchImpl(url, { ...options, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' })
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); invalid() }
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY) { await reader.cancel(); invalid() }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    if (allowEmpty && size === 0) return {}
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
    return data
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 8000, cacheMaxAge: 300_000, cooldownDuration: 30_000,
    [customFetch]: async (url, options) => {
      if (String(url) !== jwksUrl) invalid()
      const data = await boundedJson(jwksUrl, options)
      if (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 8) invalid()
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  async function claims(raw, use) {
    if (!token(raw)) invalid()
    const header = decodeProtectedHeader(raw)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 ||
        ['jku', 'jwk', 'x5u', 'crit'].some(name => name in header)) invalid()
    const { payload } = await jwtVerify(raw, jwks, {
      issuer, algorithms: ['RS256'], ...(use === 'id' ? { audience: clientId } : {}),
      requiredClaims: ['exp', 'iat', 'auth_time', 'sub', 'iss', 'token_use', use === 'id' ? 'aud' : 'client_id'],
    })
    if (payload.token_use !== use || typeof payload.sub !== 'string' || !UUID.test(payload.sub) ||
        !['exp', 'iat', 'auth_time'].every(name => Number.isSafeInteger(payload[name])) ||
        !(0 < payload.auth_time && payload.auth_time <= payload.iat && payload.iat < payload.exp) ||
        payload.exp - payload.iat > 3600 || payload.iat > Date.now() / 1000) invalid()
    if (use === 'access' && (payload.client_id !== clientId || 'aud' in payload ||
        typeof payload.scope !== 'string' || !payload.scope.split(/\s+/).includes(USER_SCOPE))) invalid()
    if (use === 'id' && payload.aud !== clientId) invalid()
    return payload
  }
  async function verifyResponse(data, { nonce, previous } = {}) {
    if (data.token_type !== 'Bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 3600) invalid()
    const [access, id] = await Promise.all([claims(data.access_token, 'access'), claims(data.id_token, 'id')])
    if (access.sub !== id.sub || access.auth_time !== id.auth_time || id.email_verified !== true ||
        typeof id.email !== 'string' || !id.email || id.email.length > 320 ||
        (nonce !== undefined && id.nonce !== nonce) || (previous && id.sub !== previous.subject)) invalid()
    if ('at_hash' in id && id.at_hash !== createHash('sha256').update(data.access_token).digest().subarray(0, 16).toString('base64url')) invalid()
    const refreshToken = data.refresh_token === undefined && previous ? previous.refreshToken : data.refresh_token
    if (!token(refreshToken)) invalid()
    return { accessToken: data.access_token, refreshToken, subject: id.sub,
      userId: `cognito:${poolId}:${id.sub}`, email: id.email,
      expiresAt: Math.min(access.exp, id.exp, Math.floor(Date.now() / 1000) + data.expires_in) * 1000 }
  }
  function post(path, fields, allowEmpty = false) {
    return boundedJson(AUTH_ORIGIN + path, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString() }, allowEmpty)
  }
  return {
    async exchange(request) {
      try {
        if (typeof request.body !== 'string' || request.body.length > 4096) invalid()
        const fields = new URLSearchParams(request.body)
        const allowed = ['grant_type', 'client_id', 'redirect_uri', 'code', 'code_verifier']
        if ([...fields].length !== allowed.length || allowed.some(name => fields.getAll(name).length !== 1) ||
            !token(fields.get('code')) || fields.get('code').length > 2048 ||
            !/^[A-Za-z0-9_-]{43}$/.test(fields.get('code_verifier'))) invalid()
        if (fields.get('client_id') !== clientId || fields.get('redirect_uri') !== CALLBACK_URL ||
            fields.get('grant_type') !== 'authorization_code' || !/^[A-Za-z0-9_-]{43}$/.test(request.nonce)) invalid()
        const data = await post('/oauth2/token', Object.fromEntries(fields))
        return await verifyResponse(data, { nonce: request.nonce })
      } catch { invalid() }
    },
    async refresh(previous) {
      try {
        if (!previous || !token(previous.refreshToken) || !UUID.test(previous.subject)) invalid()
        const data = await post('/oauth2/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: previous.refreshToken })
        return await verifyResponse(data, { previous })
      } catch { invalid() }
    },
    async revoke(refreshToken) {
      try {
        if (!token(refreshToken)) invalid()
        await post('/oauth2/revoke', { client_id: clientId, token: refreshToken }, true)
      } catch { throw new Error('Local sign-out completed, but session revocation could not be confirmed.') }
    },
  }
}

module.exports = { createNativeAuthClient }
