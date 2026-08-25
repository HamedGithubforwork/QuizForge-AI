// @ts-nocheck
import assert from 'node:assert/strict'

import {
  buildAiAnswerReviewCase,
  shouldRequestAiAnswerReview,
} from './answerFallback.ts'
import type {
  ShortAnswerGrade,
} from './shortAnswerGrader.ts'

const conceptQuestion = {
  question:
    'What therapy focuses on changing unhelpful thoughts?',
  correct_answer:
    'Cognitive behavioural therapy',
  accepted_answers: [
    'CBT',
  ],
  explanation:
    'CBT targets unhelpful patterns of thought and behaviour.',
  grading: {
    grading_version: 2,
    grading_mode: 'concepts' as const,
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
  },
}

function grade(
  overrides: Partial<ShortAnswerGrade> = {},
): ShortAnswerGrade {
  return {
    correct: false,
    matchedGroups: 0,
    requiredGroups: 1,
    totalGroups: 1,
    borderline: false,
    feedback: 'No deterministic match.',
    ...overrides,
  }
}

assert.equal(
  shouldRequestAiAnswerReview(
    conceptQuestion,
    'therapy that changes negative thought patterns',
    grade(),
  ),
  true,
)

assert.equal(
  shouldRequestAiAnswerReview(
    conceptQuestion,
    'this completely unrelated response discusses database indexing',
    grade(),
  ),
  false,
  'long unrelated answers should not consume semantic review',
)

assert.equal(
  shouldRequestAiAnswerReview(
    conceptQuestion,
    'CBT',
    grade({
      correct: true,
      matchedGroups: 1,
    }),
  ),
  false,
)

assert.equal(
  shouldRequestAiAnswerReview(
    conceptQuestion,
    'IPT',
    grade(),
  ),
  false,
)

assert.equal(
  shouldRequestAiAnswerReview(
    conceptQuestion,
    'not CBT',
    grade({
      matchedGroups: 1,
      borderline: true,
    }),
  ),
  true,
)

const numericQuestion = {
  ...conceptQuestion,
  grading: {
    ...conceptQuestion.grading,
    grading_mode: 'numeric' as const,
    answer_groups: [],
    required_group_count: 0,
    numeric_value: 1,
    numeric_unit: 'g',
  },
}

assert.equal(
  shouldRequestAiAnswerReview(
    numericQuestion,
    'roughly one gram',
    grade(),
  ),
  false,
)

const reviewCase =
  buildAiAnswerReviewCase(
    3,
    conceptQuestion,
    'therapy that changes negative thought patterns',
  )

assert.equal(
  reviewCase?.question_index,
  3,
)
assert.equal(
  reviewCase?.required_group_count,
  1,
)
assert.equal(
  reviewCase?.answer_groups.length,
  1,
)

console.log(
  'answer fallback policy tests passed',
)
