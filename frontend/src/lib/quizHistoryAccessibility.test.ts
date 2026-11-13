/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatQuizDeleteAccessibleName,
} from './quizHistoryAccessibility.ts'

test('quiz deletion accessible name includes the quiz title and saved date', () => {
  assert.equal(
    formatQuizDeleteAccessibleName(
      'Cell division',
      'Oct 6, 2026, 3:15 PM',
    ),
    'Delete quiz: Cell division, saved Oct 6, 2026, 3:15 PM',
  )
})

