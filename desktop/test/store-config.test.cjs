'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require.resolve('../build/store.cjs')
const source = readFileSync(path, 'utf8')
const valid = { QFN_STORE_IDENTITY_NAME: 'QuizFromNotes.CITest', QFN_STORE_PUBLISHER: 'CN=QuizFromNotes CI Test',
  QFN_STORE_PUBLISHER_DISPLAY_NAME: 'CI Test Only', QFN_STORE_DISPLAY_NAME: 'Quiz From Notes CI Test' }
function config(env) {
  const context = { process: { env }, module: { exports: {} }, require: createRequire(path) }
  vm.runInNewContext(source, context)
  return context.module.exports
}
test('Store packaging requires explicit identity and rejects XML injection', () => {
  for (const key of Object.keys(valid)) {
    assert.throws(() => config({ ...valid, [key]: '' }), /exact Partner Center value/)
    assert.throws(() => config({ ...valid, [key]: 'bad<value' }), /exact Partner Center value/)
  }
  const c = config(valid)
  assert.equal(c.publish, null)
  assert.equal(c.win.target[0].target, 'appx')
  assert.equal(c.appx.publisher, valid.QFN_STORE_PUBLISHER)
  assert.equal(c.appx.identityName, valid.QFN_STORE_IDENTITY_NAME)
  assert.equal(c.protocols[0].schemes[0], require('../src/native-protocol.cjs').PROTOCOL)
  assert.equal(c.appx.addAutoLaunchExtension, false)
  assert.equal(c.appx.setBuildNumber, false)
})
