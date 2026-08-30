// @ts-nocheck
import assert from 'node:assert/strict'

import {
  appendUniqueHistoryRows,
  buildHistoryCursorFilter,
  createHistoryCursor,
  MAX_QUIZ_HISTORY_PAGE_SIZE,
  normalizeHistoryPageSize,
  QUIZ_HISTORY_PAGE_SIZE,
  splitHistoryPageRows,
} from './quizHistoryPagination.ts'

assert.equal(
  normalizeHistoryPageSize(Number.NaN),
  QUIZ_HISTORY_PAGE_SIZE,
)
assert.equal(
  normalizeHistoryPageSize(0),
  1,
)
assert.equal(
  normalizeHistoryPageSize(500),
  MAX_QUIZ_HISTORY_PAGE_SIZE,
)

const merged = appendUniqueHistoryRows(
  [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ],
  [
    { id: 'b', value: 20 },
    { id: 'c', value: 3 },
  ],
)

assert.deepEqual(
  merged,
  [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'c', value: 3 },
  ],
)

const rows = [
  {
    id: '00000000-0000-0000-0000-000000000005',
    created_at: '2026-08-30T12:00:05.000Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    created_at: '2026-08-30T12:00:04.000Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    created_at: '2026-08-30T12:00:03.000Z',
  },
]

const firstPage = splitHistoryPageRows(
  rows,
  2,
)

assert.deepEqual(
  firstPage.items,
  rows.slice(0, 2),
)
assert.equal(firstPage.hasMore, true)
assert.deepEqual(
  firstPage.nextCursor,
  {
    createdAt: '2026-08-30T12:00:04.000Z',
    id: '00000000-0000-0000-0000-000000000004',
  },
)

assert.deepEqual(
  createHistoryCursor(rows[1]),
  firstPage.nextCursor,
)
assert.equal(
  buildHistoryCursorFilter(
    firstPage.nextCursor,
  ),
  'created_at.lt.2026-08-30T12:00:04.000Z,and(created_at.eq.2026-08-30T12:00:04.000Z,id.lt.00000000-0000-0000-0000-000000000004)',
)

const finalPage = splitHistoryPageRows(
  rows.slice(2),
  2,
)

assert.equal(finalPage.hasMore, false)
assert.equal(finalPage.nextCursor, null)

console.log(
  'quiz history pagination tests passed',
)
