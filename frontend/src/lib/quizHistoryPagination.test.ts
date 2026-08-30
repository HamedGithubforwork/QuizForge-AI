import assert from 'node:assert/strict'

import {
  appendUniqueHistoryRows,
  hasMoreHistoryRows,
  MAX_QUIZ_HISTORY_PAGE_SIZE,
  normalizeHistoryPageSize,
  QUIZ_HISTORY_PAGE_SIZE,
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

assert.equal(
  hasMoreHistoryRows({
    offset: 0,
    loadedCount: 20,
    totalCount: 45,
    pageSize: 20,
  }),
  true,
)
assert.equal(
  hasMoreHistoryRows({
    offset: 40,
    loadedCount: 5,
    totalCount: 45,
    pageSize: 20,
  }),
  false,
)
assert.equal(
  hasMoreHistoryRows({
    offset: 0,
    loadedCount: 20,
    totalCount: null,
    pageSize: 20,
  }),
  true,
)
assert.equal(
  hasMoreHistoryRows({
    offset: 20,
    loadedCount: 7,
    totalCount: null,
    pageSize: 20,
  }),
  false,
)

console.log(
  'quiz history pagination tests passed',
)
