import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatRetention,
  formatStudyDuration,
  getStudyAnalytics,
  ratingPercent,
} from './studyAnalytics.ts'

test(
  'getStudyAnalytics encodes the browser timezone',
  async () => {
    let path = ''

    const result =
      await getStudyAnalytics(
        'America/Toronto',
        async (
          requestPath,
        ) => {
          path = requestPath
          return new Response(
            JSON.stringify({
              timezone:
                'America/Toronto',
              generated_at:
                '2026-09-29T02:00:00Z',
              total_decks: 1,
              activity: {
                reviews_today: 2,
                reviews_last_7_days: 8,
                study_time_today_ms: 60000,
                study_time_last_7_days_ms: 240000,
                active_days_last_7_days: 3,
              },
              memory: {
                total_cards: 10,
                active_cards: 9,
                suspended_cards: 1,
                due_cards: 2,
                new_cards: 3,
                learning_cards: 2,
                review_cards: 4,
                mature_cards: 1,
                retention_card_count: 6,
                estimated_retention: 0.92,
              },
              ratings_last_30_days: {
                again: 1,
                hard: 1,
                good: 4,
                easy: 2,
                total: 8,
              },
              difficult_cards: [],
            }),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
      )

    assert.equal(
      path,
      '/api/study-analytics/summary?timezone=America%2FToronto',
    )
    assert.equal(
      result.memory
        .estimated_retention,
      0.92,
    )
  },
)

test(
  'formatStudyDuration keeps compact readable output',
  () => {
    assert.equal(
      formatStudyDuration(0),
      '0m',
    )
    assert.equal(
      formatStudyDuration(
        59 * 60000,
      ),
      '59m',
    )
    assert.equal(
      formatStudyDuration(
        60 * 60000,
      ),
      '1h',
    )
    assert.equal(
      formatStudyDuration(
        95 * 60000,
      ),
      '1h 35m',
    )
  },
)

test(
  'retention and rating helpers clamp safe display values',
  () => {
    assert.equal(
      formatRetention(null),
      '—',
    )
    assert.equal(
      formatRetention(0.914),
      '91%',
    )
    assert.equal(
      formatRetention(2),
      '100%',
    )
    assert.equal(
      ratingPercent(3, 4),
      75,
    )
    assert.equal(
      ratingPercent(5, 0),
      0,
    )
  },
)
