import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beginCognitoAccountProof, finishCognitoAccountProof } from './cognitoAccountProof.ts'

function withCognitoFetch(responses: Array<Record<string, unknown> | { error: number }>,
                          run: (requests: Array<{ operation: string; body: Record<string, unknown> }>) => Promise<void>) {
  return async () => {
    const original = globalThis.fetch
    const requests: Array<{ operation: string; body: Record<string, unknown> }> = []
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://cognito-idp.ca-central-1.amazonaws.com/')
      assert.equal(init?.credentials, 'omit')
      assert.equal(init?.redirect, 'error')
      const headers = init?.headers as Record<string, string>
      requests.push({ operation: headers['X-Amz-Target'].split('.').pop()!,
        body: JSON.parse(init?.body as string) })
      const next = responses.shift()
      if (!next) throw new Error('Unexpected Cognito request')
      if ('error' in next) return new Response('{}', { status: next.error })
      return new Response(JSON.stringify(next), { status: 200,
        headers: { 'Content-Type': 'application/json' } })
    }
    try { await run(requests); assert.equal(responses.length, 0) }
    finally { globalThis.fetch = original }
  }
}

test('direct Cognito password proof leaves the primary Google OIDC session alone', withCognitoFetch(
  [{ AuthenticationResult: { AccessToken: 'signed-local-access-token' } }],
  async (requests) => {
    assert.deepEqual(await beginCognitoAccountProof('public-client', ' TEST@EXAMPLE.COM ', 'synthetic-pass'),
      { kind: 'ready', accessToken: 'signed-local-access-token' })
    assert.equal(requests[0].operation, 'InitiateAuth')
    assert.deepEqual(requests[0].body, { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'public-client',
      AuthParameters: { USERNAME: 'test@example.com', PASSWORD: 'synthetic-pass' } })
  },
))

test('authenticator, SMS and email MFA require the valid second challenge before proof completion', async () => {
  for (const challenge of ['SOFTWARE_TOKEN_MFA', 'SMS_MFA', 'EMAIL_OTP'] as const) {
    await withCognitoFetch([
      { ChallengeName: challenge, Session: 'challenge-session', ChallengeParameters: { USERNAME: 'canonical-user' } },
      { AuthenticationResult: { AccessToken: 'signed-local-access-token' } },
    ], async (requests) => {
      const started = await beginCognitoAccountProof('public-client', 'test@example.com', 'synthetic-pass')
      assert.equal(started.kind, 'mfa')
      if (started.kind !== 'mfa') return
      assert.equal(started.challenge, challenge)
      await assert.rejects(finishCognitoAccountProof('public-client', started, 'invalid'), /verification code/)
      assert.deepEqual(await finishCognitoAccountProof('public-client', started, '123456'),
        { kind: 'ready', accessToken: 'signed-local-access-token' })
      assert.equal(requests[1].operation, 'RespondToAuthChallenge')
      const codeKey = challenge === 'SOFTWARE_TOKEN_MFA' ? 'SOFTWARE_TOKEN_MFA_CODE'
        : challenge === 'SMS_MFA' ? 'SMS_MFA_CODE' : 'EMAIL_OTP_CODE'
      assert.deepEqual(requests[1].body, { ClientId: 'public-client', ChallengeName: challenge,
        Session: 'challenge-session', ChallengeResponses: { USERNAME: 'canonical-user', [codeKey]: '123456' } })
    })( )
  }
})

test('Cognito proof fails closed for unsupported setup challenges', withCognitoFetch(
  [{ ChallengeName: 'MFA_SETUP', Session: 'setup-session' }],
  async () => {
    await assert.rejects(beginCognitoAccountProof('client', 'test@example.com', 'pass'), /first-time security setup/)
  },
))

test('Cognito proof does not accept an incomplete or unsuccessful MFA response', withCognitoFetch(
  [{ ChallengeName: 'SMS_MFA', Session: 'mfa-session' },
   { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'another-session' }],
  async () => {
    const started = await beginCognitoAccountProof('client', 'test@example.com', 'pass')
    assert.equal(started.kind, 'mfa')
    if (started.kind === 'mfa') {
      await assert.rejects(finishCognitoAccountProof('client', started, '123456'), /not supported/)
    }
  },
))

test('invalid credentials cannot become a linking proof', withCognitoFetch(
  [{ error: 401 }], async () => {
    await assert.rejects(beginCognitoAccountProof('client', 'test@example.com', 'bad'), /verification failed/)
  },
))
