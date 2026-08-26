// @ts-nocheck
import assert from 'node:assert/strict'

import {
  analyzeDocumentMastery,
} from './masteryAnalytics.ts'

const q = (
  questionType,
  correct,
  page,
  question,
) => ({
  questionType,
  correct,
  sourcePages: [page],
  question,
})

const attempt = (
  percentage,
  questions,
  createdAt,
) => ({
  percentage,
  questions,
  createdAt,
})

// A single perfect attempt is encouraging, but it is not enough
// to claim sustained mastery.
const singlePerfect = analyzeDocumentMastery([
  attempt(
    100,
    [
      q('short_answer', true, 1, 'a'),
      q('short_answer', true, 2, 'b'),
      q('short_answer', true, 3, 'c'),
    ],
    '2026-08-26T10:00:00Z',
  ),
])

assert.equal(
  singlePerfect?.status,
  'improving',
)
assert.equal(
  singlePerfect?.sustainedMastery,
  false,
)
assert.equal(
  singlePerfect?.typeSummaries[0]
    .status,
  'improving',
)

// Two consecutive strong attempts with enough question evidence
// confirm mastery for that question type and the document.
const sustained = analyzeDocumentMastery([
  attempt(
    100,
    [
      q('short_answer', true, 1, 'new 1'),
      q('short_answer', true, 1, 'new 2'),
      q('short_answer', true, 2, 'new 3'),
    ],
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    80,
    [
      q('short_answer', true, 1, 'old 1'),
      q('short_answer', true, 2, 'old 2'),
      q('short_answer', true, 2, 'old 3'),
      q('short_answer', true, 3, 'old 4'),
      q('short_answer', false, 3, 'old 5'),
    ],
    '2026-08-25T10:00:00Z',
  ),
])

assert.equal(
  sustained?.status,
  'mastered',
)
assert.equal(
  sustained?.sustainedMastery,
  true,
)
assert.equal(
  sustained?.typeSummaries[0]
    .status,
  'mastered',
)

// A strong newest jump from prior attempts is marked improving,
// even when it has not yet met the repeated-mastery requirement.
const improving = analyzeDocumentMastery([
  attempt(
    80,
    [
      q('multiple_choice', true, 2, 'new 1'),
      q('multiple_choice', true, 2, 'new 2'),
      q('multiple_choice', true, 3, 'new 3'),
      q('multiple_choice', false, 3, 'new 4'),
      q('multiple_choice', true, 4, 'new 5'),
    ],
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    40,
    [
      q('multiple_choice', true, 2, 'old 1'),
      q('multiple_choice', false, 2, 'old 2'),
      q('multiple_choice', false, 3, 'old 3'),
      q('multiple_choice', false, 3, 'old 4'),
      q('multiple_choice', true, 4, 'old 5'),
    ],
    '2026-08-25T10:00:00Z',
  ),
])

assert.equal(
  improving?.status,
  'improving',
)
assert.equal(
  improving?.scoreDelta,
  40,
)
assert.equal(
  improving?.typeSummaries[0]
    .delta,
  40,
)
assert.equal(
  improving?.sustainedMastery,
  false,
)

// Persistently low evidence remains Needs Work.
const needsWork = analyzeDocumentMastery([
  attempt(
    40,
    [
      q('true_false', false, 4, 'new 1'),
      q('true_false', true, 4, 'new 2'),
      q('true_false', false, 5, 'new 3'),
      q('true_false', false, 5, 'new 4'),
      q('true_false', true, 6, 'new 5'),
    ],
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    40,
    [
      q('true_false', true, 4, 'old 1'),
      q('true_false', false, 4, 'old 2'),
      q('true_false', false, 5, 'old 3'),
      q('true_false', true, 5, 'old 4'),
      q('true_false', false, 6, 'old 5'),
    ],
    '2026-08-25T10:00:00Z',
  ),
])

assert.equal(
  needsWork?.status,
  'needs_work',
)
assert.equal(
  needsWork?.typeSummaries[0]
    .status,
  'needs_work',
)

// Repeated weak pages require misses across at least two recent
// attempts. A page missed only once is not presented as recurring.
const recurring = analyzeDocumentMastery([
  attempt(
    50,
    [
      q('short_answer', false, 7, 'a'),
      q('short_answer', false, 7, 'b'),
      q('short_answer', true, 9, 'c'),
    ],
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    50,
    [
      q('short_answer', false, 7, 'd'),
      q('short_answer', false, 8, 'e'),
    ],
    '2026-08-25T10:00:00Z',
  ),
  attempt(
    50,
    [
      q('short_answer', false, 8, 'f'),
      q('short_answer', false, 10, 'g'),
    ],
    '2026-08-24T10:00:00Z',
  ),
])

assert.deepEqual(
  recurring?.recurringWeakPages,
  [
    {
      pageNumber: 7,
      missCount: 3,
      attemptCount: 2,
    },
    {
      pageNumber: 8,
      missCount: 2,
      attemptCount: 2,
    },
  ],
)

// Prior score baseline uses up to the three attempts before the
// newest one rather than lifetime history.
const baseline = analyzeDocumentMastery([
  attempt(90, [], '2026-08-26T10:00:00Z'),
  attempt(80, [], '2026-08-25T10:00:00Z'),
  attempt(60, [], '2026-08-24T10:00:00Z'),
  attempt(40, [], '2026-08-23T10:00:00Z'),
  attempt(0, [], '2026-08-22T10:00:00Z'),
])

assert.equal(
  baseline?.priorBaselinePercent,
  60,
)
assert.equal(
  baseline?.scoreDelta,
  30,
)

// Trend history is intentionally bounded so a long account history
// does not overload the current-document view.
const manyAttempts = analyzeDocumentMastery(
  Array.from(
    { length: 8 },
    (_, index) =>
      attempt(
        50 + index,
        [],
        `2026-08-${26 - index}T10:00:00Z`,
      ),
  ),
)

assert.equal(
  manyAttempts?.recentTrend.length,
  6,
)

assert.equal(
  analyzeDocumentMastery([]),
  null,
)

console.log(
  'Advanced mastery analytics tests passed.',
)
