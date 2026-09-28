import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cramStudyCards,
  recentlyAddedStudyCards,
  isWeakStudyCard,
  weakCardLabel,
  weakCardLapseRate,
  weakStudyCards,
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

test(
  'weakStudyCards excludes unreviewed and suspended cards',
  () => {
    const cards = [
      card('new'),
      {
        ...card('hard'),
        review_count: 2,
        difficulty: 7.2,
      },
      {
        ...card('lapsed'),
        review_count: 4,
        lapse_count: 1,
        difficulty: 5.4,
      },
      {
        ...card('suspended', true),
        review_count: 5,
        lapse_count: 3,
        difficulty: 8.0,
      },
    ]

    assert.deepEqual(
      weakStudyCards(cards).map(
        (item) => item.id,
      ),
      ['lapsed', 'hard'],
    )
    assert.equal(
      isWeakStudyCard(cards[0]),
      false,
    )
    assert.equal(
      isWeakStudyCard(cards[3]),
      false,
    )
  },
)

test(
  'weakStudyCards ranks lapse rate then lapse count then difficulty',
  () => {
    const cards = [
      {
        ...card('difficulty'),
        review_count: 8,
        lapse_count: 0,
        difficulty: 8.4,
      },
      {
        ...card('rate'),
        review_count: 2,
        lapse_count: 1,
        difficulty: 6.1,
      },
      {
        ...card('count'),
        review_count: 8,
        lapse_count: 2,
        difficulty: 8.8,
      },
      {
        ...card('same-rate-more-lapses'),
        review_count: 4,
        lapse_count: 2,
        difficulty: 6.2,
      },
    ]

    assert.deepEqual(
      weakStudyCards(cards).map(
        (item) => item.id,
      ),
      [
        'same-rate-more-lapses',
        'rate',
        'count',
        'difficulty',
      ],
    )
  },
)

test(
  'weak-card helpers expose bounded evidence labels',
  () => {
    const target = {
      ...card('weak'),
      review_count: 5,
      lapse_count: 2,
      difficulty: 7.25,
    }

    assert.equal(
      weakCardLapseRate(
        target,
      ),
      0.4,
    )
    assert.equal(
      weakCardLabel(target),
      '2 lapses · difficulty 7.3',
    )
  },
)

test(
  'recentlyAddedStudyCards returns newest active cards first',
  () => {
    const cards = [
      {
        ...card('older'),
        created_at:
          '2026-09-20T12:00:00Z',
      },
      {
        ...card('newest'),
        created_at:
          '2026-09-28T12:00:00Z',
      },
      {
        ...card('middle'),
        created_at:
          '2026-09-25T12:00:00Z',
      },
      {
        ...card('suspended', true),
        created_at:
          '2026-09-29T12:00:00Z',
      },
    ]

    assert.deepEqual(
      recentlyAddedStudyCards(
        cards,
      ).map(
        (item) => item.id,
      ),
      [
        'newest',
        'middle',
        'older',
      ],
    )
    assert.equal(
      cards[0].id,
      'older',
    )
  },
)

test(
  'recentlyAddedStudyCards applies the bounded session limit',
  () => {
    const cards =
      Array.from(
        {
          length: 25,
        },
        (_, index) => ({
          ...card(
            String(index),
          ),
          created_at:
            new Date(
              Date.UTC(
                2026,
                8,
                1,
                0,
                index,
              ),
            ).toISOString(),
        }),
      )

    const result =
      recentlyAddedStudyCards(
        cards,
        5,
      )

    assert.equal(
      result.length,
      5,
    )
    assert.deepEqual(
      result.map(
        (item) => item.id,
      ),
      [
        '24',
        '23',
        '22',
        '21',
        '20',
      ],
    )

    assert.throws(
      () =>
        recentlyAddedStudyCards(
          cards,
          0,
        ),
      /between 1 and 100/,
    )
    assert.throws(
      () =>
        recentlyAddedStudyCards(
          cards,
          101,
        ),
      /between 1 and 100/,
    )
  },
)

