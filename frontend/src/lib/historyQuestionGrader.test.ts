// @ts-nocheck
import assert from 'node:assert/strict'

import {
  isHistoryQuestionCorrect,
} from './historyQuestionGrader.ts'

const conceptQuestion = {
  question_type: 'short_answer',
  correct_index: -1,
  correct_answer:
    'Cognitive-behavioural therapy, interpersonal therapy, and behavioural activation',
  accepted_answers: [],
  grading: {
    grading_version: 2,
    grading_mode: 'concepts',
    answer_groups: [
      ['cognitive behavioural therapy', 'CBT'],
      ['interpersonal therapy', 'IPT'],
      [
        'behavioural activation',
        'behavioral activation',
        'BA',
      ],
    ],
    required_group_count: 3,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}

assert.equal(
  isHistoryQuestionCorrect(
    conceptQuestion,
    'CBT IPT behavioural activation',
  ),
  true,
  'history grading should accept the same concept answer as the live quiz grader',
)

assert.equal(
  isHistoryQuestionCorrect(
    conceptQuestion,
    'CBT IPT',
  ),
  false,
  'history grading should reject incomplete concept answers',
)

const aiReviewedQuestion = {
  ...conceptQuestion,
  correct_answer:
    'Cognitive behavioural therapy',
  accepted_answers: ['CBT'],
  grading: {
    ...conceptQuestion.grading,
    answer_groups: [
      ['cognitive behavioural therapy', 'CBT'],
    ],
    required_group_count: 1,
  },
  ai_accepted_answers: [
    'therapy that changes negative thought patterns',
  ],
}

assert.equal(
  isHistoryQuestionCorrect(
    aiReviewedQuestion,
    'Therapy that changes negative thought patterns',
  ),
  true,
  'an answer approved by semantic review should stay correct in saved history',
)

const legacyQuestion = {
  question_type: 'short_answer',
  correct_index: -1,
  correct_answer: 'Playwright',
  accepted_answers: ['Playwright'],
}

assert.equal(
  isHistoryQuestionCorrect(
    legacyQuestion,
    'I used Playwright',
  ),
  true,
  'older saved quizzes without grading metadata should keep legacy grading behavior',
)

const multipleChoiceQuestion = {
  question_type: 'multiple_choice',
  correct_index: 2,
  correct_answer: 'ARP',
  accepted_answers: ['ARP'],
}

assert.equal(
  isHistoryQuestionCorrect(
    multipleChoiceQuestion,
    2,
  ),
  true,
)

assert.equal(
  isHistoryQuestionCorrect(
    multipleChoiceQuestion,
    1,
  ),
  false,
)

console.log('History question grader tests passed.')
