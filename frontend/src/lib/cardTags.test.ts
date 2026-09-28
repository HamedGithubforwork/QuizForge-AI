import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deckTagOptions,
  filterStudyCards,
  normalizeCardTags,
  parseCardTags,
} from './cardTags.ts'
import type {
  CardRow,
} from '../types/api.generated'

function card(
  overrides:
    Partial<CardRow> = {},
): CardRow {
  return {
    question_type:
      'short_answer',
    question:
      'What is ATP?',
    answer: {
      correct_answer:
        'Adenosine triphosphate',
    },
    choices: null,
    explanation:
      'Cell energy molecule',
    source_filename:
      null,
    document_sha256:
      null,
    source_pages: [],
    tags: [
      'biochemistry',
      'exam 1',
    ],
    id:
      '22222222-2222-4222-8222-222222222222',
    deck_id:
      '11111111-1111-4111-8111-111111111111',
    fsrs_state: 1,
    fsrs_step: 0,
    stability: null,
    difficulty: null,
    due_at:
      '2026-09-28T12:00:00Z',
    last_reviewed_at:
      null,
    review_count: 0,
    lapse_count: 0,
    suspended: false,
    progress_reset_at:
      null,
    created_at:
      '2026-09-28T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
    ...overrides,
  }
}

test(
  'normalizes whitespace case and duplicates',
  () => {
    assert.deepEqual(
      normalizeCardTags([
        '  Exam   One ',
        'exam one',
        'Neuro Biology',
      ]),
      [
        'exam one',
        'neuro biology',
      ],
    )

    assert.deepEqual(
      parseCardTags(
        ' High Yield, finals, HIGH   YIELD ',
      ),
      [
        'high yield',
        'finals',
      ],
    )
  },
)

test(
  'rejects tag length and count overflow',
  () => {
    assert.throws(
      () =>
        normalizeCardTags([
          'x'.repeat(51),
        ]),
      /50 characters/,
    )

    assert.throws(
      () =>
        normalizeCardTags(
          Array.from(
            {
              length: 21,
            },
            (_value, index) =>
              'tag ' + index,
          ),
        ),
      /20 tags/,
    )
  },
)

test(
  'derives sorted deck tag options',
  () => {
    assert.deepEqual(
      deckTagOptions([
        card(),
        card({
          tags: [
            'zebra',
            'biochemistry',
          ],
        }),
      ]),
      [
        'biochemistry',
        'exam 1',
        'zebra',
      ],
    )
  },
)

test(
  'filters cards by text and tag together',
  () => {
    const cards = [
      card(),
      card({
        id:
          '33333333-3333-4333-8333-333333333333',
        question:
          'Which lobe handles vision?',
        answer: {
          correct_answer:
            'Occipital lobe',
        },
        explanation:
          'Visual cortex',
        tags: [
          'neuroscience',
        ],
      }),
    ]

    assert.equal(
      filterStudyCards(
        cards,
        'occipital',
        '',
      ).length,
      1,
    )

    assert.equal(
      filterStudyCards(
        cards,
        'atp',
        'biochemistry',
      ).length,
      1,
    )

    assert.equal(
      filterStudyCards(
        cards,
        'vision',
        'biochemistry',
      ).length,
      0,
    )
  },
)
