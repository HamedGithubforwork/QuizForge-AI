import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pdfErrorMessage, pdfJobMessage, pausePdfPolling, waitForPdfJob } from './pdfJobs.ts'
import type { PdfJobResponse, UploadResponse } from '../types/api.generated.ts'

const result: UploadResponse = { filename: 'notes.pdf', pdf_sha256: 'a'.repeat(64), page_count: 30,
  character_count: 30000, extractable_page_count: 30, scanned_likely: false, warning: null, pages: [] }
const queued: PdfJobResponse = { job_id: '11111111-1111-4111-8111-111111111111', filename: 'notes.pdf',
  status: 'queued', completed_pages: 0, total_pages: null, expires_at: new Date(Date.now() + 3600000).toISOString(), error: null }

test('polls through real progress states and returns the document only on completion', async () => {
  const updates: string[] = []
  const states: PdfJobResponse[] = [{ ...queued, status: 'processing', completed_pages: 5, total_pages: 30 },
    { ...queued, status: 'succeeded', completed_pages: 30, total_pages: 30, result }]
  const found = await waitForPdfJob(queued, async id => {
    assert.equal(id, queued.job_id)
    return states.shift()!
  }, job => updates.push(pdfJobMessage(job)), new AbortController().signal, async () => {})
  assert.deepEqual(found, result)
  assert.deepEqual(updates, ['Your PDF is queued and will start shortly.', 'Processed 5 of 30 pages.', 'Your PDF is ready.'])
  assert.equal(pdfJobMessage({ ...queued, status: 'processing' }), 'Checking your PDF…')
})

test('stops on failed, cancelled, expired or invalid jobs without polling again', async () => {
  for (const job of [
    { ...queued, status: 'failed', error: 'Invalid PDF.' },
    { ...queued, status: 'cancelled' },
    { ...queued, expires_at: '2020-01-01' },
    { ...queued, expires_at: 'invalid' },
    { ...queued, job_id: '../another-user' },
    { ...queued, status: 'succeeded' },
  ] as PdfJobResponse[]) {
    await assert.rejects(waitForPdfJob(job, async () => { assert.fail('Must not poll') }, () => {}, new AbortController().signal))
  }
  assert.equal(pdfJobMessage({ ...queued, status: 'failed' }), 'PDF processing failed. Please try again.')
})

test('closing the page aborts polling without sending a server cancellation', async () => {
  const controller = new AbortController()
  const waiting = waitForPdfJob(queued, async () => { assert.fail('Must not read after abort') }, () => {}, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  await assert.rejects(pausePdfPolling(controller.signal), { name: 'AbortError' })
})

test('polling delay resolves and a resumed completed job needs no extra read', async () => {
  await pausePdfPolling(new AbortController().signal)
  const complete = { ...queued, status: 'succeeded' as const, result }
  assert.deepEqual(await waitForPdfJob(complete, async () => { assert.fail('Already complete') }, () => {}, new AbortController().signal), result)
})

test('completed status explains how many cached pages were reused', () => {
  assert.equal(pdfJobMessage({ ...queued, status: 'succeeded', reused_pages: 1 }), 'Your PDF is ready. Reused 1 cached page.')
  assert.equal(pdfJobMessage({ ...queued, status: 'succeeded', reused_pages: 6 }), 'Your PDF is ready. Reused 6 cached pages.')
})


test('singular PDF page-count errors use correct copy', () => {
  const raw = 'This PDF has 1 pages. Choose pages within that range.'
  assert.equal(
    pdfErrorMessage(raw),
    'This PDF has 1 page. Choose pages within that range.',
  )
  assert.equal(
    pdfJobMessage({ ...queued, status: 'failed', error: raw }),
    'This PDF has 1 page. Choose pages within that range.',
  )
})
