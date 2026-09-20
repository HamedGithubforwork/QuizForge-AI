import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePageSelection } from './pageSelection.ts'

test('page selection preserves all-pages default and canonicalizes ranges', () => {
  assert.equal(normalizePageSelection(''), '')
  assert.equal(normalizePageSelection('  '), '')
  assert.equal(normalizePageSelection('5, 2-4,3, 1'), '1,2,3,4,5')
  assert.equal(normalizePageSelection('100'), '100')
  assert.equal(normalizePageSelection('1-100').split(',').length, 100)
})

test('page selection rejects malformed or unbounded requests', () => {
  for (const invalid of ['0', '101', '5-2', '1,,2', '1.5', '-1', '1-', 'all', '1e2', '1'.repeat(401)]) {
    assert.throws(() => normalizePageSelection(invalid))
  }
})
