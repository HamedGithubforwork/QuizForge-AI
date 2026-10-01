export type DeckRoute =
  | { kind: 'list' }
  | { kind: 'missed' }
  | { kind: 'detail'; deckId: string }
  | { kind: 'review'; deckId: string }
  | { kind: 'cram'; deckId: string }
  | { kind: 'weak'; deckId: string }
  | { kind: 'recent'; deckId: string }
  | { kind: 'ai-practice'; deckId: string }
  | { kind: 'exam'; deckId: string }
  | { kind: 'invalid' }

const DECK_ID =
  '([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})'

const DETAIL_PATH =
  new RegExp(
    `^/decks/${DECK_ID}$`,
    'i',
  )

const MODE_PATHS: ReadonlyArray<{
  kind:
    | 'review'
    | 'cram'
    | 'weak'
    | 'recent'
    | 'ai-practice'
    | 'exam'
  pattern: RegExp
}> = [
  {
    kind: 'review',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/review$`,
      'i',
    ),
  },
  {
    kind: 'cram',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/cram$`,
      'i',
    ),
  },
  {
    kind: 'weak',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/weak$`,
      'i',
    ),
  },
  {
    kind: 'recent',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/recent$`,
      'i',
    ),
  },
  {
    kind: 'ai-practice',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/ai-practice$`,
      'i',
    ),
  },
  {
    kind: 'exam',
    pattern: new RegExp(
      `^/decks/${DECK_ID}/exam$`,
      'i',
    ),
  },
]

export function resolveDeckRoute(
  pathname: string,
): DeckRoute {
  if (pathname === '/decks') {
    return { kind: 'list' }
  }

  if (pathname === '/decks/missed') {
    return { kind: 'missed' }
  }

  for (
    const {
      kind,
      pattern,
    } of MODE_PATHS
  ) {
    const match =
      pathname.match(pattern)

    if (match) {
      return {
        kind,
        deckId: match[1],
      }
    }
  }

  const detail =
    pathname.match(DETAIL_PATH)

  if (detail) {
    return {
      kind: 'detail',
      deckId: detail[1],
    }
  }

  return { kind: 'invalid' }
}
