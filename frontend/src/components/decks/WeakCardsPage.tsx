import {
  weakCardLabel,
  weakStudyCards,
} from '../../lib/studyModes'
import type {
  DeckDetail,
} from '../../types/api.generated'
import PresentationStudyModePage from './PresentationStudyModePage'

type WeakCardsPageProps = {
  deckId: string
  onNavigate: (path: string) => void
}

function emptyState(
  deck: DeckDetail,
) {
  if (deck.card_count === 0) {
    return {
      title: 'This deck is empty',
      body:
        'Add cards before starting a weak-card session.',
    }
  }

  const activeCards =
    deck.cards.filter(
      (card) =>
        !card.suspended,
    )

  if (
    activeCards.length === 0
  ) {
    return {
      title: 'No active cards to study',
      body:
        'All cards in this deck are suspended. Resume at least one card to include it.',
    }
  }

  const reviewedCards =
    activeCards.filter(
      (card) =>
        card.review_count > 0,
    )

  if (
    reviewedCards.length === 0
  ) {
    return {
      title: 'No weak cards yet',
      body:
        'Review some cards normally first. Weak Cards uses your review history and FSRS difficulty to find material that needs extra practice.',
    }
  }

  return {
    title:
      'No weak cards right now',
    body:
      'None of the active reviewed cards currently have a lapse or FSRS difficulty of 6 or higher.',
  }
}

export default function WeakCardsPage({
  deckId,
  onNavigate,
}: WeakCardsPageProps) {
  return (
    <PresentationStudyModePage
      deckId={deckId}
      onNavigate={onNavigate}
      selectCards={
        weakStudyCards
      }
      loadingText="Finding weak cards…"
      errorTitle="Could not start Weak Cards"
      modeBadge="Weak Cards · schedule unchanged"
      completeEyebrow="WEAK CARDS COMPLETE"
      completeTitle="You practiced your weakest cards"
      restartLabel="Practice Again"
      exitLabel="Exit Weak Cards"
      finishLabel="Finish Weak Cards"
      emptyEyebrow="WEAK CARDS"
      scheduleNote="This extra practice did not change your FSRS due dates, review counts, or review history."
      emptyState={emptyState}
      cardBadge={weakCardLabel}
    />
  )
}
