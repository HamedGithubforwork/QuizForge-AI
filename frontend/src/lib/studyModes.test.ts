import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cramStudyCards,
} from './studyModes.ts'
import type {
  CardRow,
} from '../types/api.generated.ts'

function card(
  id: string,
  suspended = false,
): CardRow {
  return {
    question_type:
      'short_answer',
    question:
      'Question ' + id,
    answer: {
      correct_answer:
        'Answer ' + id,
    },
    choices: null,
    explanation: null,
    source_filename: null,
    document_sha256: null,
    source_pages: [],
    tags: [],
    id,
    deck_id:
      '11111111-1111-4111-8111-111111111111',
    fsrs_state: 1,
    fsrs_step: 0,
    stability: null,
    difficulty: null,
    due_at:
      '2026-09-28T12:00:00Z',
    last_reviewed_at: null,
    review_count: 0,
    lapse_count: 0,
    suspended,
    progress_reset_at: null,
    created_at:
      '2026-09-28T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
  }
}

test(
  'cramStudyCards includes active cards regardless of due state',
  () => {
    const cards = [
      card('a'),
      {
        ...card('b'),
        due_at:
          '2030-01-01T00:00:00Z',
      },
    ]

    assert.deepEqual(
      cramStudyCards(cards).map(
        (item) => item.id,
      ),
      ['a', 'b'],
    )
  },
)

test(
  'cramStudyCards excludes suspended cards without mutating input',
  () => {
    const cards = [
      card('a'),
      card('b', true),
      card('c'),
    ]

    const result =
      cramStudyCards(cards)

    assert.deepEqual(
      result.map(
        (item) => item.id,
      ),
      ['a', 'c'],
    )
    assert.equal(
      cards.length,
      3,
    )
  },
)
