import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatQuestionNavigationAccessibleName,
} from './quizNavigatorAccessibility.ts'

test('question navigation names unanswered questions before results', () => {
  assert.equal(
    formatQuestionNavigationAccessibleName(2, {
      isAnswered: false,
      showResults: false,
      isCorrect: false,
    }),
    'Question 2, unanswered',
  )
})

test('question navigation names answered questions without revealing correctness', () => {
  assert.equal(
    formatQuestionNavigationAccessibleName(3, {
      isAnswered: true,
      showResults: false,
      isCorrect: true,
    }),
    'Question 3, answered',
  )
})

test('question navigation names correct answers after results are shown', () => {
  assert.equal(
    formatQuestionNavigationAccessibleName(4, {
      isAnswered: true,
      showResults: true,
      isCorrect: true,
    }),
    'Question 4, correct',
  )
})

test('question navigation names incorrect answers after results are shown', () => {
  assert.equal(
    formatQuestionNavigationAccessibleName(5, {
      isAnswered: true,
      showResults: true,
      isCorrect: false,
    }),
    'Question 5, incorrect',
  )
})
