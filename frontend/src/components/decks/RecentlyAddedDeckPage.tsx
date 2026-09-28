import {
  recentlyAddedStudyCards,
} from '../../lib/studyModes'
import type {
  DeckDetail,
} from '../../types/api.generated'
import PresentationStudyModePage from './PresentationStudyModePage'

type RecentlyAddedDeckPageProps = {
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
        'Add cards before starting a Recently Added session.',
    }
  }

  return {
    title:
      'No active cards to study',
    body:
      'All cards in this deck are suspended. Resume at least one card to include it.',
  }
}

export default function RecentlyAddedDeckPage({
  deckId,
  onNavigate,
}: RecentlyAddedDeckPageProps) {
  return (
    <PresentationStudyModePage
      deckId={deckId}
      onNavigate={onNavigate}
      selectCards={
        recentlyAddedStudyCards
      }
      loadingText="Finding recently added cards…"
      errorTitle="Could not start Recently Added"
      modeBadge="Recently Added · newest active cards"
      completeEyebrow="RECENTLY ADDED COMPLETE"
      completeTitle="You practiced your newest cards"
      restartLabel="Study Again"
      exitLabel="Exit Recently Added"
      finishLabel="Finish Recently Added"
      emptyEyebrow="RECENTLY ADDED"
      scheduleNote="This extra practice did not change your FSRS due dates, review counts, or review history."
      emptyState={emptyState}
    />
  )
}
