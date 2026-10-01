import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveDeckRoute,
} from './deckRoutes.ts'

const DECK_ID =
  '11111111-1111-4111-8111-111111111111'

test(
  'resolves the deck library and missed-question routes',
  () => {
    assert.deepEqual(
      resolveDeckRoute('/decks'),
      { kind: 'list' },
    )
    assert.deepEqual(
      resolveDeckRoute(
        '/decks/missed',
      ),
      { kind: 'missed' },
    )
  },
)

test(
  'resolves detail and study-mode routes with the deck id',
  () => {
    const cases = [
      [
        `/decks/${DECK_ID}`,
        'detail',
      ],
      [
        `/decks/${DECK_ID}/review`,
        'review',
      ],
      [
        `/decks/${DECK_ID}/cram`,
        'cram',
      ],
      [
        `/decks/${DECK_ID}/weak`,
        'weak',
      ],
      [
        `/decks/${DECK_ID}/recent`,
        'recent',
      ],
      [
        `/decks/${DECK_ID}/ai-practice`,
        'ai-practice',
      ],
      [
        `/decks/${DECK_ID}/exam`,
        'exam',
      ],
    ] as const

    for (
      const [
        pathname,
        kind,
      ] of cases
    ) {
      assert.deepEqual(
        resolveDeckRoute(pathname),
        {
          kind,
          deckId: DECK_ID,
        },
      )
    }
  },
)

test(
  'accepts uppercase hexadecimal deck ids',
  () => {
    const upper =
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'

    assert.deepEqual(
      resolveDeckRoute(
        `/decks/${upper}/review`,
      ),
      {
        kind: 'review',
        deckId: upper,
      },
    )
  },
)

test(
  'rejects malformed and unknown deck routes',
  () => {
    for (
      const pathname of [
        '/decks/not-a-uuid',
        `/decks/${DECK_ID}/unknown`,
        `/decks/${DECK_ID}/review/extra`,
        '/decks/',
        '/decks/missed/extra',
      ]
    ) {
      assert.deepEqual(
        resolveDeckRoute(pathname),
        { kind: 'invalid' },
      )
    }
  },
)
