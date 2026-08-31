// @ts-nocheck
import assert from 'node:assert/strict'

import {
  buildCurrentDocumentSummary,
  buildHistoryAnalytics,
  getDisplayFilename,
  getQuestionTypeLabel,
  getTypePercentage,
} from './quizHistoryAnalytics.ts'

function row({
  id,
  percentage,
  questions,
  selectedAnswers,
}) {
  return {
    id,
    user_id: 'user-1',
    quiz_title: `Quiz ${id}`,
    source_filename: 'study%20notes.pdf',
    difficulty: 'medium',
    question_type: 'mixed',
    question_count: questions.length,
    score: 0,
    percentage,
    quiz_data: {
      title: `Quiz ${id}`,
      questions,
    },
    selected_answers: selectedAnswers,
    created_at: '2026-08-31T00:00:00Z',
  }
}

const multipleChoice = {
  question_type: 'multiple_choice',
  question: 'Which page contains the cache section?',
  choices: ['Page 1', 'Page 2'],
  correct_index: 1,
  correct_answer: 'Page 2',
  accepted_answers: [],
  explanation: 'The cache section is on page 2.',
  source_pages: [2],
}

const trueFalse = {
  question_type: 'true_false',
  question: 'Redis is optional at runtime.',
  choices: ['True', 'False'],
  correct_index: 0,
  correct_answer: 'True',
  accepted_answers: [],
  explanation: 'The backend has a bounded process fallback.',
  source_pages: [4],
}

assert.equal(
  getDisplayFilename('study%20notes.pdf'),
  'study notes.pdf',
)
assert.equal(
  getDisplayFilename('%E0%A4%A'),
  '%E0%A4%A',
)
assert.equal(
  getQuestionTypeLabel('multiple_choice'),
  'Multiple Choice',
)
assert.equal(
  getQuestionTypeLabel('true_false'),
  'True / False',
)
assert.equal(
  getQuestionTypeLabel('short_answer'),
  'Short Answer',
)
assert.equal(
  getQuestionTypeLabel('mixed'),
  'Mixed',
)
assert.equal(
  getQuestionTypeLabel('custom'),
  'custom',
)
assert.equal(
  getTypePercentage({
    correct: 0,
    total: 0,
  }),
  0,
)
assert.equal(
  getTypePercentage({
    correct: 2,
    total: 3,
  }),
  67,
)

const emptyAnalytics =
  buildHistoryAnalytics([], 0)
assert.deepEqual(
  {
    loadedQuizCount:
      emptyAnalytics.loadedQuizCount,
    averageScore:
      emptyAnalytics.averageScore,
    bestScore:
      emptyAnalytics.bestScore,
    latestScore:
      emptyAnalytics.latestScore,
  },
  {
    loadedQuizCount: 0,
    averageScore: 0,
    bestScore: 0,
    latestScore: 0,
  },
)

const history = [
  row({
    id: 'newest',
    percentage: 50,
    questions: [
      multipleChoice,
      trueFalse,
    ],
    selectedAnswers: {
      0: 1,
      1: 1,
    },
  }),
  row({
    id: 'older',
    percentage: 100,
    questions: [
      multipleChoice,
      trueFalse,
    ],
    selectedAnswers: {
      0: 1,
      1: 0,
    },
  }),
  {
    ...row({
      id: 'malformed',
      percentage: 25,
      questions: [],
      selectedAnswers: {},
    }),
    question_count: 4,
    quiz_data: {
      title: 'Malformed',
      questions: [
        {
          question_type: 'unsupported',
        },
      ],
    },
  },
]

const analytics =
  buildHistoryAnalytics(history, 8)

assert.equal(analytics.loadedQuizCount, 3)
assert.equal(analytics.quizzesCompleted, 8)
assert.equal(analytics.totalQuestions, 8)
assert.equal(analytics.averageScore, 58)
assert.equal(analytics.bestScore, 100)
assert.equal(analytics.latestScore, 50)
assert.deepEqual(
  analytics.typePerformance.multiple_choice,
  {
    correct: 2,
    total: 2,
  },
)
assert.deepEqual(
  analytics.typePerformance.true_false,
  {
    correct: 1,
    total: 2,
  },
)

assert.equal(
  buildCurrentDocumentSummary(
    null,
    history,
  ),
  null,
)

const documentSummary =
  buildCurrentDocumentSummary(
    'study notes.pdf',
    [
      row({
        id: 'attempt-1',
        percentage: 50,
        questions: [
          multipleChoice,
          trueFalse,
        ],
        selectedAnswers: {
          0: 0,
          1: 0,
        },
      }),
      row({
        id: 'attempt-2',
        percentage: 50,
        questions: [
          multipleChoice,
          trueFalse,
        ],
        selectedAnswers: {
          0: 0,
          1: 0,
        },
      }),
    ],
  )

assert.equal(
  documentSummary?.attemptCount,
  2,
)
assert.equal(
  documentSummary?.weakness?.questionType,
  'multiple_choice',
)
assert.deepEqual(
  documentSummary?.weakness?.pages,
  [2],
)
assert.equal(
  documentSummary?.weakness?.missedQuestions,
  2,
)
assert.equal(
  documentSummary?.weakness?.baselinePercent,
  0,
)

const malformedSummary =
  buildCurrentDocumentSummary(
    'study notes.pdf',
    [
      {
        ...history[0],
        quiz_data: null,
      },
    ],
  )

assert.equal(
  malformedSummary?.attemptCount,
  1,
)
assert.equal(
  malformedSummary?.weakness,
  null,
)

console.log(
  'quiz history analytics tests passed',
)
