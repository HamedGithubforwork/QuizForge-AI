import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifySamePdf } from './pageChange.ts'

test('reselected PDF is checked by contents, not filename', async () => {
  const raw = '%PDF-original'
  const digest = createHash('sha256').update(raw).digest('hex')
  await verifySamePdf(new File([raw], 'renamed.pdf'), digest)
  await assert.rejects(verifySamePdf(new File(['other'], 'original.pdf'), digest), /different PDF/)
})

test('empty and oversized files are rejected before reading their bytes', async () => {
  for (const size of [0, 15 * 1024 * 1024 + 1]) {
    const file = { size, arrayBuffer() { throw new Error('must not read') } } as unknown as File
    await assert.rejects(verifySamePdf(file, 'a'.repeat(64)), /between 1 byte and 15 MB/)
  }
})
