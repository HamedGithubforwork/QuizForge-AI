import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  buildWeakDeckAiFocus,
} from '../../lib/deckAiPractice'
import {
  deleteStudyDeck,
  duplicateStudyDeck,
  updateStudyDeck,
} from '../../lib/decks'
import type {
  DeckDetail,
  DeckSummary,
} from '../../types/api.generated'
import DeckCardManager from './DeckCardManager'

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

export default function DeckDetailView({
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

  useEffect(() => {
    setDeckName(deck.name)
    setStudyIntensity(
      deck.study_intensity,
    )
    setStudySettingsOpen(false)
    setEditing(false)
    setConfirmingDelete(false)
    setManagementError('')
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
                deck.due_count > 0
                  ? 'deck-detail-stat deck-detail-stat-due'
                  : 'deck-detail-stat deck-detail-stat-clear'
              }
            >
              <strong>
                {deck.due_count}
              </strong>

              <span>due now</span>
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
              {deck.due_count > 0
                ? `Review ${deck.due_count} Due`
                : 'Review Status'}
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

      <DeckCardManager
        deck={deck}
        availableDecks={availableDecks}
        onNavigate={onNavigate}
        onDeckUpdated={onDeckUpdated}
      />
    </>
  )
}

