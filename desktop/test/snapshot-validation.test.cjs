'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateEnvelope } = require('../src/snapshot-validation.cjs')
const { snapshotDeck } = require('./snapshot-fixture.cjs')
const envelope = () => ({ schema: 1, ownerId: 'owner', savedAt: '2026-09-30T00:00:00-04:00', decks: [snapshotDeck()] })

test('accepts complete API snapshots across question types and FSRS states without changing values', () => {
  for (const type of ['short_answer', 'multiple_choice', 'true_false']) {
    const value = envelope()
    const card = value.decks[0].cards[0]
    card.question_type = type
    if (type !== 'short_answer') {
      card.choices = type === 'true_false' ? ['True', 'False'] : ['One', 'Two', 'Three']
      card.answer = { correct_index: 1, correct_answer: card.choices[1], accepted_answers: [card.choices[1]], grading: null }
    }
    card.fsrs_state = 2
    card.fsrs_step = null
    card.stability = 4.5
    card.difficulty = 6
    card.review_count = 3
    card.lapse_count = 1
    card.last_reviewed_at = card.created_at
    card.tags = ['biology', 'exam 1']
    card.source_pages = [1, 3]
    card.document_sha256 = 'a'.repeat(64)
    value.decks[0].exam_date = '2028-02-29'
    assert.equal(validateEnvelope(value, 'owner'), value)
    card.fsrs_state = 3
    card.suspended = true
    card.progress_reset_at = card.created_at
    value.decks[0].due_count = 0
    assert.equal(validateEnvelope(value, 'owner'), value)
  }
  const empty = envelope()
  empty.decks = []
  assert.equal(validateEnvelope(empty, 'owner'), empty)
})

const invalid = [
  v => { v.schema = 2 }, v => { v.ownerId = 'another account' },
  v => { v.token = 'must not persist' }, v => { v.savedAt = '09/30/2026' },
  v => { v.decks.push(structuredClone(v.decks[0])) },
  v => { v.decks[0].name = ' ' }, v => { v.decks[0].name = 'x'.repeat(201) },
  v => { v.decks[0].description = {} }, v => { v.decks[0].exam_date = '2026-02-30' },
  v => { v.decks[0].study_intensity = 'custom' }, v => { v.decks[0].card_count = 2 },
  v => { v.decks[0].due_count = -1 }, v => { v.decks[0].due_count = 2 },
  v => { v.decks[0].updated_at = '2026-09-30T24:00:00Z' },
  v => { v.decks[0].cards[0].deck_id = '33333333-3333-4333-8333-333333333333' },
  v => { v.decks[0].cards[0].id = 'not a uuid' },
  v => { v.decks[0].cards.push(structuredClone(v.decks[0].cards[0])); v.decks[0].card_count = 2 },
  v => { const other = structuredClone(v.decks[0]); other.id = '33333333-3333-4333-8333-333333333333'; other.cards[0].deck_id = other.id; v.decks.push(other) },
  v => { delete v.decks[0].cards[0].due_at },
  v => { v.decks[0].cards[0].question = ' ' },
  v => { v.decks[0].cards[0].answer = [] },
  v => { v.decks[0].cards[0].answer.correct_answer = {} },
  v => { v.decks[0].cards[0].answer.accepted_answers = [''] },
  v => { v.decks[0].cards[0].choices = ['unexpected'] },
  v => { v.decks[0].cards[0].fsrs_state = 4 },
  v => { v.decks[0].cards[0].fsrs_step = -1 },
  v => { v.decks[0].cards[0].stability = -1 },
  v => { v.decks[0].cards[0].difficulty = 11 },
  v => { v.decks[0].cards[0].review_count = 0.5 },
  v => { v.decks[0].cards[0].lapse_count = 1 },
  v => { v.decks[0].cards[0].suspended = 'false' },
  v => { v.decks[0].cards[0].due_at = '2026-02-30T00:00:00Z' },
  v => { v.decks[0].cards[0].last_reviewed_at = '2026-09-30' },
  v => { v.decks[0].cards[0].source_pages = [1, 1] },
  v => { v.decks[0].cards[0].source_pages = [0] },
  v => { v.decks[0].cards[0].tags = ['biology', 'biology'] },
  v => { v.decks[0].cards[0].document_sha256 = 'invalid' },
  v => { v.decks[0].cards[0].question_type = 'unknown' },
  v => { const c = v.decks[0].cards[0]; c.question_type = 'multiple_choice'; c.choices = ['One', 'Two']; c.answer = { correct_answer: 'One', correct_index: 2 } },
  v => { const c = v.decks[0].cards[0]; c.question_type = 'true_false'; c.choices = ['One', 'Two', 'Three']; c.answer = { correct_answer: 'One', correct_index: 0 } },
]

test('rejects invalid identity, ownership, duplicate IDs, scheduling and card data with a generic error', () => {
  for (const mutate of invalid) {
    const value = envelope()
    mutate(value)
    assert.throws(() => validateEnvelope(value, 'owner'), /^Error: Invalid or incompatible study snapshot\.$/)
  }
})
