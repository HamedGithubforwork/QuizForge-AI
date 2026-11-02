'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDiagnosticHistory } = require('../src/diagnostic-history.cjs')
const { createDiagnostics, showDiagnostics } = require('../src/diagnostics.cjs')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfn-diagnostics-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('failure history survives restart and rejects private data from events and disk', t => {
  const dir = directory(t)
  const history = createDiagnosticHistory({ directory: dir, appVersion: '0.1.6' })
  history.record('validation_failed', { reason: 'duplicate_choices', attempt: 'retry', details: 'private PDF text' })
  history.record('operation_failed', { reason: 'secret_token', operationId: 'private', error: 'secret', filename: 'private.pdf' })
  history.record('private event', { reason: 'private' })
  const file = path.join(dir, 'history.json')
  const records = JSON.parse(fs.readFileSync(file))
  records[1].prompt = 'private text from disk'
  fs.writeFileSync(file, JSON.stringify(records))
  const restored = createDiagnosticHistory({ directory: dir, appVersion: '0.1.6' })
  assert.equal(restored.snapshot().records[1].reason, 'duplicate_choices')
  assert.equal(restored.snapshot().records[2].reason, 'unknown')
  assert.notEqual(restored.snapshot().records[0].sessionId, restored.snapshot().records.at(-1).sessionId)
  assert.doesNotMatch(JSON.stringify(restored.snapshot()), /private|secret|prompt|filename/)
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private|secret|prompt|filename/)
})
test('history is bounded and corrupt or unavailable storage cannot break quiz work', t => {
  const dir = directory(t)
  fs.writeFileSync(path.join(dir, 'history.json'), 'corrupt')
  const history = createDiagnosticHistory({ directory: dir, appVersion: '0.1.6' })
  for (let n = 0; n < 350; n++) history.record('inference_completed', { completionTokens: n, elapsedMs: Infinity })
  assert.equal(history.snapshot().records.length, 300)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'history.json'))).length, 300)
  assert.equal(history.snapshot().records[0].completionTokens, 50)
  assert.ok(fs.statSync(path.join(dir, 'history.json')).size < 512 * 1024)
  const unavailable = createDiagnosticHistory({ directory: path.join(dir, 'history.json', 'blocked') })
  assert.doesNotThrow(() => unavailable.record('operation_failed', { reason: 'timed_out' }))
  assert.equal(unavailable.snapshot().persistence, 'unavailable')
})
test('native save exports history only after choosing a destination; cancel writes nothing', async t => {
  const dir = directory(t)
  const diagnostics = createDiagnostics({ appVersion: '0.1.6' })
  diagnostics.startPersistence(path.join(dir, 'history'))
  diagnostics.record('operation_failed', { reason: 'timed_out' })
  const filePath = path.join(dir, 'report.json')
  for (const canceled of [true, false]) {
    await showDiagnostics({ diagnostics, clipboard: {}, dialog: {
      showMessageBox: async () => ({ response: 2 }), showSaveDialog: async () => ({ canceled, filePath }),
    } })
    assert.equal(fs.existsSync(filePath), !canceled)
  }
  assert.equal(fs.readFileSync(filePath, 'utf8'), diagnostics.report())
})
test('real stack records PDF success/failure with one ID per attempt and no source content', async t => {
  const dir = directory(t)
  const history = createDiagnosticHistory({ directory: path.join(dir, 'diagnostics') })
  let fail = false
  const stack = createWindowsLocalAiStack({ userDataDirectory: dir,
    documentProcessor: { processPdf: async () => {
      if (fail) throw Object.assign(new Error('private document'), { code: 'processing_failed' })
      return { pages: [{ text: 'private document' }] }
    } }, onDiagnostic: history.record,
  })
  await stack.processDocument({ filename: 'private.pdf' })
  fail = true
  await assert.rejects(stack.processDocument({ filename: 'private.pdf' }), { code: 'processing_failed' })
  const events = history.snapshot().records.filter(x => x.kind === 'pdf')
  assert.deepEqual(events.map(x => x.event), ['operation_started', 'operation_completed', 'operation_started', 'operation_failed'])
  assert.equal(events[0].operationId, events[1].operationId)
  assert.equal(events[2].operationId, events[3].operationId)
  assert.notEqual(events[0].operationId, events[2].operationId)
  assert.equal(events[3].reason, 'processing_failed')
  assert.doesNotMatch(JSON.stringify(history.snapshot()), /private/)
  await stack.dispose()
})
