import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  deckTagOptions,
  filterStudyCards,
} from '../../lib/cardTags'
import {
  buildWeakDeckAiFocus,
} from '../../lib/deckAiPractice'
import {
  addCardsToStudyDeck,
  deleteStudyCard,
  deleteStudyDeck,
  duplicateStudyDeck,
  getStudyDeck,
  listStudyDecks,
  moveStudyCard,
  resetStudyCardProgress,
  resumeStudyCard,
  suspendStudyCard,
  updateStudyCard,
  updateStudyDeck,
} from '../../lib/decks'
import type {
  CardCreate,
  CardRow,
  DeckDetail,
  DeckSummary,
} from '../../types/api.generated'
import CardEditor from './CardEditor'
import CramDeckPage from './CramDeckPage'
import DeckAiPracticePage from './DeckAiPracticePage'
import ExamPlanPage from './ExamPlanPage'
import MissedQuestionsPage from './MissedQuestionsPage'
import RecentlyAddedDeckPage from './RecentlyAddedDeckPage'
import ReviewDeckPage from './ReviewDeckPage'
import WeakCardsPage from './WeakCardsPage'
import './DecksPage.css'

type DecksPageProps = {
  pathname: string
  onNavigate: (path: string) => void
}

const DECK_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

const REVIEW_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/review$/i

const LEARN_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/learn$/i

const CRAM_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/cram$/i

const WEAK_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/weak$/i

const RECENT_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/recent$/i

const AI_PRACTICE_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/ai-practice$/i

const EXAM_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/exam$/i

function formatDeckDate(
  value: string,
) {
  const date = new Date(value)

  if (
    Number.isNaN(date.getTime())
  ) {
    return 'Recently'
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    },
  ).format(date)
}

type StudyIntensity =
  DeckDetail['study_intensity']

const STUDY_INTENSITIES: Array<{
  value: StudyIntensity
  label: string
  retention: string
  description: string
}> = [
  {
    value: 'relaxed',
    label: 'Relaxed',
    retention: '85%',
    description:
      'Longer intervals and fewer scheduled reviews.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    retention: '90%',
    description:
      'Current default with a balanced review workload.',
  },
  {
    value: 'intensive',
    label: 'Intensive',
    retention: '95%',
    description:
      'Shorter intervals for stronger target retention.',
  },
]

function studyIntensityInfo(
  value: StudyIntensity,
) {
  return (
    STUDY_INTENSITIES.find(
      (item) =>
        item.value === value,
    ) ??
    STUDY_INTENSITIES[1]
  )
}

function hasStudyProgress(
  card: CardRow,
) {
  return (
    card.review_count > 0 ||
    card.lapse_count > 0 ||
    card.last_reviewed_at !== null ||
    card.stability !== null ||
    card.difficulty !== null ||
    card.fsrs_state !== 1 ||
    card.fsrs_step !== 0
  )
}

function answerText(
  card: CardRow,
) {
  const answer = card.answer

  if (
    answer &&
    typeof answer === 'object' &&
    'correct_answer' in answer &&
    typeof answer.correct_answer ===
      'string'
  ) {
    return answer.correct_answer
  }

  return 'Answer saved'
}

function DeckList({
  decks,
  onNavigate,
}: {
  decks: DeckSummary[]
  onNavigate: (path: string) => void
}) {
  if (decks.length === 0) {
    return (
      <section className="decks-empty">
        <div
          className="decks-empty-icon"
          aria-hidden="true"
        >
          ◫
        </div>

        <h2>
          No study decks yet
        </h2>

        <p>
          Generate a quiz, finish it,
          and choose{' '}
          <strong>
            Save as Study Deck
          </strong>
          {' '}to keep the questions
          for future review.
        </p>

        <button
          className="decks-primary-button"
          type="button"
          onClick={() =>
            onNavigate('/')
          }
        >
          Generate a Quiz
        </button>
      </section>
    )
  }

  return (
    <div className="decks-grid">
      {decks.map((deck) => (
        <button
          className="deck-tile"
          type="button"
          key={deck.id}
          onClick={() =>
            onNavigate(
              `/decks/${deck.id}`,
            )
          }
        >
          <div className="deck-tile-top">
            <span className="deck-icon">
              ◫
            </span>

            <div className="deck-tile-badges">
              <span className="deck-count">
                {deck.card_count}{' '}
                {deck.card_count === 1
                  ? 'card'
                  : 'cards'}
              </span>

              {deck.review_due_count > 0 && (
                <span className="deck-due-badge deck-due-badge-active">
                  {deck.review_due_count}
                  {' '}review
                </span>
              )}

              {deck.new_count > 0 && (
                <span className="deck-new-badge">
                  {deck.new_count}
                  {' '}new
                </span>
              )}

              {deck.review_due_count === 0 &&
                deck.new_count === 0 && (
                <span className="deck-due-badge">
                  Caught up
                </span>
              )}
            </div>
          </div>

          <h2>{deck.name}</h2>

          {deck.description && (
            <p>
              {deck.description}
            </p>
          )}

          <span className="deck-updated">
            Updated{' '}
            {formatDeckDate(
              deck.updated_at,
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

function DeckDetailView({
  deck,
  availableDecks,
  onNavigate,
  onDeckUpdated,
}: {
  deck: DeckDetail
  availableDecks: DeckSummary[]
  onNavigate: (path: string) => void
  onDeckUpdated: (
    deck: DeckDetail,
  ) => void
}) {
  const [editing, setEditing] =
    useState(false)
  const [
    confirmingDelete,
    setConfirmingDelete,
  ] = useState(false)
  const [deckName, setDeckName] =
    useState(deck.name)
  const [
    studySettingsOpen,
    setStudySettingsOpen,
  ] = useState(false)
  const [
    studyIntensity,
    setStudyIntensity,
  ] = useState<StudyIntensity>(
    deck.study_intensity,
  )
  const [busy, setBusy] =
    useState(false)
  const [
    managementError,
    setManagementError,
  ] = useState('')

  const [addingCard, setAddingCard] =
    useState(false)
  const [
    editingCardId,
    setEditingCardId,
  ] = useState<string | null>(
    null,
  )
  const [
    confirmingCardDelete,
    setConfirmingCardDelete,
  ] = useState<string | null>(
    null,
  )
  const [
    confirmingProgressReset,
    setConfirmingProgressReset,
  ] = useState<string | null>(
    null,
  )
  const [
    movingCardId,
    setMovingCardId,
  ] = useState<string | null>(
    null,
  )
  const [
    moveTargetDeckId,
    setMoveTargetDeckId,
  ] = useState('')
  const [
    cardActionBusy,
    setCardActionBusy,
  ] = useState(false)
  const [
    cardActionError,
    setCardActionError,
  ] = useState('')
  const [cardSearch, setCardSearch] =
    useState('')
  const [selectedTag, setSelectedTag] =
    useState('')

  useEffect(() => {
    setDeckName(deck.name)
    setStudyIntensity(
      deck.study_intensity,
    )
    setStudySettingsOpen(false)
    setEditing(false)
    setConfirmingDelete(false)
    setManagementError('')
    setAddingCard(false)
    setEditingCardId(null)
    setConfirmingCardDelete(null)
    setConfirmingProgressReset(null)
    setMovingCardId(null)
    setMoveTargetDeckId('')
    setCardActionError('')
    setCardActionBusy(false)
    setCardSearch('')
    setSelectedTag('')
  }, [
    deck.id,
    deck.name,
    deck.study_intensity,
  ])

  async function handleRename(
    event: FormEvent,
  ) {
    event.preventDefault()

    const cleanName =
      deckName.trim()

    if (!cleanName) {
      setManagementError(
        'Deck name cannot be blank.',
      )
      return
    }

    if (cleanName === deck.name) {
      setEditing(false)
      setManagementError('')
      return
    }

    setBusy(true)
    setManagementError('')

    try {
      const updated =
        await updateStudyDeck(
          deck.id,
          {
            name: cleanName,
          },
          apiFetch,
        )

      onDeckUpdated(updated)
      setDeckName(updated.name)
      setEditing(false)
    } catch (caught) {
      setManagementError(
        caught instanceof Error
          ? caught.message
          : 'Could not rename this study deck.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleStudySettingsSave(
    event: FormEvent,
  ) {
    event.preventDefault()

    if (
      studyIntensity ===
      deck.study_intensity
    ) {
      setStudySettingsOpen(false)
      setManagementError('')
      return
    }

    setBusy(true)
    setManagementError('')

    try {
      const updated =
        await updateStudyDeck(
          deck.id,
          {
            study_intensity:
              studyIntensity,
          },
          apiFetch,
        )

      onDeckUpdated(updated)
      setStudyIntensity(
        updated.study_intensity,
      )
      setStudySettingsOpen(false)
    } catch (caught) {
      setManagementError(
        caught instanceof Error
          ? caught.message
          : 'Could not update study intensity.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    setStudySettingsOpen(false)
    setBusy(true)
    setManagementError('')

    try {
      await deleteStudyDeck(
        deck.id,
        apiFetch,
      )

      onNavigate('/decks')
    } catch (caught) {
      setManagementError(
        caught instanceof Error
          ? caught.message
          : 'Could not delete this study deck.',
      )
      setBusy(false)
    }
  }

  async function handleDuplicate() {
    setBusy(true)
    setEditing(false)
    setStudySettingsOpen(false)
    setConfirmingDelete(false)
    setManagementError('')

    try {
      const duplicated =
        await duplicateStudyDeck(
          deck.id,
          {},
          apiFetch,
        )

      onNavigate(
        `/decks/${duplicated.id}`,
      )
    } catch (caught) {
      setManagementError(
        caught instanceof Error
          ? caught.message
          : 'Could not duplicate this study deck.',
      )
      setBusy(false)
    }
  }

  async function handleAddCard(
    payload: CardCreate,
  ) {
    const updated =
      await addCardsToStudyDeck(
        deck.id,
        [payload],
        apiFetch,
      )

    onDeckUpdated(updated)
    setAddingCard(false)
    setCardActionError('')
  }

  async function handleEditCard(
    cardId: string,
    payload: CardCreate,
  ) {
    const updated =
      await updateStudyCard(
        deck.id,
        cardId,
        {
          question_type:
            payload.question_type,
          question:
            payload.question,
          answer:
            payload.answer,
          choices:
            payload.choices,
          explanation:
            payload.explanation,
          source_filename:
            payload.source_filename,
          document_sha256:
            payload.document_sha256,
          source_pages:
            payload.source_pages,
        },
        apiFetch,
      )

    onDeckUpdated(updated)
    setEditingCardId(null)
    setCardActionError('')
  }

  async function handleMoveCard(
    cardId: string,
  ) {
    if (
      !moveTargetDeckId ||
      moveTargetDeckId === deck.id
    ) {
      setCardActionError(
        'Choose a different destination deck.',
      )
      return
    }

    setCardActionBusy(true)
    setCardActionError('')

    try {
      const updated =
        await moveStudyCard(
          deck.id,
          cardId,
          {
            target_deck_id:
              moveTargetDeckId,
          },
          apiFetch,
        )

      onDeckUpdated(updated)
      setMovingCardId(null)
      setMoveTargetDeckId('')
    } catch (caught) {
      setCardActionError(
        caught instanceof Error
          ? caught.message
          : 'Could not move this study card.',
      )
    } finally {
      setCardActionBusy(false)
    }
  }

  async function handleSuspendCard(
    card: CardRow,
  ) {
    setCardActionBusy(true)
    setCardActionError('')

    try {
      const updated =
        card.suspended
          ? await resumeStudyCard(
              deck.id,
              card.id,
              apiFetch,
            )
          : await suspendStudyCard(
              deck.id,
              card.id,
              apiFetch,
            )

      onDeckUpdated(updated)
      setConfirmingProgressReset(
        null,
      )
    } catch (caught) {
      setCardActionError(
        caught instanceof Error
          ? caught.message
          : card.suspended
            ? 'Could not resume this study card.'
            : 'Could not suspend this study card.',
      )
    } finally {
      setCardActionBusy(false)
    }
  }

  async function handleResetProgress(
    cardId: string,
  ) {
    setCardActionBusy(true)
    setCardActionError('')

    try {
      const updated =
        await resetStudyCardProgress(
          deck.id,
          cardId,
          apiFetch,
        )

      onDeckUpdated(updated)
      setConfirmingProgressReset(
        null,
      )
    } catch (caught) {
      setCardActionError(
        caught instanceof Error
          ? caught.message
          : 'Could not reset this study card progress.',
      )
    } finally {
      setCardActionBusy(false)
    }
  }

  async function handleDeleteCard(
    cardId: string,
  ) {
    setCardActionBusy(true)
    setCardActionError('')

    try {
      await deleteStudyCard(
        deck.id,
        cardId,
        apiFetch,
      )

      const updated =
        await getStudyDeck(
          deck.id,
          apiFetch,
        )

      onDeckUpdated(updated)
      setConfirmingCardDelete(
        null,
      )
    } catch (caught) {
      setCardActionError(
        caught instanceof Error
          ? caught.message
          : 'Could not delete this study card.',
      )
    } finally {
      setCardActionBusy(false)
    }
  }

  const tagOptions =
    deckTagOptions(
      deck.cards,
    )
  const visibleCards =
    filterStudyCards(
      deck.cards,
      cardSearch,
      selectedTag,
    )
  const filtersActive =
    Boolean(
      cardSearch.trim()
      || selectedTag,
    )
  const activeCardCount =
    deck.cards.filter(
      (card) =>
        !card.suspended,
    ).length

  const aiPracticeFocus =
    buildWeakDeckAiFocus(
      deck,
    )

  return (
    <>
      <button
        className="decks-back"
        type="button"
        onClick={() =>
          onNavigate('/decks')
        }
      >
        ← My Decks
      </button>

      <section className="deck-detail-header">
        <div>
          <span className="decks-eyebrow">
            STUDY DECK
          </span>

          <h1>{deck.name}</h1>

          {deck.description && (
            <p>
              {deck.description}
            </p>
          )}

          <div className="deck-study-intensity-summary">
            <span>
              Study intensity
            </span>
            <strong>
              {
                studyIntensityInfo(
                  deck.study_intensity,
                ).label
              }
            </strong>
            <small>
              {
                studyIntensityInfo(
                  deck.study_intensity,
                ).retention
              } target retention
            </small>
          </div>

          <div className="deck-management-buttons">
            <button
              className="deck-management-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(true)
                setStudySettingsOpen(false)
                setConfirmingDelete(false)
                setDeckName(deck.name)
                setManagementError('')
              }}
            >
              Rename
            </button>

            <button
              className="deck-management-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setStudySettingsOpen(true)
                setEditing(false)
                setConfirmingDelete(false)
                setStudyIntensity(
                  deck.study_intensity,
                )
                setManagementError('')
              }}
            >
              Study Settings
            </button>

            <button
              className="deck-management-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void handleDuplicate()
              }
            >
              Duplicate
            </button>

            <button
              className="deck-management-button deck-management-danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(true)
                setEditing(false)
                setStudySettingsOpen(false)
                setManagementError('')
              }}
            >
              Delete
            </button>
          </div>
        </div>

        <div className="deck-detail-actions">
          <div className="deck-detail-stats">
            <div className="deck-detail-stat">
              <strong>
                {deck.card_count}
              </strong>

              <span>
                {deck.card_count === 1
                  ? 'card'
                  : 'cards'}
              </span>
            </div>

            <div
              className={
                deck.review_due_count > 0
                  ? 'deck-detail-stat deck-detail-stat-due'
                  : 'deck-detail-stat deck-detail-stat-clear'
              }
            >
              <strong>
                {deck.review_due_count}
              </strong>

              <span>reviews due</span>
            </div>

            <div
              className={
                deck.new_count > 0
                  ? 'deck-detail-stat deck-detail-stat-new'
                  : 'deck-detail-stat deck-detail-stat-clear'
              }
            >
              <strong>
                {deck.new_count}
              </strong>

              <span>new cards</span>
            </div>
          </div>

          <button
            className="decks-secondary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setAddingCard(true)
              setEditingCardId(null)
              setConfirmingCardDelete(null)
              setCardActionError('')
            }}
          >
            + Add Card
          </button>

          {activeCardCount > 0 && (
            <button
              className="decks-secondary-button deck-learn-new-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/learn`,
                )
              }
            >
              {deck.new_count > 0
                ? `Learn ${deck.new_count} New`
                : 'Learn New (0)'}
            </button>
          )}

          {activeCardCount > 0 && (
            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/cram`,
                )
              }
            >
              Study All (Cram)
            </button>
          )}

          {activeCardCount > 0 && (
            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/weak`,
                )
              }
            >
              Practice Weak Cards
            </button>
          )}

          {activeCardCount > 0 && (
            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/recent`,
                )
              }
            >
              Recently Added
            </button>
          )}

          {aiPracticeFocus && (
            <button
              className="decks-secondary-button deck-ai-practice-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/ai-practice`,
                )
              }
            >
              Generate AI Practice
            </button>
          )}

          <button
            className="decks-secondary-button deck-exam-plan-button"
            type="button"
            onClick={() =>
              onNavigate(
                `/decks/${deck.id}/exam`,
              )
            }
          >
            {deck.exam_date
              ? 'Exam Plan'
              : 'Set Exam Date'}
          </button>

          {deck.card_count > 0 && (
            <button
              className="decks-primary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deck.id}/review`,
                )
              }
            >
              {deck.review_due_count > 0
                ? `Review ${deck.review_due_count} Due`
                : 'Review Due (0)'}
            </button>
          )}
        </div>
      </section>

      {editing && (
        <form
          className="deck-management-panel"
          onSubmit={handleRename}
        >
          <div>
            <span className="decks-eyebrow">
              RENAME DECK
            </span>

            <h2>
              Change deck name
            </h2>
          </div>

          <input
            type="text"
            value={deckName}
            maxLength={200}
            autoFocus
            disabled={busy}
            aria-label="Deck name"
            onChange={(event) =>
              setDeckName(
                event.target.value,
              )
            }
          />

          <div className="deck-management-panel-actions">
            <button
              className="decks-primary-button"
              type="submit"
              disabled={
                busy ||
                !deckName.trim()
              }
            >
              {busy
                ? 'Saving…'
                : 'Save Name'}
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setDeckName(deck.name)
                setManagementError('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {studySettingsOpen && (
        <form
          className="deck-management-panel deck-study-settings-panel"
          onSubmit={
            handleStudySettingsSave
          }
        >
          <div>
            <span className="decks-eyebrow">
              STUDY SETTINGS
            </span>

            <h2>
              Choose study intensity
            </h2>

            <p>
              Higher target retention
              schedules cards sooner and
              increases the review
              workload.
            </p>
          </div>

          <div
            className="study-intensity-options"
            role="radiogroup"
            aria-label="Study intensity"
          >
            {STUDY_INTENSITIES.map(
              (option) => (
                <label
                  className={
                    studyIntensity ===
                    option.value
                      ? 'study-intensity-option selected'
                      : 'study-intensity-option'
                  }
                  key={option.value}
                >
                  <input
                    type="radio"
                    name="study-intensity"
                    value={option.value}
                    checked={
                      studyIntensity ===
                      option.value
                    }
                    disabled={busy}
                    onChange={() =>
                      setStudyIntensity(
                        option.value,
                      )
                    }
                  />

                  <span>
                    <strong>
                      {option.label}
                    </strong>

                    <small>
                      {option.retention}
                      {' '}target retention
                    </small>
                  </span>

                  <p>
                    {
                      option.description
                    }
                  </p>
                </label>
              ),
            )}
          </div>

          <div className="deck-management-panel-actions">
            <button
              className="decks-primary-button"
              type="submit"
              disabled={busy}
            >
              {busy
                ? 'Saving…'
                : 'Save Study Settings'}
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setStudySettingsOpen(false)
                setStudyIntensity(
                  deck.study_intensity,
                )
                setManagementError('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {confirmingDelete && (
        <section
          className="deck-management-panel deck-delete-panel"
          aria-labelledby="delete-deck-heading"
        >
          <div>
            <span className="decks-eyebrow">
              DELETE DECK
            </span>

            <h2 id="delete-deck-heading">
              Delete “{deck.name}”?
            </h2>

            <p>
              This permanently deletes
              the deck, its cards, and
              their review history.
            </p>
          </div>

          <div className="deck-management-panel-actions">
            <button
              className="deck-delete-confirm"
              type="button"
              disabled={busy}
              onClick={() =>
                void handleDelete()
              }
            >
              {busy
                ? 'Deleting…'
                : 'Delete Permanently'}
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(false)
                setManagementError('')
              }}
            >
              Keep Deck
            </button>
          </div>
        </section>
      )}

      {managementError && (
        <p
          className="deck-management-error"
          role="alert"
        >
          {managementError}
        </p>
      )}

      {addingCard && (
        <CardEditor
          onCancel={() => {
            setAddingCard(false)
            setCardActionError('')
          }}
          onSave={handleAddCard}
        />
      )}

      {cardActionError && (
        <p
          className="deck-management-error"
          role="alert"
        >
          {cardActionError}
        </p>
      )}

      {deck.cards.length > 0 && (
        <section className="deck-card-filters">
          <label className="deck-card-search">
            <span>Search cards</span>

            <input
              type="search"
              value={cardSearch}
              placeholder="Question, answer, explanation, or tag"
              onChange={(event) =>
                setCardSearch(
                  event.target.value,
                )
              }
            />
          </label>

          <label className="deck-card-tag-filter">
            <span>Tag</span>

            <select
              value={selectedTag}
              onChange={(event) =>
                setSelectedTag(
                  event.target.value,
                )
              }
            >
              <option value="">
                All tags
              </option>

              {tagOptions.map(
                (tag) => (
                  <option
                    key={tag}
                    value={tag}
                  >
                    {tag}
                  </option>
                ),
              )}
            </select>
          </label>

          <div className="deck-card-filter-summary">
            <strong>
              {visibleCards.length}
            </strong>
            {' '}
            {visibleCards.length === 1
              ? 'card'
              : 'cards'}
            {filtersActive
              ? ' match'
              : ''}
          </div>

          {filtersActive && (
            <button
              className="deck-filter-clear"
              type="button"
              onClick={() => {
                setCardSearch('')
                setSelectedTag('')
              }}
            >
              Clear filters
            </button>
          )}
        </section>
      )}

      {deck.cards.length === 0 ? (
        <section className="decks-empty deck-detail-empty">
          <h2>
            This deck is empty
          </h2>

          <p>
            Save quiz questions into
            this deck to start studying.
          </p>

          <div className="deck-empty-actions">
            <button
              className="decks-primary-button"
              type="button"
              onClick={() => {
                setAddingCard(true)
                setCardActionError('')
              }}
            >
              + Add Card
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate('/')
              }
            >
              Generate a Quiz
            </button>
          </div>
        </section>
      ) : visibleCards.length === 0 ? (
        <section className="decks-empty deck-filter-empty">
          <h2>No matching cards</h2>

          <p>
            Try a different search
            or tag filter.
          </p>

          <button
            className="decks-secondary-button"
            type="button"
            onClick={() => {
              setCardSearch('')
              setSelectedTag('')
            }}
          >
            Clear filters
          </button>
        </section>
      ) : (
        <div className="deck-card-list">
          {visibleCards.map(
            (card, index) => (
              <article
                className={
                  card.suspended
                    ? 'deck-card-row deck-card-row-suspended'
                    : 'deck-card-row'
                }
                key={card.id}
              >
                <div className="deck-card-number">
                  {index + 1}
                </div>

                <div className="deck-card-content">
                  <div className="deck-card-topline">
                    <div className="deck-card-heading">
                    <span className="deck-card-type">
                      {
                        card.question_type
                          .replace(
                            /_/g,
                            ' ',
                          )
                      }
                    </span>

                    {card.source_pages &&
                      card.source_pages
                        .length > 0 && (
                        <span className="deck-card-pages">
                          Pages{' '}
                          {card.source_pages.join(
                            ', ',
                          )}
                        </span>
                      )}

                    {card.suspended && (
                      <span className="deck-card-suspended">
                        Suspended
                      </span>
                    )}
                    </div>

                    <div className="deck-card-actions">
                      <button
                        type="button"
                        disabled={cardActionBusy}
                        onClick={() => {
                          setEditingCardId(card.id)
                          setMovingCardId(null)
                          setMoveTargetDeckId('')
                          setAddingCard(false)
                          setConfirmingCardDelete(null)
                          setConfirmingProgressReset(null)
                          setCardActionError('')
                        }}
                      >
                        Edit
                      </button>

                      {availableDecks.some(
                        (item) =>
                          item.id !== deck.id,
                      ) && (
                        <button
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() => {
                            const fallback =
                              availableDecks.find(
                                (item) =>
                                  item.id !== deck.id,
                              )?.id ?? ''

                            setMovingCardId(
                              card.id,
                            )
                            setMoveTargetDeckId(
                              fallback,
                            )
                            setEditingCardId(null)
                            setConfirmingCardDelete(null)
                            setConfirmingProgressReset(null)
                            setAddingCard(false)
                            setCardActionError('')
                          }}
                        >
                          Move
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={cardActionBusy}
                        onClick={() => {
                          setEditingCardId(null)
                          setMovingCardId(null)
                          setMoveTargetDeckId('')
                          setConfirmingCardDelete(null)
                          setConfirmingProgressReset(null)
                          setAddingCard(false)
                          void handleSuspendCard(
                            card,
                          )
                        }}
                      >
                        {card.suspended
                          ? 'Resume'
                          : 'Suspend'}
                      </button>

                      {hasStudyProgress(
                        card,
                      ) && (
                        <button
                          className="deck-card-reset"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() => {
                            setConfirmingProgressReset(
                              card.id,
                            )
                            setEditingCardId(null)
                            setMovingCardId(null)
                            setMoveTargetDeckId('')
                            setConfirmingCardDelete(null)
                            setAddingCard(false)
                            setCardActionError('')
                          }}
                        >
                          Reset Progress
                        </button>
                      )}

                      <button
                        className="deck-card-delete"
                        type="button"
                        disabled={cardActionBusy}
                        onClick={() => {
                          setConfirmingCardDelete(
                            card.id,
                          )
                          setEditingCardId(null)
                          setMovingCardId(null)
                          setMoveTargetDeckId('')
                          setConfirmingProgressReset(null)
                          setAddingCard(false)
                          setCardActionError('')
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <h2>
                    {card.question}
                  </h2>

                  {card.tags &&
                    card.tags.length > 0 && (
                    <div className="deck-card-tags">
                      {card.tags.map(
                        (tag) => (
                          <button
                            type="button"
                            className="deck-card-tag"
                            key={tag}
                            onClick={() =>
                              setSelectedTag(
                                tag,
                              )
                            }
                          >
                            #{tag}
                          </button>
                        ),
                      )}
                    </div>
                  )}

                  <div className="deck-card-answer">
                    <span>
                      Answer
                    </span>

                    <strong>
                      {answerText(
                        card,
                      )}
                    </strong>
                  </div>

                  {card.choices &&
                    card.choices
                      .length > 0 && (
                      <div className="deck-card-choices">
                        {card.choices.map(
                          (
                            choice,
                            choiceIndex,
                          ) => (
                            <span
                              key={
                                choiceIndex
                              }
                            >
                              {choice}
                            </span>
                          ),
                        )}
                      </div>
                    )}

                  {card.explanation && (
                    <p className="deck-card-explanation">
                      {
                        card.explanation
                      }
                    </p>
                  )}

                  {card.source_filename && (
                    <span className="deck-card-source">
                      Source:{' '}
                      {
                        card.source_filename
                      }
                    </span>
                  )}

                  {movingCardId ===
                    card.id && (
                    <div className="deck-card-move-panel">
                      <div>
                        <span className="decks-eyebrow">
                          MOVE CARD
                        </span>

                        <p>
                          Review progress and history
                          stay with this card.
                        </p>
                      </div>

                      <label>
                        <span>
                          Destination deck
                        </span>

                        <select
                          value={moveTargetDeckId}
                          disabled={cardActionBusy}
                          onChange={(event) =>
                            setMoveTargetDeckId(
                              event.target.value,
                            )
                          }
                        >
                          {availableDecks
                            .filter(
                              (item) =>
                                item.id !==
                                deck.id,
                            )
                            .map(
                              (item) => (
                                <option
                                  key={item.id}
                                  value={item.id}
                                >
                                  {item.name}
                                </option>
                              ),
                            )}
                        </select>
                      </label>

                      <div className="deck-card-move-actions">
                        <button
                          className="decks-primary-button"
                          type="button"
                          disabled={
                            cardActionBusy ||
                            !moveTargetDeckId
                          }
                          onClick={() =>
                            void handleMoveCard(
                              card.id,
                            )
                          }
                        >
                          {cardActionBusy
                            ? 'Moving…'
                            : 'Move Card'}
                        </button>

                        <button
                          className="decks-secondary-button"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() => {
                            setMovingCardId(null)
                            setMoveTargetDeckId('')
                            setCardActionError('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {editingCardId ===
                    card.id && (
                    <CardEditor
                      card={card}
                      onCancel={() => {
                        setEditingCardId(null)
                        setCardActionError('')
                      }}
                      onSave={(payload) =>
                        handleEditCard(
                          card.id,
                          payload,
                        )
                      }
                    />
                  )}

                  {confirmingProgressReset ===
                    card.id && (
                    <div className="deck-card-reset-confirm">
                      <p>
                        Reset this card’s
                        spaced-repetition progress?
                        It will become due again
                        immediately. Previous review
                        history is retained.
                      </p>

                      <div>
                        <button
                          className="deck-reset-confirm"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() =>
                            void handleResetProgress(
                              card.id,
                            )
                          }
                        >
                          {cardActionBusy
                            ? 'Resetting…'
                            : 'Reset Progress'}
                        </button>

                        <button
                          className="decks-secondary-button"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() =>
                            setConfirmingProgressReset(
                              null,
                            )
                          }
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {confirmingCardDelete ===
                    card.id && (
                    <div className="deck-card-delete-confirm">
                      <p>
                        Delete this card?
                        Its review history
                        will also be removed.
                      </p>

                      <div>
                        <button
                          className="deck-delete-confirm"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() =>
                            void handleDeleteCard(
                              card.id,
                            )
                          }
                        >
                          {cardActionBusy
                            ? 'Deleting…'
                            : 'Delete Card'}
                        </button>

                        <button
                          className="decks-secondary-button"
                          type="button"
                          disabled={cardActionBusy}
                          onClick={() =>
                            setConfirmingCardDelete(
                              null,
                            )
                          }
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </>
  )
}

export default function DecksPage({
  pathname,
  onNavigate,
}: DecksPageProps) {
  const [decks, setDecks] =
    useState<DeckSummary[]>([])
  const [deck, setDeck] =
    useState<DeckDetail | null>(null)
  const [loading, setLoading] =
    useState(true)
  const [error, setError] =
    useState('')

  const reviewMatch =
    pathname.match(REVIEW_PATH)
  const reviewDeckId =
    reviewMatch?.[1] ?? null
  const learnMatch =
    pathname.match(LEARN_PATH)
  const learnDeckId =
    learnMatch?.[1] ?? null
  const cramMatch =
    pathname.match(CRAM_PATH)
  const cramDeckId =
    cramMatch?.[1] ?? null
  const weakMatch =
    pathname.match(WEAK_PATH)
  const weakDeckId =
    weakMatch?.[1] ?? null
  const recentMatch =
    pathname.match(RECENT_PATH)
  const recentDeckId =
    recentMatch?.[1] ?? null
  const aiPracticeMatch =
    pathname.match(
      AI_PRACTICE_PATH,
    )
  const aiPracticeDeckId =
    aiPracticeMatch?.[1] ?? null
  const examMatch =
    pathname.match(EXAM_PATH)
  const examDeckId =
    examMatch?.[1] ?? null
  const missedQuestions =
    pathname === '/decks/missed'
  const detailMatch =
    pathname.match(DECK_PATH)
  const deckId =
    detailMatch?.[1] ?? null
  const invalidPath =
    pathname !== '/decks' &&
    !missedQuestions &&
    !deckId &&
    !reviewDeckId &&
    !learnDeckId &&
    !cramDeckId &&
    !weakDeckId &&
    !recentDeckId &&
    !aiPracticeDeckId &&
    !examDeckId

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      setDeck(null)

      try {
        if (
          missedQuestions ||
          reviewDeckId ||
          learnDeckId ||
          cramDeckId ||
          weakDeckId ||
          recentDeckId ||
          aiPracticeDeckId ||
          examDeckId
        ) {
          return
        }

        if (invalidPath) {
          throw new Error(
            'This study deck link is invalid.',
          )
        }

        if (deckId) {
          const [
            nextDeck,
            nextDecks,
          ] = await Promise.all([
            getStudyDeck(
              deckId,
              apiFetch,
            ),
            listStudyDecks(
              apiFetch,
            ),
          ])

          if (active) {
            setDeck(nextDeck)
            setDecks(nextDecks)
          }
          return
        }

        const next =
          await listStudyDecks(
            apiFetch,
          )

        if (active) {
          setDecks(next)
        }
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load your study decks.',
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [
    aiPracticeDeckId,
    cramDeckId,
    examDeckId,
    deckId,
    invalidPath,
    missedQuestions,
    pathname,
    recentDeckId,
    reviewDeckId,
    learnDeckId,
    weakDeckId,
  ])

  const totalDue =
    decks.reduce(
      (total, item) =>
        total + item.due_count,
      0,
    )
  const totalCards =
    decks.reduce(
      (total, item) =>
        total + item.card_count,
      0,
    )
  const dueDecks =
    decks.filter(
      (item) =>
        item.due_count > 0,
    ).length

  return (
    <main className="decks-page">
      <div className="decks-shell">
        {missedQuestions ? (
          <MissedQuestionsPage
            onNavigate={onNavigate}
          />
        ) : reviewDeckId ? (
          <ReviewDeckPage
            deckId={reviewDeckId}
            onNavigate={onNavigate}
          />
        ) : learnDeckId ? (
          <ReviewDeckPage
            deckId={learnDeckId}
            onNavigate={onNavigate}
            mode="learn"
          />
        ) : cramDeckId ? (
          <CramDeckPage
            deckId={cramDeckId}
            onNavigate={onNavigate}
          />
        ) : weakDeckId ? (
          <WeakCardsPage
            deckId={weakDeckId}
            onNavigate={onNavigate}
          />
        ) : recentDeckId ? (
          <RecentlyAddedDeckPage
            deckId={recentDeckId}
            onNavigate={onNavigate}
          />
        ) : aiPracticeDeckId ? (
          <DeckAiPracticePage
            deckId={
              aiPracticeDeckId
            }
            onNavigate={onNavigate}
          />
        ) : examDeckId ? (
          <ExamPlanPage
            deckId={examDeckId}
            onNavigate={onNavigate}
          />
        ) : loading ? (
          <section
            className="decks-status"
            role="status"
          >
            <div
              className="decks-spinner"
              aria-hidden="true"
            />

            <span>
              Loading study decks…
            </span>
          </section>
        ) : error ? (
          <section className="decks-status">
            <h1>
              Could not open study decks
            </h1>

            <p role="alert">
              {error}
            </p>

            <div className="decks-status-actions">
              <button
                className="decks-secondary-button"
                type="button"
                onClick={() =>
                  onNavigate('/decks')
                }
              >
                My Decks
              </button>

              <button
                className="decks-primary-button"
                type="button"
                onClick={() =>
                  onNavigate('/')
                }
              >
                Back to Quiz
              </button>
            </div>
          </section>
        ) : deck ? (
          <DeckDetailView
            deck={deck}
            availableDecks={decks}
            onNavigate={onNavigate}
            onDeckUpdated={
              setDeck
            }
          />
        ) : (
          <>
            <header className="decks-header">
              <div>
                <span className="decks-eyebrow">
                  STUDY LIBRARY
                </span>

                <h1>
                  My Decks
                </h1>

                <p>
                  Keep generated questions
                  organized for review and
                  spaced repetition.
                </p>
              </div>

              <div className="decks-header-actions">
                <button
                  className="decks-secondary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      '/decks/missed',
                    )
                  }
                >
                  Missed Questions
                </button>

                <button
                  className="decks-primary-button"
                  type="button"
                  onClick={() =>
                    onNavigate('/')
                  }
                >
                  + Generate Quiz
                </button>
              </div>
            </header>

            {decks.length > 0 && (
              <section
                className="decks-overview"
                aria-label="Study review summary"
              >
                <div
                  className={
                    totalDue > 0
                      ? 'decks-overview-item decks-overview-due'
                      : 'decks-overview-item'
                  }
                >
                  <span>Due now</span>
                  <strong>
                    {totalDue}
                  </strong>
                  <small>
                    {totalDue > 0
                      ? `Across ${dueDecks} ${dueDecks === 1 ? 'deck' : 'decks'}`
                      : 'All caught up'}
                  </small>
                </div>

                <div className="decks-overview-item">
                  <span>Study decks</span>
                  <strong>
                    {decks.length}
                  </strong>
                  <small>
                    Saved collections
                  </small>
                </div>

                <div className="decks-overview-item">
                  <span>Saved cards</span>
                  <strong>
                    {totalCards}
                  </strong>
                  <small>
                    Ready for review
                  </small>
                </div>
              </section>
            )}

            <DeckList
              decks={decks}
              onNavigate={onNavigate}
            />
          </>
        )}
      </div>
    </main>
  )
}
