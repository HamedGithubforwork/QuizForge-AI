import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopFetch, desktopLocalAiBridge, desktopLocalQuizBridge, desktopSourceTextBridge, type DesktopBridge, type DesktopLocalAiBridge, type DesktopLocalQuizBridge } from './desktop.ts'
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


test('Local AI bridge feature detection preserves older desktop compatibility', () => {
  const oldBridge = { version: 1 } as DesktopBridge
  assert.equal(desktopLocalAiBridge(oldBridge), undefined)
  const nextBridge = {
    version: 1,
    localAiStatus: async () => ({}),
    startLocalAiModelDownload: async () => ({}),
    cancelLocalAiModelDownload: async () => ({}),
    removeLocalAiModel: async () => ({}),
  } as unknown as DesktopBridge
  assert.equal(desktopLocalAiBridge(nextBridge), nextBridge)
})


test('Local quiz feature detection requires all fixed generation methods', () => {
  const modelBridge = {
    version: 1,
    localAiStatus: async () => ({}),
    startLocalAiModelDownload: async () => ({}),
    cancelLocalAiModelDownload: async () => ({}),
    removeLocalAiModel: async () => ({}),
  } as unknown as DesktopLocalAiBridge
  assert.equal(desktopLocalQuizBridge(modelBridge), undefined)

  const quizBridge = {
    ...modelBridge,
    localAiQuizStatus: async () => ({}),
    generateLocalAiQuiz: async () => ({ ok: false, error: 'generation_failed' }),
    cancelLocalAiQuiz: async () => {},
  } as unknown as DesktopLocalQuizBridge
  assert.equal(desktopLocalQuizBridge(quizBridge), quizBridge)
})


test('source-text bridge is optional for older desktop builds', () => {
  const oldBridge = { version: 1 } as DesktopBridge
  assert.equal(desktopSourceTextBridge(oldBridge), undefined)

  const sourceBridge = {
    version: 1,
    loadSourcePageText: async () => 'cached source',
  } as unknown as DesktopBridge

  assert.equal(desktopSourceTextBridge(sourceBridge), sourceBridge)
})
