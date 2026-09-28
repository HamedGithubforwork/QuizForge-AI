import type {
  CardRow,
} from '../types/api.generated'

export function cramStudyCards(
  cards: CardRow[],
): CardRow[] {
  return cards.filter(
    (card) =>
      !card.suspended,
  )
}

export function weakCardLapseRate(
  card: CardRow,
): number {
  if (
    card.review_count <= 0
  ) {
    return 0
  }

  return (
    card.lapse_count /
    card.review_count
  )
}

export function isWeakStudyCard(
  card: CardRow,
): boolean {
  if (
    card.suspended ||
    card.review_count <= 0
  ) {
    return false
  }

  return (
    card.lapse_count > 0 ||
    (
      card.difficulty !== null &&
      card.difficulty >= 6
    )
  )
}

export function weakStudyCards(
  cards: CardRow[],
): CardRow[] {
  return cards
    .filter(isWeakStudyCard)
    .sort((left, right) => {
      const rateDifference =
        weakCardLapseRate(right) -
        weakCardLapseRate(left)

      if (rateDifference !== 0) {
        return rateDifference
      }

      const lapseDifference =
        right.lapse_count -
        left.lapse_count

      if (lapseDifference !== 0) {
        return lapseDifference
      }

      const difficultyDifference =
        (right.difficulty ?? 0) -
        (left.difficulty ?? 0)

      if (
        difficultyDifference !== 0
      ) {
        return difficultyDifference
      }

      const reviewDifference =
        right.review_count -
        left.review_count

      if (reviewDifference !== 0) {
        return reviewDifference
      }

      return left.id.localeCompare(
        right.id,
      )
    })
}

export function weakCardLabel(
  card: CardRow,
): string {
  const parts: string[] = []

  if (card.lapse_count > 0) {
    parts.push(
      `${card.lapse_count} ${card.lapse_count === 1 ? 'lapse' : 'lapses'}`,
    )
  }

  if (
    card.difficulty !== null
  ) {
    parts.push(
      `difficulty ${card.difficulty.toFixed(1)}`,
    )
  }

  return (
    parts.join(' · ') ||
    'Needs practice'
  )
}
