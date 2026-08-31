// @ts-nocheck
import assert from 'node:assert/strict'

import {
  buildAttemptReviewCases,
  buildQuizForHistory,
  calculateAttemptScore,
  getAttemptTypeScore,
  getIncorrectQuestionIndexes,
  isAttemptQuestionCorrect,
  mergeAttemptReviewDecisions,
} from './quizAttempt.ts'
import {
  buildAiAnswerReviewKey,
} from './answerFallback.ts'

const gradingNone = {
  grading_version: 2,
  grading_mode: 'none',
  answer_groups: [],
  required_group_count: 0,
  numeric_value: 0,
  numeric_tolerance: 0,
  numeric_unit: '',
}

const conceptGrading = {
  grading_version: 2,
  grading_mode: 'concepts',
  answer_groups: [
    [
      'cognitive behavioural therapy',
      'cognitive behavioral therapy',
      'CBT',
    ],
  ],
  required_group_count: 1,
  numeric_value: 0,
  numeric_tolerance: 0,
  numeric_unit: '',
}

const multipleChoice = {
  question_type: 'multiple_choice',
  question: 'Which number is even?',
  choices: ['1', '2', '3', '5'],
  correct_index: 1,
  correct_answer: '2',
  accepted_answers: [],
  grading: gradingNone,
  explanation: 'Two is even.',
  source_pages: [1],
}

const shortAnswer = {
  question_type: 'short_answer',
  question:
    'What therapy focuses on changing unhelpful thoughts?',
  choices: [],
  correct_index: -1,
  correct_answer:
    'Cognitive behavioural therapy',
  accepted_answers: ['CBT'],
  grading: conceptGrading,
  explanation:
    'CBT targets unhelpful thought patterns.',
  source_pages: [2],
}

const quiz = {
  title: 'Attempt helper quiz',
  questions: [
    multipleChoice,
    shortAnswer,
  ],
}

assert.equal(
  isAttemptQuestionCorrect(
    multipleChoice,
    1,
    {},
  ),
  true,
)
assert.equal(
  isAttemptQuestionCorrect(
    multipleChoice,
    0,
    {},
  ),
  false,
)
assert.equal(
  isAttemptQuestionCorrect(
    shortAnswer,
    'CBT',
    {},
  ),
  true,
)
assert.equal(
  isAttemptQuestionCorrect(
    shortAnswer,
    undefined,
    {},
  ),
  false,
)

const semanticAnswer =
  'therapy that changes cognitive thought patterns'
const reviewKey =
  buildAiAnswerReviewKey(
    shortAnswer,
    semanticAnswer,
  )
const acceptedReview = {
  question_index: 1,
  verdict: 'correct',
  confidence: 0.91,
  reason: 'Semantically equivalent.',
}

assert.equal(
  isAttemptQuestionCorrect(
    shortAnswer,
    semanticAnswer,
    {
      [reviewKey]: acceptedReview,
    },
  ),
  true,
)

const selectedAnswers = {
  0: 1,
  1: semanticAnswer,
}
const acceptedReviews = {
  [reviewKey]: acceptedReview,
}

assert.equal(
  calculateAttemptScore(
    quiz,
    selectedAnswers,
    acceptedReviews,
  ),
  2,
)
assert.equal(
  calculateAttemptScore(
    null,
    selectedAnswers,
    acceptedReviews,
  ),
  0,
)
assert.deepEqual(
  getAttemptTypeScore(
    quiz,
    'short_answer',
    selectedAnswers,
    acceptedReviews,
  ),
  {
    correct: 1,
    total: 1,
  },
)
assert.deepEqual(
  getAttemptTypeScore(
    null,
    'short_answer',
    selectedAnswers,
    acceptedReviews,
  ),
  {
    correct: 0,
    total: 0,
  },
)
assert.deepEqual(
  getIncorrectQuestionIndexes(
    quiz,
    {
      0: 0,
      1: 'CBT',
    },
    {},
  ),
  [0],
)

const reviewCases =
  buildAttemptReviewCases(
    quiz,
    {
      0: 1,
      1: semanticAnswer,
    },
    [0, 1],
  )
assert.equal(reviewCases.length, 1)
assert.equal(
  reviewCases[0].question_index,
  1,
)

const merged =
  mergeAttemptReviewDecisions(
    {},
    quiz,
    reviewCases,
    [acceptedReview],
  )
assert.equal(
  merged[reviewKey]?.verdict,
  'correct',
)

const ignoredDecision =
  mergeAttemptReviewDecisions(
    merged,
    quiz,
    [],
    [
      {
        ...acceptedReview,
        question_index: 99,
      },
    ],
  )
assert.deepEqual(
  ignoredDecision,
  merged,
)

const historyQuiz =
  buildQuizForHistory(
    quiz,
    selectedAnswers,
    acceptedReviews,
  )
assert.deepEqual(
  historyQuiz.questions[1]
    .ai_accepted_answers,
  [semanticAnswer],
)
assert.equal(
  historyQuiz.questions[0],
  multipleChoice,
)

const existingAcceptedQuiz = {
  ...quiz,
  questions: [
    multipleChoice,
    {
      ...shortAnswer,
      ai_accepted_answers: [
        semanticAnswer,
      ],
    },
  ],
}
assert.deepEqual(
  buildQuizForHistory(
    existingAcceptedQuiz,
    selectedAnswers,
    acceptedReviews,
  ).questions[1].ai_accepted_answers,
  [semanticAnswer],
  'history persistence should de-duplicate accepted semantic answers',
)

console.log(
  'quiz attempt helper tests passed',
)
