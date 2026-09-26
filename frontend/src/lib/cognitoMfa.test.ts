import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginPhoneVerification,
  beginTotpEnrollment,
  disableMfa,
  getMfaSecurityStatus,
  maskedPhoneNumber,
  setMfaPreference,
  totpSetupUri,
  updateMfaMethods,
  verifyPhoneNumber,
  verifyTotpEnrollment,
} from './cognitoMfa.ts'

const originalFetch = globalThis.fetch

function jsonResponse(value: object, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('reads verified SMS/TOTP status without exposing tokens', async () => {
  globalThis.fetch = (async (_url, init) => {
    const target = new Headers(init?.headers).get('X-Amz-Target') || ''
    assert.match(target, /GetUser$/)
    return jsonResponse({
      UserAttributes: [
        { Name: 'phone_number', Value: '+16135551234' },
        { Name: 'phone_number_verified', Value: 'true' },
      ],
      UserMFASettingList: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA'],
      PreferredMfaSetting: 'SMS_MFA',
    })
  }) as typeof fetch

  const status = await getMfaSecurityStatus('access-token')
  assert.deepEqual(status, {
    phoneNumber: '+16135551234',
    phoneVerified: true,
    smsEnabled: true,
    totpEnabled: true,
    preferred: 'sms',
  })
})

test('starts TOTP enrollment with the signed-in access token', async () => {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return jsonResponse({
      SecretCode: 'JBSWY3DPEHPK3PXP',
    })
  }) as typeof fetch

  const secret = await beginTotpEnrollment('access-token')
  assert.equal(secret, 'JBSWY3DPEHPK3PXP')
  assert.deepEqual(body, { AccessToken: 'access-token' })
})

test('verifies TOTP setup with a six-digit code', async () => {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return jsonResponse({ Status: 'SUCCESS' })
  }) as typeof fetch

  await verifyTotpEnrollment(
    'access-token',
    '123456',
  )
  assert.deepEqual(body, {
    AccessToken: 'access-token',
    UserCode: '123456',
    FriendlyDeviceName: 'Quiz From Notes',
  })
})

test('TOTP setup URI contains expected authenticator parameters', () => {
  const uri = new URL(
    totpSetupUri(
      'JBSWY3DPEHPK3PXP',
      'User@Example.com ',
    ),
  )
  assert.equal(uri.protocol, 'otpauth:')
  assert.equal(uri.hostname, 'totp')
  assert.equal(
    uri.searchParams.get('secret'),
    'JBSWY3DPEHPK3PXP',
  )
  assert.equal(
    uri.searchParams.get('issuer'),
    'Quiz From Notes',
  )
  assert.match(
    decodeURIComponent(uri.pathname),
    /user@example.com/i,
  )
})

test('starts phone verification only when Cognito confirms SMS delivery', async () => {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return jsonResponse({
      CodeDeliveryDetailsList: [
        {
          AttributeName: 'phone_number',
          DeliveryMedium: 'SMS',
          Destination: '+1******1234',
        },
      ],
    })
  }) as typeof fetch

  const phone = await beginPhoneVerification(
    'access-token',
    '+16135551234',
  )
  assert.equal(phone, '+16135551234')
  assert.deepEqual(body, {
    AccessToken: 'access-token',
    UserAttributes: [
      { Name: 'phone_number', Value: '+16135551234' },
    ],
  })
})

test('rejects malformed phone numbers before network access', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return jsonResponse({})
  }) as typeof fetch

  await assert.rejects(
    () => beginPhoneVerification(
      'access-token',
      '613-555-1234',
    ),
    /country code/i,
  )
  assert.equal(called, false)
})

test('verifies six-digit phone code', async () => {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return jsonResponse({})
  }) as typeof fetch

  await verifyPhoneNumber(
    'access-token',
    '123456',
  )
  assert.deepEqual(body, {
    AccessToken: 'access-token',
    AttributeName: 'phone_number',
    Code: '123456',
  })
})

test('switches preference without enabling an unconfigured factor', async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url, init) => {
    bodies.push(
      JSON.parse(
        String(init?.body || '{}'),
      ),
    )
    return jsonResponse({})
  }) as typeof fetch

  await setMfaPreference(
    'access-token',
    'totp',
    {
      smsEnabled: false,
      totpEnabled: true,
    },
  )
  await setMfaPreference(
    'access-token',
    'sms',
    {
      smsEnabled: true,
      totpEnabled: true,
    },
  )

  assert.deepEqual(bodies[0], {
    AccessToken: 'access-token',
    SMSMfaSettings: {
      Enabled: false,
      PreferredMfa: false,
    },
    SoftwareTokenMfaSettings: {
      Enabled: true,
      PreferredMfa: true,
    },
  })
  assert.deepEqual(bodies[1], {
    AccessToken: 'access-token',
    SMSMfaSettings: {
      Enabled: true,
      PreferredMfa: true,
    },
    SoftwareTokenMfaSettings: {
      Enabled: true,
      PreferredMfa: false,
    },
  })
})

test('disables all configured MFA methods', async () => {
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return jsonResponse({})
  }) as typeof fetch

  await disableMfa('access-token')
  assert.deepEqual(body, {
    AccessToken: 'access-token',
    SMSMfaSettings: {
      Enabled: false,
      PreferredMfa: false,
    },
    SoftwareTokenMfaSettings: {
      Enabled: false,
      PreferredMfa: false,
    },
  })
})

test('rejects a preferred method that is disabled', async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return jsonResponse({})
  }) as typeof fetch

  await assert.rejects(
    () => updateMfaMethods(
      'access-token',
      {
        smsEnabled: false,
        totpEnabled: true,
        preferred: 'sms',
      },
    ),
    /cannot be preferred/i,
  )
  assert.equal(called, false)
})

test('provider verification errors are sanitized', async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      __type: 'CodeMismatchException',
      message: 'internal provider message',
    }, 400)) as typeof fetch

  await assert.rejects(
    () => verifyPhoneNumber(
      'access-token',
      '123456',
    ),
    /not accepted/i,
  )
})

test('phone display masks all but the last four digits', () => {
  assert.equal(
    maskedPhoneNumber('+16135551234'),
    '••••1234',
  )
  assert.equal(maskedPhoneNumber(''), '')
})
