'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { expectedConfiguration, validateDescription } = require('../scripts/native-client-config.cjs')
const pool = 'ca-central-1_Synthetic'
function fixture() {
  const config = expectedConfiguration(pool)
  delete config.GenerateSecret
  return { UserPoolClient: { ...config, ClientId: 'desktop123', CreationDate: 1, LastModifiedDate: 1 } }
}
test('generates the secretless code-only native client and accepts matching AWS description', () => {
  const config = expectedConfiguration(pool)
  assert.equal(config.GenerateSecret, false)
  assert.deepEqual(config.AllowedOAuthFlows, ['code'])
  assert.equal(validateDescription(fixture(), pool, 'web123'), true)
  const reordered = fixture()
  reordered.UserPoolClient.AllowedOAuthScopes.reverse()
  reordered.UserPoolClient.RefreshTokenRotation.RetryGracePeriodSeconds = 0
  assert.equal(validateDescription(reordered, pool, 'web123'), true)
})
test('rejects callback, client, secret, flow, permission and lifetime drift generically', () => {
  for (const change of [
    c => { c.UnknownSecurityOption = true }, c => { c.AuthSessionValidity = 15 },
    c => { c.ClientSecret = 'private' }, c => { c.ClientId = 'web123' }, c => { c.UserPoolId = 'ca-central-1_Other' },
    c => { c.CallbackURLs.push('https://untrusted.invalid') }, c => { c.LogoutURLs = [] },
    c => { c.AllowedOAuthFlows.push('implicit') }, c => { c.AllowedOAuthFlowsUserPoolClient = false },
    c => { c.ExplicitAuthFlows.push('ALLOW_USER_PASSWORD_AUTH') }, c => { c.AllowedOAuthScopes.push('profile') },
    c => { c.EnableTokenRevocation = false }, c => { c.PreventUserExistenceErrors = 'LEGACY' },
    c => { c.AccessTokenValidity = 60 }, c => { c.RefreshTokenValidity = 30 },
    c => { c.TokenValidityUnits.AccessToken = 'hours' }, c => { delete c.ReadAttributes },
    c => { c.WriteAttributes.push('custom:role') }, c => { c.SupportedIdentityProviders.push('Google') },
    c => { c.RefreshTokenRotation.Feature = 'ENABLED' }, c => { c.AnalyticsConfiguration = {} },
    c => { c.DefaultRedirectURI = 'https://untrusted.invalid' }, c => { c.EnablePropagateAdditionalUserContextData = true },
  ]) {
    const input = fixture(); change(input.UserPoolClient)
    assert.throws(() => validateDescription(input, pool, 'web123'), { message: 'Native client configuration does not match the reviewed policy.' })
  }
  assert.throws(() => expectedConfiguration('us-east-1_Other'))
})

test('CLI verifies bounded files and does not echo sensitive malformed inputs', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { spawnSync } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfn-client-config-'))
  const filename = path.join(directory, 'description.json')
  const script = path.join(__dirname, '../scripts/native-client-config.cjs')
  try {
    fs.writeFileSync(filename, JSON.stringify(fixture()))
    const valid = spawnSync(process.execPath, [script, 'verify', pool, 'web123', filename], { encoding: 'utf8' })
    assert.equal(valid.status, 0)
    assert.match(valid.stdout, /^PASS:/)
    const invalid = fixture(); invalid.UserPoolClient.ClientSecret = 'PRIVATE-MARKER'
    for (const raw of [JSON.stringify(invalid), JSON.stringify(fixture()) + ' '.repeat(65_537), 'PRIVATE-MARKER']) {
      fs.writeFileSync(filename, raw)
      const result = spawnSync(process.execPath, [script, 'verify', pool, 'web123', filename], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.doesNotMatch(result.stderr, /PRIVATE-MARKER/)
    }
    const generated = spawnSync(process.execPath, [script, 'generate', pool], { encoding: 'utf8' })
    assert.equal(generated.status, 0)
    assert.deepEqual(JSON.parse(generated.stdout), expectedConfiguration(pool))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
