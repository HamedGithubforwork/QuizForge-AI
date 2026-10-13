import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CognitoPasswordSession } from './cognitoPasswordSession.ts'

const sub = '00000000-0000-0000-0000-000000000101'
const user = { UserAttributes: [{ Name: 'sub', Value: sub }, { Name: 'email', Value: 'learner@example.com' },
  { Name: 'email_verified', Value: 'true' }] }
const auth = { AuthenticationResult: { AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 300 } }
const make = () => new CognitoPasswordSession('browserclient123', 'ca-central-1_Test')
type Reply = { error?: string; [key: string]: unknown }
async function mock(replies: Reply[], run: (calls: Array<{ operation: string; body: any }>) => Promise<void>) {
  const original = globalThis.fetch
  const calls: Array<{ operation: string; body: any }> = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://cognito-idp.ca-central-1.amazonaws.com/')
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error')
    calls.push({ operation: (init!.headers as Record<string, string>)['X-Amz-Target'].split('.').pop()!,
      body: JSON.parse(init?.body as string) })
    const reply = replies.shift()
    assert.ok(reply, 'Unexpected request')
    return new Response(JSON.stringify(reply.error ? { __type: reply.error, message: 'private provider detail' } : reply),
      { status: reply.error ? 400 : 200 })
  }
  try { await run(calls); assert.equal(replies.length, 0) } finally { globalThis.fetch = original }
}

test('only UserNotConfirmedException enters email confirmation; wrong credentials stay generic', async () => {
  await mock([{ error: 'com.amazonaws#UserNotConfirmedException' }, { error: 'NotAuthorizedException' },
    { error: 'UserNotFoundException' }, { error: 'PasswordResetRequiredException' }], async calls => {
    const client = make()
    assert.deepEqual(await client.begin(' Learner@Example.com ', 'password'), { kind: 'confirm-email', email: 'learner@example.com' })
    assert.equal(await client.session(), null)
    for (let i = 0; i < 2; i++) await assert.rejects(client.begin('learner@example.com', 'wrong'), /Sign-in failed/)
    await assert.rejects(client.begin('learner@example.com', 'password'), /Reset your password/)
    assert.equal(calls[0].body.AuthFlow, 'USER_PASSWORD_AUTH')
    assert.deepEqual(calls[0].body.AuthParameters, { USERNAME: 'learner@example.com', PASSWORD: 'password' })
  })
})

test('verified password sessions refresh once concurrently, omit secrets and revoke on sign-out', async () => {
  await mock([auth, user, { AuthenticationResult: { AccessToken: 'new-access', ExpiresIn: 300 } }, user, {}], async calls => {
    const client = make()
    assert.deepEqual(await client.begin('learner@example.com', 'password'), { kind: 'ready' })
    assert.equal(client.active, true)
    assert.deepEqual(await client.session(), { accessToken: 'access', userId: `cognito:ca-central-1_Test:${sub}`, email: 'learner@example.com' })
    const [first, second] = await Promise.all([client.session(true), client.session(true)])
    assert.equal(first?.accessToken, 'new-access'); assert.deepEqual(first, second)
    assert.deepEqual(calls[2].body, { ClientId: 'browserclient123', AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: 'refresh' } })
    await client.signOut()
    assert.deepEqual(calls.at(-1), { operation: 'RevokeToken', body: { ClientId: 'browserclient123', Token: 'refresh' } })
    assert.equal(await client.session(), null)
  })
})

test('MFA selection and incorrect codes cannot establish a session', async () => {
  await mock([
    { ChallengeName: 'SELECT_MFA_TYPE', Session: 'select', ChallengeParameters: { MFAS_CAN_CHOOSE: '["SOFTWARE_TOKEN_MFA"]', USERNAME: 'canonical' } },
    { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'factor', ChallengeParameters: { USERNAME: 'canonical' } },
    { error: 'CodeMismatchException' }, auth, user,
  ], async calls => {
    const client = make()
    const choice = await client.begin('learner@example.com', 'password')
    assert.equal(choice.kind, 'select-mfa'); if (choice.kind !== 'select-mfa') return
    await assert.rejects(client.respond(choice, 'SMS_MFA'), /valid verification/)
    const factor = await client.respond(choice, 'SOFTWARE_TOKEN_MFA')
    assert.equal(factor.kind, 'mfa'); if (factor.kind !== 'mfa') return
    assert.equal(await client.session(), null)
    await assert.rejects(client.respond(factor, '000000'), /not accepted/)
    assert.equal(await client.session(), null)
    assert.deepEqual(await client.respond(factor, '123456'), { kind: 'ready' })
    assert.deepEqual(calls[3].body.ChallengeResponses, { USERNAME: 'canonical', SOFTWARE_TOKEN_MFA_CODE: '123456' })
  })
})

test('unverified identities, malformed sessions and unsupported challenges fail closed', async () => {
  for (const result of [
    { AuthenticationResult: { AccessToken: 'access' } },
    { AuthenticationResult: { ...auth.AuthenticationResult, ExpiresIn: 99999 } },
  ]) await mock([result, ...('RefreshToken' in result.AuthenticationResult ? [{}] : [])], async () => {
    const client = make()
    await assert.rejects(client.begin('learner@example.com', 'password'))
    assert.equal(await client.session(), null)
  })
  await mock([auth, { UserAttributes: user.UserAttributes.filter(x => x.Name !== 'email_verified') }, {}], async () => {
    const client = make(); await assert.rejects(client.begin('learner@example.com', 'password'), /identity/)
    assert.equal(client.active, false)
  })
  await mock([{ ChallengeName: 'NEW_PASSWORD_REQUIRED' }], async () => {
    await assert.rejects(make().begin('learner@example.com', 'password'), /not supported/)
  })
  await mock([], async () => {
    await assert.rejects(make().begin('invalid', 'password'))
    await assert.rejects(make().begin('learner@example.com', ''))
  })
})

test('refresh failure and wrong-user refresh clear the session', async () => {
  for (const replies of [ [{ error: 'NotAuthorizedException' }],
    [auth, { UserAttributes: user.UserAttributes.map(x => x.Name === 'sub' ? { ...x, Value: sub.replace(/101$/, '102') } : x) }] ]) {
    await mock([auth, user, ...replies], async () => {
      const client = make(); await client.begin('learner@example.com', 'password')
      assert.equal(await client.session(true), null); assert.equal(client.active, false)
    })
  }
})

test('cancellation rejects and revokes a late successful login without retaining tokens', async () => {
  await mock([auth, {}], async calls => {
    const client = make()
    const signingIn = client.begin('learner@example.com', 'password')
    client.cancel()
    await assert.rejects(signingIn, /cancelled/)
    assert.equal(await client.session(), null)
    assert.equal(calls.at(-1)?.operation, 'RevokeToken')
  })
})

test('sign-out during refresh cannot restore the old session, even when revocation fails', async () => {
  await mock([auth, user, auth, { error: 'NotAuthorizedException' }, user], async () => {
    const client = make(); await client.begin('learner@example.com', 'password')
    const refreshing = client.session(true)
    await assert.rejects(client.signOut())
    assert.equal(await refreshing, null); assert.equal(await client.session(), null)
  })
})
