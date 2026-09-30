'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { CALLBACK_URL } = require('../src/native-auth-attempt.cjs')
const { callbackFromArguments, createCallbackReceiver } = require('../src/native-protocol.cjs')
const good = CALLBACK_URL + '?code=synthetic&state=synthetic'

test('OS argument extraction accepts one exact callback and rejects ambiguity or arbitrary navigation', () => {
  assert.equal(callbackFromArguments(['app.exe', good]), good)
  for (const argv of [null, [good, good], [good, good.toUpperCase()], Array(129).fill(good),
    ['https://example.test'], ['--url=' + good], [good + '#fragment'], [good + '\n'],
    [good.replace(':/oauth', '://oauth')], [good.replace('/callback?', '/callback/other?')],
    [good.toUpperCase()], [good + 'a'.repeat(8192)]]) {
    assert.equal(callbackFromArguments(argv), null)
  }
})

test('cold and signed-out launches are discarded without buffering', async () => {
  let calls = 0
  let session = null
  const receive = createCallbackReceiver({ getSession: () => session, focus: () => calls++ })
  assert.equal(await receive([good]), false)
  session = { status: () => ({ signingIn: false }), handleCallback: () => { calls++; return true } }
  assert.equal(await receive([good]), false)
  session = { ...session, status: () => ({ signingIn: true }) }
  assert.equal(calls, 0)
  assert.equal(await receive([good]), true)
  assert.equal(calls, 2)
})

test('only accepted live callbacks focus the app; errors stay private', async () => {
  let focused = 0
  let accepted = false
  const session = { status: () => ({ signingIn: true }), handleCallback: async raw => {
    assert.equal(raw, good)
    if (accepted === 'throw') throw Error('private provider detail')
    return accepted
  } }
  const receive = createCallbackReceiver({ getSession: () => session, focus: () => focused++ })
  assert.equal(await receive([good]), false)
  accepted = 'throw'
  assert.equal(await receive([good]), false)
  assert.equal(focused, 0)
  accepted = true
  assert.equal(await receive([good]), true)
  assert.equal(focused, 1)
})
