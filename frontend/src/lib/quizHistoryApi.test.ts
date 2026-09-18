/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQuizHistoryApi } from './quizHistoryApi.ts'

test('history requests use FastAPI with encoded cursors and document identity', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const page = { items: [], totalCount: 0, hasMore: false, nextCursor: null }
  const api = createQuizHistoryApi(async (path, init) => {
    calls.push({ path, init })
    return Response.json(path.includes('/document?') ? [] : page)
  })
  assert.deepEqual(await api.page(20), page)
  const cursor = { createdAt: '2026-09-16T12:00:00+00:00', id: 'entry-id' }
  await api.page(10, cursor)
  const query = new URL(calls[1].path, 'https://api.example').searchParams
  assert.equal(query.get('cursor_created_at'), cursor.createdAt)
  assert.equal(query.get('cursor_id'), cursor.id)
  assert.equal(query.get('limit'), '10')
  await api.document('notes.pdf&limit=999', 'a'.repeat(64), 30)
  const document = new URL(calls[2].path, 'https://api.example')
  assert.equal(document.pathname, '/api/quiz-history/document')
  assert.equal(document.searchParams.get('source_filename'), 'notes.pdf&limit=999')
  assert.equal(document.searchParams.get('limit'), '30')
  assert.equal(document.searchParams.get('document_sha256'), 'a'.repeat(64))
  await api.document('legacy.pdf', null, 30)
  assert.equal(calls[3].path.includes('document_sha256'), false)
  assert(calls.every(call => call.path.startsWith('/api/quiz-history')))
})

test('save and delete handle empty successful responses', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = createQuizHistoryApi(async (path, init) => {
    calls.push({ path, init })
    return new Response(null, { status: init?.method === 'POST' ? 201 : 204 })
  })
  const payload = { quiz_title: 'Water cycle', quiz_data: { questions: [] } }
  await api.save(payload)
  assert.equal(calls[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), payload)
  assert.equal(new Headers(calls[0].init?.headers).get('Content-Type'), 'application/json')
  await api.delete('id/with?reserved')
  assert.equal(calls[1].path, '/api/quiz-history/id%2Fwith%3Freserved')
  assert.equal(calls[1].init?.method, 'DELETE')
})

test('failed history operations surface safe API errors', async () => {
  const api = createQuizHistoryApi(async () => Response.json({ detail: 'Quiz history access was denied.' }, { status: 401 }))
  await assert.rejects(api.page(20), /access was denied/)
  await assert.rejects(api.save({}), /access was denied/)
  await assert.rejects(api.delete('id'), /access was denied/)
  await assert.rejects(api.document('file', null, 20), /access was denied/)
})

test('non-JSON errors and validation arrays use the generic error', async () => {
  const html = createQuizHistoryApi(async () => new Response('<html>gateway error</html>', { status: 502 }))
  await assert.rejects(html.page(20), /temporarily unavailable/)
  const validation = createQuizHistoryApi(async () => Response.json({ detail: [{ msg: 'invalid' }] }, { status: 422 }))
  await assert.rejects(validation.page(20), /temporarily unavailable/)
})
