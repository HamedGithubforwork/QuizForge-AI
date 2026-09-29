import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExamPlan,
} from './examPlanning.ts'
import type {
  CardRow,
  DeckDetail,
} from '../types/api.generated.ts'

const DECK_ID =
  '11111111-1111-4111-8111-111111111111'

function card(
  id: string,
  changes:
    Partial<CardRow> = {},
): CardRow {
  return {
    question_type:
      'short_answer',
    question:
      'Question ' + id,
    answer: {
      correct_answer:
        'Answer',
    },
    choices: null,
    explanation: null,
    source_filename: null,
    document_sha256: null,
    source_pages: [],
    tags: [],
    id,
    deck_id: DECK_ID,
    fsrs_state: 1,
    fsrs_step: 0,
    stability: null,
    difficulty: null,
    due_at:
      '2026-09-28T16:00:00Z',
    last_reviewed_at: null,
    review_count: 0,
    lapse_count: 0,
    suspended: false,
    progress_reset_at: null,
    created_at:
      '2026-09-20T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
    ...changes,
  }
}

function deck(
  cards: CardRow[],
  examDate:
    string | null =
      '2026-10-18',
): DeckDetail {
  return {
    id: DECK_ID,
    name: 'Biology',
    description: null,
    exam_date: examDate,
    card_count: cards.length,
    due_count: 0,
    next_due_at: null,
    created_at:
      '2026-09-20T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
    cards,
  }
}

const NOW = new Date(
  2026,
  8,
  28,
  12,
  0,
  0,
)

test(
  'returns null when no exam date is configured',
  () => {
    assert.equal(
      buildExamPlan(
        deck([], null),
        NOW,
      ),
      null,
    )
  },
)

test(
  'builds a balanced plan without double-counting new cards as review due',
  () => {
    const plan =
      buildExamPlan(
        deck([
          card('new-1'),
          card('new-2'),
          card(
            'due-reviewed',
            {
              review_count: 4,
              due_at:
                '2026-09-28T08:00:00Z',
            },
          ),
          card(
            'weak-not-due',
            {
              review_count: 5,
              lapse_count: 2,
              difficulty: 7,
              due_at:
                '2026-10-02T08:00:00Z',
              tags: [
                'cell biology',
              ],
            },
          ),
        ]),
        NOW,
      )

    assert.ok(plan)
    assert.equal(
      plan.daysRemaining,
      20,
    )
    assert.equal(
      plan.intensity,
      'balanced',
    )
    assert.equal(
      plan.newCardCount,
      2,
    )
    assert.equal(
      plan.reviewDueCount,
      1,
    )
    assert.equal(
      plan.weakCardCount,
      1,
    )
    assert.equal(
      plan.recommendedReviewCardsToday,
      2,
    )
    assert.equal(
      plan.recommendedNewCardsToday,
      1,
    )
    assert.equal(
      plan.recommendedTotalToday,
      3,
    )
    assert.deepEqual(
      plan.weakTags,
      [
        {
          tag: 'cell biology',
          count: 1,
        },
      ],
    )
  },
)

test(
  'intensity increases as the exam approaches',
  () => {
    const cards = [
      card('new'),
    ]

    const relaxed =
      buildExamPlan(
        deck(
          cards,
          '2026-11-20',
        ),
        NOW,
      )
    const balanced =
      buildExamPlan(
        deck(
          cards,
          '2026-10-18',
        ),
        NOW,
      )
    const intensive =
      buildExamPlan(
        deck(
          cards,
          '2026-10-05',
        ),
        NOW,
      )

    assert.equal(
      relaxed?.intensity,
      'relaxed',
    )
    assert.equal(
      balanced?.intensity,
      'balanced',
    )
    assert.equal(
      intensive?.intensity,
      'intensive',
    )
  },
)

test(
  'suspended cards are excluded and weak tags rank by frequency',
  () => {
    const plan =
      buildExamPlan(
        deck([
          card(
            'weak-1',
            {
              review_count: 3,
              lapse_count: 1,
              tags: [
                'genetics',
                'exam 1',
              ],
            },
          ),
          card(
            'weak-2',
            {
              review_count: 3,
              difficulty: 6.5,
              tags: [
                'genetics',
              ],
            },
          ),
          card(
            'suspended',
            {
              suspended: true,
              review_count: 5,
              lapse_count: 5,
              tags: [
                'ignored',
              ],
            },
          ),
        ]),
        NOW,
      )

    assert.ok(plan)
    assert.equal(
      plan.activeCardCount,
      2,
    )
    assert.equal(
      plan.weakCardCount,
      2,
    )
    assert.deepEqual(
      plan.weakTags,
      [
        {
          tag: 'genetics',
          count: 2,
        },
        {
          tag: 'exam 1',
          count: 1,
        },
      ],
    )
  },
)

test(
  'caps unrealistic daily workload but preserves the required pace',
  () => {
    const cards =
      Array.from(
        {
          length: 120,
        },
        (_, index) =>
          card(
            String(index),
          ),
      )

    const plan =
      buildExamPlan(
        deck(
          cards,
          '2026-09-29',
        ),
        NOW,
      )

    assert.ok(plan)
    assert.equal(
      plan.daysRemaining,
      1,
    )
    assert.equal(
      plan.requiredNewCardsPerDay,
      120,
    )
    assert.equal(
      plan.recommendedNewCardsToday,
      50,
    )
    assert.equal(
      plan.workloadCapped,
      true,
    )
  },
)

test(
  'flags the review cap when extra weak-card practice pushes the target over the limit',
  () => {
    const due =
      Array.from(
        {
          length: 140,
        },
        (_, index) =>
          card(
            `due-${index}`,
            {
              review_count: 2,
              due_at:
                '2026-09-28T08:00:00Z',
            },
          ),
      )

    const weakFuture =
      Array.from(
        {
          length: 15,
        },
        (_, index) =>
          card(
            `weak-${index}`,
            {
              review_count: 3,
              lapse_count: 1,
              difficulty: 7,
              due_at:
                '2026-10-03T08:00:00Z',
            },
          ),
      )

    const plan =
      buildExamPlan(
        deck(
          [
            ...due,
            ...weakFuture,
          ],
          '2026-10-05',
        ),
        NOW,
      )

    assert.ok(plan)
    assert.equal(
      plan.intensity,
      'intensive',
    )
    assert.equal(
      plan.recommendedReviewCardsToday,
      150,
    )
    assert.equal(
      plan.workloadCapped,
      true,
    )
  },
)

test(
  'past exams produce no new workload recommendation',
  () => {
    const plan =
      buildExamPlan(
        deck(
          [card('new')],
          '2026-09-20',
        ),
        NOW,
      )

    assert.ok(plan)
    assert.equal(
      plan.daysRemaining,
      -8,
    )
    assert.equal(
      plan.recommendedTotalToday,
      0,
    )
  },
)
