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
