// @ts-nocheck
import assert from 'node:assert/strict'

import {
  analyzeWeakAreas,
} from './weakAreaAnalytics.ts'

const mc = (
  correct: boolean,
  page: number,
  question: string,
) => ({
  questionType: 'multiple_choice' as const,
  question,
  sourcePages: [page],
  correct,
})

const tf = (
  correct: boolean,
  page: number,
  question: string,
) => ({
  questionType: 'true_false' as const,
  question,
  sourcePages: [page],
  correct,
})

const short = (
  correct: boolean,
  page: number,
  question: string,
) => ({
  questionType: 'short_answer' as const,
  question,
  sourcePages: [page],
  correct,
})

// A perfect newest attempt for a type resolves older misses.
assert.equal(
  analyzeWeakAreas([
    {
      questions: [
        short(true, 2, 'new 1'),
        short(true, 3, 'new 2'),
      ],
    },
    {
      questions: [
        short(false, 2, 'old miss'),
      ],
    },
  ]),
  null,
)

// An unrelated newer attempt does not erase unresolved evidence
// for a question type that has not been retested.
const unresolved = analyzeWeakAreas([
  {
    questions: [
      mc(true, 1, 'new unrelated'),
    ],
  },
  {
    questions: [
      short(false, 4, 'older short miss'),
      short(true, 4, 'older short hit'),
    ],
  },
])

assert.equal(
  unresolved?.questionType,
  'short_answer',
)
assert.equal(
  unresolved?.baselinePercent,
  50,
)

// Weakest type is based on the newest evidence for each type,
// not lifetime miss counts.
const weakest = analyzeWeakAreas([
  {
    questions: [
      mc(true, 1, 'mc 1'),
      mc(false, 2, 'mc 2'),
      short(false, 5, 'short 1'),
      short(false, 5, 'short 2'),
    ],
  },
])

assert.equal(
  weakest?.questionType,
  'short_answer',
)

// Baseline uses at most the three most recent attempts for the
// selected type, so old history cannot dominate the comparison.
const recentBaseline = analyzeWeakAreas([
  {
    questions: [
      short(false, 7, 'latest miss'),
      short(true, 7, 'latest hit'),
    ],
  },
  {
    questions: [
      short(true, 7, 'second 1'),
      short(true, 7, 'second 2'),
    ],
  },
  {
    questions: [
      short(false, 8, 'third 1'),
      short(true, 8, 'third 2'),
    ],
  },
  {
    questions: [
      short(false, 9, 'ignored old 1'),
      short(false, 9, 'ignored old 2'),
    ],
  },
])

assert.equal(
  recentBaseline?.baselineQuestionCount,
  6,
)
assert.equal(
  recentBaseline?.baselineAttemptCount,
  3,
)
assert.equal(
  recentBaseline?.baselinePercent,
  67,
)
assert.equal(
  recentBaseline?.baselineReliable,
  true,
)
assert.deepEqual(
  recentBaseline?.pages,
  [7, 8],
)
assert.equal(
  recentBaseline?.avoidQuestions.includes(
    'ignored old 1',
  ),
  false,
)

// Tiny samples are flagged as preliminary rather than being
// presented as a strong mastery trend.
const tinySample = analyzeWeakAreas([
  {
    questions: [
      tf(false, 3, 'single miss'),
    ],
  },
])

assert.equal(
  tinySample?.baselineQuestionCount,
  1,
)
assert.equal(
  tinySample?.baselineReliable,
  false,
)
assert.equal(
  tinySample?.baselinePercent,
  0,
)

// Repeated misses make a page a stronger focus target.
const pageRanking = analyzeWeakAreas([
  {
    questions: [
      mc(false, 6, 'repeat a'),
      mc(false, 6, 'repeat b'),
      mc(false, 9, 'single'),
    ],
  },
])

assert.deepEqual(
  pageRanking?.pages,
  [6, 9],
)
assert.equal(
  pageRanking?.missedQuestions,
  3,
)

console.log(
  'Weak-area analytics tests passed.',
)
