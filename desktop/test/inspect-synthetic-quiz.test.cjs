'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES, inspectQuestion } = require('../scripts/inspect-synthetic-quiz.cjs')

const fixture = FIXTURES.find(item => item.id === 'selected_pages')

test('diagnostic inspector validates generated questions using choices and correct_index', () => {
  assert.ok(fixture)
  const result = inspectQuestion({
    question: "Which material is Aster's casing?",
    choices: ['glass', 'cobalt', 'wood', 'steel'],
    correct_index: 1,
    source_pages: [2],
    explanation: 'Aster uses cobalt.',
    source_fact: 'Aster casing material is cobalt.',
  }, fixture)

  assert.equal(result.reason, 'matched')
  assert.equal(result.sourceFactId, 'aster_material')
  assert.equal(result.oracleMatch, true)
  assert.equal(result.evidenceMatch, true)
})

test('diagnostic inspector rejects an invalid generated correct_index', () => {
  assert.ok(fixture)
  const result = inspectQuestion({
    question: 'Which fixture fact is being tested?',
    choices: ['not a fixture answer', 'another answer'],
    correct_index: 2,
  }, fixture)

  assert.equal(result.reason, 'question_shape')
})
