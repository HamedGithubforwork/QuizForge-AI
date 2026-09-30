import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopFetch, type DesktopBridge } from './desktop.ts'
test('desktop fetch serializes multipart files and never forwards authorization or arbitrary headers', async () => {
  let captured: unknown
  const bridge = { request: async (request: unknown) => { captured = request; return { status: 200, body: '{"ok":true}', contentType: 'application/json' } } } as DesktopBridge
  const form = new FormData(); form.append('file', new Blob(['pdf']), 'notes.pdf'); form.append('question_count', '5')
  const result = await desktopFetch(bridge, '/api/documents/upload', { method: 'POST', body: form, headers: { Authorization: 'must-not-cross' } })
  assert.deepEqual(await result.json(), { ok: true })
  assert.deepEqual(captured, { path: '/api/documents/upload', method: 'POST', form: [
    { name: 'file', filename: 'notes.pdf', bytes: new Uint8Array([112,100,102]) }, { name: 'question_count', value: '5' },
  ] })
})
test('desktop fetch preserves no-content responses and rejects unsupported or cancelled requests', async () => {
  let calls=0
  const bridge = { request: async () => { calls++; return { status: 204, body: '', contentType: 'application/json' } } } as unknown as DesktopBridge
  assert.equal((await desktopFetch(bridge, '/api/decks/fixture', {method:'DELETE'})).status,204)
  await assert.rejects(desktopFetch(bridge, '/api/decks', {body:new URLSearchParams()}))
  await assert.rejects(desktopFetch(bridge, '/api/decks', {signal:AbortSignal.abort()}))
  assert.equal(calls,1)
})
