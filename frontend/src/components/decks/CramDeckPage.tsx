import {
  cramStudyCards,
} from '../../lib/studyModes'
import type {
  DeckDetail,
} from '../../types/api.generated'
import PresentationStudyModePage from './PresentationStudyModePage'

type CramDeckPageProps = {
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
        'Add cards to this deck before starting a cram session.',
    }
  }

  return {
    title:
      'No active cards to cram',
    body:
      'All cards in this deck are suspended. Resume at least one card to study it.',
  }
}

export default function CramDeckPage({
  deckId,
  onNavigate,
}: CramDeckPageProps) {
  return (
    <PresentationStudyModePage
      deckId={deckId}
      onNavigate={onNavigate}
      selectCards={
        cramStudyCards
      }
      loadingText="Preparing cram session…"
      errorTitle="Could not start cram mode"
      modeBadge="Cram · schedule unchanged"
      completeEyebrow="CRAM COMPLETE"
      completeTitle="You studied all active cards"
      restartLabel="Cram Again"
      exitLabel="Exit Cram"
      finishLabel="Finish Cram"
      emptyEyebrow="CRAM MODE"
      scheduleNote="Your normal FSRS due dates, review counts, and history were not changed."
      emptyState={emptyState}
    />
  )
}
