// @ts-nocheck
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  isHistoryQuestionCorrect,
} from './historyQuestionGrader.ts'
import {
  isAttemptQuestionCorrect,
} from './quizAttempt.ts'

const cases = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../tests/fixtures/numeric-grading-parity.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
)

for (const testCase of cases) {
  const targetAnswer = `${testCase.numeric_value}${testCase.numeric_unit ? ` ${testCase.numeric_unit}` : ''}`
  const grading = {
    grading_version: 2,
    grading_mode: 'numeric',
    answer_groups: [],
    required_group_count: 0,
    numeric_value: testCase.numeric_value,
    numeric_tolerance: testCase.numeric_tolerance,
    numeric_unit: testCase.numeric_unit,
  }
  const question = {
    question_type: 'short_answer',
    question: `Numeric parity case: ${testCase.name}`,
    correct_index: -1,
    correct_answer: targetAnswer,
    accepted_answers: [targetAnswer],
    grading,
  }

  assert.equal(
    isAttemptQuestionCorrect(
      question,
      testCase.answer,
      {},
    ),
    testCase.accepted,
    `${testCase.name}: live attempt verdict`,
  )
  assert.equal(
    isHistoryQuestionCorrect(
      question,
      testCase.answer,
    ),
    testCase.accepted,
    `${testCase.name}: saved history verdict`,
  )
}

console.log('Shared numeric grading parity cases passed.')
