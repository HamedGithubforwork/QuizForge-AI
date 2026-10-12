import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmSignupCode, resendSignupCode, normalizedVerificationEmail } from './cognitoSignupRecovery.ts'

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
