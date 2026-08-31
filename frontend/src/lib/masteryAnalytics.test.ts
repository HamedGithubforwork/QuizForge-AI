// @ts-nocheck
import assert from 'node:assert/strict'

import {
  analyzeDocumentMastery,
  getMasteryStatusLabel,
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

const accuracyQuestions = (
  questionType,
  correctCount,
  totalCount,
  page = 1,
) => Array.from(
  { length: totalCount },
  (_, index) =>
    q(
      questionType,
      index < correctCount,
      page,
      `${questionType}-${index}`,
    ),
)

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

// Two strong attempts are still not enough when the recent evidence
// contains fewer than five questions.
const insufficientMasteryEvidence =
  analyzeDocumentMastery([
    attempt(
      100,
      accuracyQuestions(
        'short_answer',
        2,
        2,
      ),
      '2026-08-26T10:00:00Z',
    ),
    attempt(
      100,
      accuracyQuestions(
        'short_answer',
        2,
        2,
      ),
      '2026-08-25T10:00:00Z',
    ),
  ])

assert.equal(
  insufficientMasteryEvidence
    ?.sustainedMastery,
  false,
)
assert.equal(
  insufficientMasteryEvidence
    ?.typeSummaries[0]
    .sustainedMastery,
  false,
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

// Document-level thresholds are inclusive. These boundary cases
// protect >= 70 and score-delta >= 5 from subtle operator changes.
assert.equal(
  analyzeDocumentMastery([
    attempt(
      70,
      [],
      '2026-08-26T10:00:00Z',
    ),
  ])?.status,
  'improving',
)

assert.equal(
  analyzeDocumentMastery([
    attempt(
      69,
      [],
      '2026-08-26T10:00:00Z',
    ),
  ])?.status,
  'needs_work',
)

assert.equal(
  analyzeDocumentMastery([
    attempt(65, [], '2026-08-26T10:00:00Z'),
    attempt(60, [], '2026-08-25T10:00:00Z'),
  ])?.status,
  'improving',
)

assert.equal(
  analyzeDocumentMastery([
    attempt(64, [], '2026-08-26T10:00:00Z'),
    attempt(60, [], '2026-08-25T10:00:00Z'),
  ])?.status,
  'needs_work',
)

// Type-level score thresholds are inclusive as well: 80% is strong,
// 65% is improving, while 60% remains Needs Work without a trend.
const typeAtStrongBoundary = analyzeDocumentMastery([
  attempt(
    80,
    accuracyQuestions(
      'multiple_choice',
      4,
      5,
    ),
    '2026-08-26T10:00:00Z',
  ),
])
assert.equal(
  typeAtStrongBoundary?.typeSummaries[0]
    .latestPercent,
  80,
)
assert.equal(
  typeAtStrongBoundary?.typeSummaries[0]
    .status,
  'improving',
)

const typeAtImprovingBoundary = analyzeDocumentMastery([
  attempt(
    65,
    accuracyQuestions(
      'true_false',
      13,
      20,
    ),
    '2026-08-26T10:00:00Z',
  ),
])
assert.equal(
  typeAtImprovingBoundary?.typeSummaries[0]
    .latestPercent,
  65,
)
assert.equal(
  typeAtImprovingBoundary?.typeSummaries[0]
    .status,
  'improving',
)

const typeBelowImprovingBoundary = analyzeDocumentMastery([
  attempt(
    60,
    accuracyQuestions(
      'true_false',
      12,
      20,
    ),
    '2026-08-26T10:00:00Z',
  ),
])
assert.equal(
  typeBelowImprovingBoundary?.typeSummaries[0]
    .status,
  'needs_work',
)

// A type-level improvement of exactly 10 points should count.
const typeDeltaBoundary = analyzeDocumentMastery([
  attempt(
    60,
    accuracyQuestions(
      'short_answer',
      6,
      10,
    ),
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    50,
    accuracyQuestions(
      'short_answer',
      5,
      10,
    ),
    '2026-08-25T10:00:00Z',
  ),
])
assert.equal(
  typeDeltaBoundary?.typeSummaries[0]
    .delta,
  10,
)
assert.equal(
  typeDeltaBoundary?.typeSummaries[0]
    .status,
  'improving',
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

// Invalid page numbers never become weak-page evidence. When all
// ranking evidence is tied, the lower source page is returned first.
const pageValidation = analyzeDocumentMastery([
  attempt(
    40,
    [
      q('short_answer', false, 6, 'a'),
      q('short_answer', false, 5, 'b'),
      q('short_answer', false, 0, 'bad zero'),
      q('short_answer', false, 1.5, 'bad decimal'),
    ],
    '2026-08-26T10:00:00Z',
  ),
  attempt(
    40,
    [
      q('short_answer', false, 6, 'c'),
      q('short_answer', false, 5, 'd'),
      q('short_answer', false, 0, 'bad zero again'),
      q('short_answer', false, 1.5, 'bad decimal again'),
    ],
    '2026-08-25T10:00:00Z',
  ),
])

assert.deepEqual(
  pageValidation?.recurringWeakPages,
  [
    {
      pageNumber: 5,
      missCount: 2,
      attemptCount: 2,
    },
    {
      pageNumber: 6,
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

// Percentages are clamped to the analytics domain before status and
// trend calculations.
assert.equal(
  analyzeDocumentMastery([
    attempt(
      150,
      [],
      '2026-08-26T10:00:00Z',
    ),
  ])?.latestPercent,
  100,
)
assert.equal(
  analyzeDocumentMastery([
    attempt(
      -5,
      [],
      '2026-08-26T10:00:00Z',
    ),
  ])?.latestPercent,
  0,
)
assert.equal(
  analyzeDocumentMastery([
    attempt(
      Number.POSITIVE_INFINITY,
      [],
      '2026-08-26T10:00:00Z',
    ),
  ])?.latestPercent,
  0,
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
  getMasteryStatusLabel('mastered'),
  'Mastered',
)
assert.equal(
  getMasteryStatusLabel('improving'),
  'Improving',
)
assert.equal(
  getMasteryStatusLabel('needs_work'),
  'Needs Work',
)

assert.equal(
  analyzeDocumentMastery([]),
  null,
)

console.log(
  'Advanced mastery analytics tests passed.',
)
