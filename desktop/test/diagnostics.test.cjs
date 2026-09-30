'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDiagnostics, showDiagnostics } = require('../src/diagnostics.cjs')
const metadata = { appVersion: '0.1.0', electronVersion: '44.5.0', chromeVersion: '151.0.1.0', platform: 'win32', arch: 'x64', packaged: true }

test('reports bounded session events without retaining navigation or failure details', () => {
  const diagnostics = createDiagnostics(metadata)
  const contents = new EventEmitter()
  diagnostics.attach(contents)
  contents.emit('did-finish-load')
  contents.emit('did-fail-load', {}, -3, 'private error', 'https://private/?code=secret', true)
  contents.emit('did-fail-load', {}, -105, 'private error', 'https://private/?code=secret', false)
  contents.emit('did-fail-load', {}, -105, 'private error', 'https://private/?code=secret', true)
  contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 999, secret: 'private' })
  assert.deepEqual(JSON.parse(diagnostics.report()), { schema: 1, ...metadata, pageLoads: 1, pageLoadFailures: 1, rendererExits: 1, lastRendererExit: 'oom' })
  contents.emit('render-process-gone', {}, { reason: 'private' })
  assert.equal(JSON.parse(diagnostics.report()).lastRendererExit, 'unknown')
  assert.doesNotMatch(diagnostics.report(), /private|secret|999|https/)
  for (let n = 0; n < 1_000_001; n++) contents.emit('did-finish-load')
  assert.equal(JSON.parse(diagnostics.report()).pageLoads, 1_000_000)
  assert.equal(JSON.parse(createDiagnostics(metadata).report()).pageLoads, 0)
})

test('metadata is allowlisted and never serializes arbitrary values', () => {
  const diagnostics = createDiagnostics({ appVersion: 'private', electronVersion: 'private', chromeVersion: 'private', platform: 'private', arch: 'private', packaged: 'private', token: 'private' })
  assert.doesNotMatch(diagnostics.report(), /private|token/)
  assert.equal(JSON.parse(diagnostics.report()).packaged, false)
})

test('native diagnostics copies only the displayed report after explicit selection', async () => {
  const diagnostics = createDiagnostics(metadata)
  let copied
  let displayed
  for (const response of [0, 1]) {
    await showDiagnostics({ diagnostics,
      dialog: { showMessageBox: async options => { displayed = options; return { response } } },
      clipboard: { writeText: async text => { copied = text } },
    })
    assert.equal(copied, response === 1 ? diagnostics.report() : undefined)
    assert.equal(displayed.detail.endsWith(diagnostics.report()), true)
  }
})

test('clipboard failure is handled without echoing the native error', async () => {
  const messages = []
  await showDiagnostics({ diagnostics: createDiagnostics(metadata),
    dialog: { showMessageBox: async options => { messages.push(options); return { response: 1 } } },
    clipboard: { writeText: async () => { throw new Error('private clipboard error') } },
  })
  assert.equal(messages.length, 2)
  assert.doesNotMatch(JSON.stringify(messages), /private clipboard error/)
})
