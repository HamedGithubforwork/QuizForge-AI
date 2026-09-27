import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  buildDeckCreatePayload,
  createStudyDeck,
} from '../../lib/decks'
import {
  apiFetch,
} from '../../lib/api'
import type {
  QuizResult,
  UploadResult,
} from '../../types/quiz'

type SaveDeckPanelProps = {
  quiz: QuizResult
  documentResult: UploadResult
}

function SaveDeckPanel({
  quiz,
  documentResult,
}: SaveDeckPanelProps) {
  const [isOpen, setIsOpen] =
    useState(false)
  const [deckName, setDeckName] =
    useState(quiz.title)
  const [isSaving, setIsSaving] =
    useState(false)
  const [saved, setSaved] =
    useState(false)
  const [message, setMessage] =
    useState('')

  useEffect(() => {
    setIsOpen(false)
    setDeckName(quiz.title)
    setIsSaving(false)
    setSaved(false)
    setMessage('')
  }, [
    quiz.title,
    documentResult.pdf_sha256,
  ])

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const cleanName =
      deckName.trim()

    if (!cleanName) {
      setMessage(
        'Enter a name for this deck.',
      )
      return
    }

    setIsSaving(true)
    setMessage('')

    try {
      const deck =
        await createStudyDeck(
          buildDeckCreatePayload(
            cleanName,
            quiz,
            documentResult,
          ),
          apiFetch,
        )

      setSaved(true)
      setIsOpen(false)
      setDeckName(deck.name)
      setMessage(
        `Saved "${deck.name}" with ${deck.card_count} ${deck.card_count === 1 ? 'card' : 'cards'}.`,
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not save this study deck.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="study-deck-save">
      <div className="study-deck-copy">
        <div>
          <span className="eyebrow">
            Keep studying
          </span>

          <h3>
            Save this quiz as a study deck
          </h3>

          <p>
            Keep all{' '}
            {quiz.questions.length}{' '}
            questions and their source
            pages for future review.
          </p>
        </div>

        {!isOpen && (
          <button
            className="button secondary-button"
            type="button"
            disabled={saved}
            onClick={() => {
              setIsOpen(true)
              setMessage('')
            }}
          >
            {saved
              ? 'Deck Saved ✓'
              : 'Save as Study Deck'}
          </button>
        )}
      </div>

      {isOpen && (
        <form
          className="study-deck-form"
          onSubmit={handleSubmit}
        >
          <label>
            <span>Deck name</span>

            <input
              type="text"
              value={deckName}
              maxLength={200}
              autoFocus
              disabled={isSaving}
              onChange={(event) => {
                setDeckName(
                  event.target.value,
                )
              }}
            />
          </label>

          <div className="study-deck-actions">
            <button
              className="button primary-button"
              type="submit"
              disabled={
                isSaving ||
                !deckName.trim()
              }
            >
              {isSaving
                ? 'Saving Deck...'
                : 'Save Deck'}
            </button>

            <button
              className="button ghost-button"
              type="button"
              disabled={isSaving}
              onClick={() => {
                setIsOpen(false)
                setDeckName(quiz.title)
                setMessage('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && (
        <p
          className={
            saved
              ? 'study-deck-message'
              : 'study-deck-message study-deck-error'
          }
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      )}
    </div>
  )
}

export default SaveDeckPanel
