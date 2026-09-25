import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticatorSetupUri,
  beginMigratedActivation,
  finishMigratedActivation,
  type MigratedActivationSetup,
} from './cognitoActivation.ts'

const originalFetch = globalThis.fetch

// Production enables USER_PASSWORD_AUTH only so an imported hash can complete its one-time MFA_SETUP challenge.

function jsonResponse(value: object, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('first imported-password sign-in completes MFA setup without persisting tokens', async () => {
  const requests: Array<{ target: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (_url, init) => {
    const headers = new Headers(init?.headers)
    const target = headers.get('X-Amz-Target') || ''
    const body = JSON.parse(String(init?.body || '{}'))
    requests.push({ target, body })

    if (target.endsWith('.InitiateAuth')) {
      return jsonResponse({
        ChallengeName: 'MFA_SETUP',
        Session: 'first-session',
        ChallengeParameters: { USERNAME: 'canonical-user' },
      })
    }
    if (target.endsWith('.AssociateSoftwareToken')) {
      return jsonResponse({
        SecretCode: 'JBSWY3DPEHPK3PXP',
        Session: 'association-session',
      })
    }
    if (target.endsWith('.VerifySoftwareToken')) {
      return jsonResponse({
        Status: 'SUCCESS',
        Session: 'verified-session',
      })
    }
    if (target.endsWith('.RespondToAuthChallenge')) {
      return jsonResponse({
        AuthenticationResult: {
          AccessToken: 'temporary-access-token',
          RefreshToken: 'temporary-refresh-token',
        },
      })
    }
    if (target.endsWith('.GlobalSignOut')) {
      return jsonResponse({})
    }
    return jsonResponse({ __type: 'UnexpectedOperation' }, 400)
  }) as typeof fetch

  const setup = await beginMigratedActivation(
    'client123',
    'Existing@Example.com ',
    'old-password',
  )

  assert.equal(setup.kind, 'totp_setup')
  if (setup.kind !== 'totp_setup') throw new Error('expected setup')
  assert.equal(setup.email, 'existing@example.com')
  assert.equal(setup.username, 'canonical-user')
  assert.equal(setup.secret, 'JBSWY3DPEHPK3PXP')

  await finishMigratedActivation(
    'client123',
    setup,
    '123456',
  )

  assert.deepEqual(
    requests.map((item) => item.target.split('.').pop()),
    [
      'InitiateAuth',
      'AssociateSoftwareToken',
      'VerifySoftwareToken',
      'RespondToAuthChallenge',
      'GlobalSignOut',
    ],
  )
  const first = requests[0].body
  assert.equal(first.AuthFlow, 'USER_PASSWORD_AUTH')
  assert.deepEqual(first.AuthParameters, {
    USERNAME: 'existing@example.com',
    PASSWORD: 'old-password',
  })
  assert.deepEqual(
    requests[3].body.ChallengeResponses,
    { USERNAME: 'canonical-user' },
  )
})

test('existing MFA directs the user back to normal sign-in', async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'mfa-session',
    })) as typeof fetch

  const result = await beginMigratedActivation(
    'client123',
    'user@example.com',
    'old-password',
  )
  assert.deepEqual(result, { kind: 'already_ready' })
})

test('wrong authenticator code is reported without provider details', async () => {
  globalThis.fetch = (async (_url, init) => {
    const target = new Headers(init?.headers).get('X-Amz-Target') || ''
    if (target.endsWith('.VerifySoftwareToken')) {
      return jsonResponse({
        __type: 'CodeMismatchException',
        message: 'provider detail should not escape',
      }, 400)
    }
    return jsonResponse({})
  }) as typeof fetch

  const setup: MigratedActivationSetup = {
    kind: 'totp_setup',
    email: 'user@example.com',
    username: 'user@example.com',
    session: 'setup-session',
    secret: 'JBSWY3DPEHPK3PXP',
  }

  await assert.rejects(
    () => finishMigratedActivation(
      'client123',
      setup,
      '123456',
    ),
    /authenticator code was not accepted/i,
  )
})

test('setup URI stays local and contains the expected TOTP parameters', () => {
  const setup: MigratedActivationSetup = {
    kind: 'totp_setup',
    email: 'user@example.com',
    username: 'user@example.com',
    session: 'session',
    secret: 'JBSWY3DPEHPK3PXP',
  }
  const uri = new URL(authenticatorSetupUri(setup))
  assert.equal(uri.protocol, 'otpauth:')
  assert.equal(uri.hostname, 'totp')
  assert.equal(uri.searchParams.get('secret'), setup.secret)
  assert.equal(uri.searchParams.get('issuer'), 'Quiz From Notes')
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1')
  assert.equal(uri.searchParams.get('digits'), '6')
  assert.equal(uri.searchParams.get('period'), '30')
})
