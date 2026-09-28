import type {
  CardRow,
} from '../types/api.generated'

export const MAX_CARD_TAGS = 20
export const MAX_CARD_TAG_LENGTH = 50

export function normalizeCardTags(
  values: string[],
): string[] {
  const result: string[] = []
  const seen =
    new Set<string>()

  for (const value of values) {
    const cleaned =
      value
        .trim()
        .replace(
          /\s+/g,
          ' ',
        )
        .toLowerCase()

    if (!cleaned) {
      continue
    }

    if (
      cleaned.length >
      MAX_CARD_TAG_LENGTH
    ) {
      throw new Error(
        'Tags can be at most '
          + MAX_CARD_TAG_LENGTH
          + ' characters.',
      )
    }

    if (seen.has(cleaned)) {
      continue
    }

    seen.add(cleaned)
    result.push(cleaned)
  }

  if (
    result.length >
    MAX_CARD_TAGS
  ) {
    throw new Error(
      'Use at most '
        + MAX_CARD_TAGS
        + ' tags per card.',
    )
  }

  return result
}

export function parseCardTags(
  value: string,
): string[] {
  return normalizeCardTags(
    value.split(','),
  )
}

export function deckTagOptions(
  cards: CardRow[],
): string[] {
  return normalizeCardTags(
    cards.flatMap(
      (card) =>
        card.tags ?? [],
    ),
  ).sort(
    (left, right) =>
      left.localeCompare(
        right,
      ),
  )
}

function searchableAnswer(
  card: CardRow,
): string {
  const value =
    card.answer

  if (
    value &&
    typeof value === 'object' &&
    'correct_answer' in value &&
    typeof value.correct_answer ===
      'string'
  ) {
    return value.correct_answer
  }

  return ''
}

export function filterStudyCards(
  cards: CardRow[],
  query: string,
  tag: string,
): CardRow[] {
  const cleanQuery =
    query
      .trim()
      .toLowerCase()
  const cleanTag =
    tag
      .trim()
      .toLowerCase()

  return cards.filter(
    (card) => {
      if (
        cleanTag &&
        !(
          card.tags ?? []
        ).includes(cleanTag)
      ) {
        return false
      }

      if (!cleanQuery) {
        return true
      }

      const haystack = [
        card.question,
        searchableAnswer(
          card,
        ),
        card.explanation ?? '',
        ...(card.tags ?? []),
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(
        cleanQuery,
      )
    },
  )
}
