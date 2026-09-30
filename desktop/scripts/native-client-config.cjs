'use strict'
// Offline configuration generator/checker. Never makes AWS calls or prints input.
const fs = require('node:fs')
const { isDeepStrictEqual } = require('node:util')
const { CALLBACK_URL } = require('../src/native-auth-attempt.cjs')
const { APP_ORIGIN } = require('../src/policy.cjs')
function fail() { throw new Error('Native client configuration does not match the reviewed policy.') }
function expectedConfiguration(poolId) {
  if (typeof poolId !== 'string' || !/^ca-central-1_[A-Za-z0-9]{1,55}$/.test(poolId)) fail()
  return {
    UserPoolId: poolId, ClientName: 'quiz-from-notes-desktop-preview', GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: ['openid', 'email', 'aws.cognito.signin.user.admin'],
    SupportedIdentityProviders: ['COGNITO'], CallbackURLs: [CALLBACK_URL], LogoutURLs: [APP_ORIGIN + '/'],
    ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'], PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true,
    ReadAttributes: ['email', 'email_verified', 'sub'], WriteAttributes: ['email'],
    AuthSessionValidity: 5, AccessTokenValidity: 5, IdTokenValidity: 5, RefreshTokenValidity: 1,
    TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'hours' },
    RefreshTokenRotation: { Feature: 'DISABLED' },
  }
}
function validateDescription(input, poolId, webClientId) {
  if (!input || typeof input !== 'object' || typeof webClientId !== 'string' || !/^[a-z0-9]{1,128}$/.test(webClientId)) fail()
  const client = input.UserPoolClient
  if (!client || typeof client !== 'object' || Object.hasOwn(client, 'ClientSecret') ||
      typeof client.ClientId !== 'string' || !/^[a-z0-9]{1,128}$/.test(client.ClientId) || client.ClientId === webClientId) fail()
  const expected = expectedConfiguration(poolId)
  const known = new Set([...Object.keys(expected).filter(key => key !== 'GenerateSecret'), 'ClientId', 'CreationDate', 'LastModifiedDate', 'DefaultRedirectURI', 'AnalyticsConfiguration', 'EnablePropagateAdditionalUserContextData'])
  if (Object.keys(client).some(key => !known.has(key))) fail()
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'GenerateSecret') continue // Describe returns ClientSecret only for confidential clients.
    if (Array.isArray(value)) {
      if (!Array.isArray(client[key]) || !isDeepStrictEqual([...client[key]].sort(), [...value].sort())) fail()
    } else if (key === 'RefreshTokenRotation') {
      if (!isDeepStrictEqual(client[key], value) && !isDeepStrictEqual(client[key], { ...value, RetryGracePeriodSeconds: 0 })) fail()
    } else if (!isDeepStrictEqual(client[key], value)) fail()
  }
  if (client.AnalyticsConfiguration || client.EnablePropagateAdditionalUserContextData === true ||
      (client.DefaultRedirectURI && client.DefaultRedirectURI !== CALLBACK_URL)) fail()
  return true
}
if (require.main === module) {
  try {
    const [command, poolId, webClientId, filename, ...extra] = process.argv.slice(2)
    if (command === 'generate' && poolId && !webClientId && !filename && extra.length === 0) {
      process.stdout.write(JSON.stringify(expectedConfiguration(poolId), null, 2) + '\n')
    } else if (command === 'verify' && poolId && webClientId && filename && extra.length === 0) {
      const fd = fs.openSync(filename, 'r')
      let raw
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.size > 65_536) fail()
        const buffer = Buffer.alloc(65_537)
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
        if (length > 65_536) fail()
        raw = buffer.subarray(0, length).toString('utf8')
      } finally { fs.closeSync(fd) }
      validateDescription(JSON.parse(raw), poolId, webClientId)
      process.stdout.write('PASS: dedicated native client matches the reviewed policy. No settings changed.\n')
    } else fail()
  } catch {
    process.stderr.write('Native client configuration check failed. Use generate <pool-id> or verify <pool-id> <web-client-id> <description.json>. Input values are not logged.\n')
    process.exitCode = 1
  }
}
module.exports = { expectedConfiguration, validateDescription }
