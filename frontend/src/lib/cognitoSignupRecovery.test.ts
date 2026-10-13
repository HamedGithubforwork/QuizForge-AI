import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmSignupCode, resendSignupCode, signUpWithEmail, normalizedVerificationEmail, ExistingCognitoAccountError, passwordRequirements } from './cognitoSignupRecovery.ts'

type Reply = { status: number; data?: object }
async function withCognito(responses: Reply[], run: (requests: Array<{
  operation: string
  body: Record<string, string>
}>) => Promise<void>) {
  const original = globalThis.fetch
  const requests: Array<{ operation: string; body: Record<string, string> }> = []
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://cognito-idp.ca-central-1.amazonaws.com/')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.redirect, 'error')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['Content-Type'], 'application/x-amz-json-1.1')
    const operation = headers['X-Amz-Target'].split('.').pop()!
    requests.push({ operation, body: JSON.parse(init?.body as string) })
    const reply = responses.shift()
    assert.ok(reply, 'Unexpected Cognito request')
    return new Response(JSON.stringify(reply.data ?? {}), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await run(requests)
    assert.equal(responses.length, 0, 'Unconsumed mock responses')
  } finally {
    globalThis.fetch = original
  }
}

test('resend and confirmation use only the exact browser public client and entered email/code', async () => {
  await withCognito([{ status: 200 }, { status: 200 }], async requests => {
    await resendSignupCode('browserclient123', ' Learner@Example.com ')
    await confirmSignupCode('browserclient123', ' Learner@Example.com ', ' 123456 ')
    assert.deepEqual(requests, [
      { operation: 'ResendConfirmationCode', body: {
        ClientId: 'browserclient123', Username: 'learner@example.com',
      } },
      { operation: 'ConfirmSignUp', body: {
        ClientId: 'browserclient123', Username: 'learner@example.com', ConfirmationCode: '123456',
      } },
    ])
    assert.ok(requests.every(request =>
      !Object.keys(request.body).some(key => /password|secret|token|api.?key/i.test(key))))
  })
})

test('malformed inputs are rejected before any network call', async () => {
  await withCognito([], async () => {
    for (const value of ['', 'a', 'hello world', 'x'.repeat(255), '@example.com']) {
      await assert.rejects(resendSignupCode('browserclient123', value))
    }
    for (const value of ['', '12345', '123456789', 'bad code', '<script>']) {
      await assert.rejects(confirmSignupCode('browserclient123', 'learner@example.com', value))
    }
    for (const client of ['', '../bad', 'CLIENT-ID', 'x'.repeat(129)]) {
      await assert.rejects(resendSignupCode(client, 'learner@example.com'))
    }
    assert.equal(normalizedVerificationEmail(' Test@Example.COM '), 'test@example.com')
  })
})

test('expired and incorrect verification codes provide safe corrective feedback', async () => {
  await withCognito([
    { status: 400, data: { __type: 'com.amazonaws#ExpiredCodeException', message: 'internal token' } },
    { status: 400, data: { __type: 'CodeMismatchException', message: 'sensitive details' } },
    { status: 400, data: { __type: 'LimitExceededException' } },
    { status: 400, data: { __type: 'UserNotFoundException', message: 'private account state' } },
  ], async () => {
    await assert.rejects(confirmSignupCode('browserclient123', 'learner@example.com', '123456'), /expired/)
    await assert.rejects(confirmSignupCode('browserclient123', 'learner@example.com', '654321'), /not accepted/)
    await assert.rejects(resendSignupCode('browserclient123', 'learner@example.com'), /Too many attempts/)
    await assert.rejects(resendSignupCode('browserclient123', 'learner@example.com'), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Could not complete verification/)
      assert.doesNotMatch(error.message, /UserNotFound|private account state/)
      return true
    })
  })
})

test('network and malformed provider responses fail closed', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('sensitive network detail') }
  try {
    await assert.rejects(resendSignupCode('browserclient123', 'learner@example.com'), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /sensitive/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
  await withCognito([{ status: 500, data: { message: 'private credential' } }], async () => {
    await assert.rejects(confirmSignupCode('browserclient123', 'learner@example.com', '123456'), /Could not complete verification/)
  })
})

test('signup uses only the public Cognito client and a single direct user registration request', async () => {
  await withCognito([{ status: 200, data: { UserConfirmed: false, UserSub: 'synthetic' } }], async requests => {
    const result = await signUpWithEmail('browserclient123', ' Learner@Example.com ', 'SyntheticPassword1!')
    assert.deepEqual(result, { email: 'learner@example.com', confirmed: false })
    assert.deepEqual(requests, [{ operation: 'SignUp', body: {
      ClientId: 'browserclient123', Username: 'learner@example.com', Password: 'SyntheticPassword1!',
      UserAttributes: [{ Name: 'email', Value: 'learner@example.com' }],
    } }])
    assert.ok(!('SecretHash' in requests[0].body))
  })
})

test('signup cannot silently accept a malformed success and preserves confirmed accounts', async () => {
  await withCognito([
    { status: 200, data: { UserConfirmed: true } },
    { status: 200, data: {} },
  ], async requests => {
    assert.deepEqual(await signUpWithEmail('browserclient123', 'learner@example.com', 'ValidPassword1!'),
      { email: 'learner@example.com', confirmed: true })
    await assert.rejects(signUpWithEmail('browserclient123', 'learner@example.com', 'ValidPassword1!'),
      /could not be verified/)
    assert.equal(requests.length, 2)
  })
})

test('duplicate users and password-policy failures get safe corrective guidance', async () => {
  await withCognito([
    { status: 400, data: { __type: 'UsernameExistsException', message: 'private account detail' } },
    { status: 400, data: { __type: 'InvalidPasswordException', message: 'private password detail' } },
    { status: 400, data: { __type: 'InternalErrorException', message: 'private provider error' } },
  ], async () => {
    await assert.rejects(signUpWithEmail('browserclient123', 'learner@example.com', 'ValidPassword1!'), error => {
      assert.ok(error instanceof Error)
      assert.ok(error instanceof ExistingCognitoAccountError)
      assert.match(error.message, /original email code|earlier verification code/)
      assert.doesNotMatch(error.message, /private account detail/)
      return true
    })
    await assert.rejects(signUpWithEmail('browserclient123', 'learner@example.com', 'ValidPassword1!'),
      /requirements/)
    await assert.rejects(signUpWithEmail('browserclient123', 'learner@example.com', 'ValidPassword1!'), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /private provider error/)
      return true
    })
  })
  await withCognito([], async () => {
    await assert.rejects(signUpWithEmail('browserclient123', 'bad email', 'ValidPassword1!'))
    await assert.rejects(signUpWithEmail('browserclient123', 'learner@example.com', 'short'))
    await assert.rejects(signUpWithEmail('invalid-client', 'learner@example.com', 'ValidPassword1!'))
  })
})

test('live password requirements match staging Cognito policy and permit interior spaces only', () => {
  const rules = passwordRequirements('')
  assert.deepEqual(rules, { lowercase: false, uppercase: false, number: false,
    length: false, symbol: false, noEdgeSpaces: true })
  assert.deepEqual(passwordRequirements('Abcdef1!'), { lowercase: true, uppercase: true, number: true,
    length: true, symbol: true, noEdgeSpaces: true })
  assert.equal(passwordRequirements('Abcdef1 ').noEdgeSpaces, false)
  assert.equal(passwordRequirements(' Abcdef1').noEdgeSpaces, false)
  assert.equal(passwordRequirements('Abc def1').symbol, true)
  assert.equal(passwordRequirements('Abc def1').noEdgeSpaces, true)
  assert.equal(passwordRequirements('abcdefgh').uppercase, false)
  assert.equal(passwordRequirements('ABCDEFGH1!').lowercase, false)
  assert.equal(passwordRequirements('Abcdefgh!').number, false)
  assert.equal(passwordRequirements('Abcdef1').symbol, false)
  assert.equal(passwordRequirements('Abcd1!').length, false)
  assert.equal(passwordRequirements('Ébcdef12').symbol, false)
})
