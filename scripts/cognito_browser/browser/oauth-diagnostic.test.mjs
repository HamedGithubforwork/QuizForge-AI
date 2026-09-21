import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthDiagnostic } from './oauth-diagnostic.mjs'
const provider='https://synthetic.auth.example.com', app='http://localhost:4174'

test('diagnostics discard secrets and unknown provider error text',()=>{
  const diagnostic=oauthDiagnostic(provider,app)
  diagnostic.request(provider+'/oauth2/authorize?login_hint=private@example.com&nonce=secret-nonce','GET')
  diagnostic.request(app+'/auth/callback?code=secret-code&state=secret-state&error=private@example.com','GET')
  diagnostic.request(provider+'/oauth2/token?token=secret-token','POST')
  diagnostic.tokenResponse(400); diagnostic.tokenFailure()
  const result=diagnostic.snapshot(), serialized=JSON.stringify(result)
  assert.equal(result.callback_error,'other')
  assert.equal(result.token_http_status,400)
  assert.equal(result.token_requested,true)
  assert.equal(result.token_transport_failed,true)
  for(const secret of ['private','secret-','example.com','nonce','state=']) assert(!serialized.includes(secret))
})

test('unrelated responses cannot imply token exchange success and snapshots are isolated',()=>{
  const diagnostic=oauthDiagnostic(provider,app)
  diagnostic.request('https://unrelated.example.com/oauth2/token','POST')
  assert.equal(diagnostic.snapshot().token_requested,false)
  diagnostic.request(app+'/auth/callback?error=access_denied&error_description=private','GET')
  assert.equal(diagnostic.snapshot().callback_error,'access_denied')
  diagnostic.tokenResponse(200,true)
  const snapshot=diagnostic.snapshot(); snapshot.token_http_status=999
  assert.equal(diagnostic.snapshot().token_http_status,200)
  assert.equal(diagnostic.snapshot().token_json_valid,true)
})
