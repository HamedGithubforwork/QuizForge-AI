import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  addCardsToStudyDeck,
  buildSelectedDeckCards,
  createStudyDeck,
  listStudyDecks,
} from '../../lib/decks'
import {
  apiFetch,
} from '../../lib/api'
import type {
  DeckSummary,
} from '../../types/api.generated'
import type {
  QuizResult,
  UploadResult,
} from '../../types/quiz'

type SaveDeckPanelProps = {
  quiz: QuizResult
  documentResult: UploadResult
}

type SaveMode =
  | 'create'
  | 'existing'

function allQuestionIndexes(
  quiz: QuizResult,
) {
  return quiz.questions.map(
    (_, index) => index,
  )
}

function SaveDeckPanel({
  quiz,
  documentResult,
}: SaveDeckPanelProps) {
  const [isOpen, setIsOpen] =
    useState(false)
  const [deckName, setDeckName] =
    useState(quiz.title)
  const [mode, setMode] =
    useState<SaveMode>('create')
  const [
    selectedIndexes,
    setSelectedIndexes,
  ] = useState<number[]>(
    () =>
      allQuestionIndexes(
        quiz,
      ),
  )
  const [
    existingDecks,
    setExistingDecks,
  ] = useState<DeckSummary[]>([])
  const [
    selectedDeckId,
    setSelectedDeckId,
  ] = useState('')
  const [
    isLoadingDecks,
    setIsLoadingDecks,
  ] = useState(false)
  const [isSaving, setIsSaving] =
    useState(false)
  const [saved, setSaved] =
    useState(false)
  const [message, setMessage] =
    useState('')
  const [hasError, setHasError] =
    useState(false)

  useEffect(() => {
    setIsOpen(false)
    setDeckName(quiz.title)
    setMode('create')
    setSelectedIndexes(
      allQuestionIndexes(
        quiz,
      ),
    )
    setExistingDecks([])
    setSelectedDeckId('')
    setIsLoadingDecks(false)
    setIsSaving(false)
    setSaved(false)
    setMessage('')
    setHasError(false)
  }, [
    quiz,
    documentResult.pdf_sha256,
  ])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    let active = true

    async function loadDecks() {
      setIsLoadingDecks(true)

      try {
        const decks =
          await listStudyDecks(
            apiFetch,
          )

        if (!active) {
          return
        }

        setExistingDecks(
          decks,
        )

        setSelectedDeckId(
          (current) =>
            decks.some(
              (deck) =>
                deck.id ===
                current,
            )
              ? current
              : decks[0]?.id ??
                '',
        )
      } catch {
        if (active) {
          setExistingDecks(
            [],
          )
        }
      } finally {
        if (active) {
          setIsLoadingDecks(
            false,
          )
        }
      }
    }

    void loadDecks()

    return () => {
      active = false
    }
  }, [isOpen])

  function toggleQuestion(
    index: number,
  ) {
    setSelectedIndexes(
      (current) =>
        current.includes(index)
          ? current.filter(
              (value) =>
                value !== index,
            )
          : [
              ...current,
              index,
            ].sort(
              (
                left,
                right,
              ) =>
                left - right,
            ),
    )
  }

  function resetAndClose() {
    setIsOpen(false)
    setMode('create')
    setDeckName(quiz.title)
    setSelectedIndexes(
      allQuestionIndexes(
        quiz,
      ),
    )
    setMessage('')
    setHasError(false)
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    setHasError(false)
    setMessage('')

    let cards

    try {
      cards =
        buildSelectedDeckCards(
          quiz,
          documentResult,
          selectedIndexes,
        )
    } catch (error) {
      setHasError(true)
      setMessage(
        error instanceof Error
          ? error.message
          : 'Choose at least one question to save.',
      )
      return
    }

    if (
      mode === 'create' &&
      !deckName.trim()
    ) {
      setHasError(true)
      setMessage(
        'Enter a name for this deck.',
      )
      return
    }

    if (
      mode === 'existing' &&
      !selectedDeckId
    ) {
      setHasError(true)
      setMessage(
        'Choose an existing deck.',
      )
      return
    }

    setIsSaving(true)

    try {
      const deck =
        mode === 'existing'
          ? await addCardsToStudyDeck(
              selectedDeckId,
              cards,
              apiFetch,
            )
          : await createStudyDeck(
              {
                name:
                  deckName.trim(),
                cards,
              },
              apiFetch,
            )

      setSaved(true)
      setIsOpen(false)
      setDeckName(deck.name)
      setMessage(
        mode === 'existing'
          ? `Added ${cards.length} ${cards.length === 1 ? 'card' : 'cards'} to "${deck.name}".`
          : `Saved "${deck.name}" with ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}.`,
      )
    } catch (error) {
      setHasError(true)
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not save these questions.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const allSelected =
    selectedIndexes.length ===
    quiz.questions.length

  return (
    <div className="study-deck-save">
      <div className="study-deck-copy">
        <div>
          <span className="eyebrow">
            Keep studying
          </span>

          <h3>
            Save quiz questions to a study deck
          </h3>

          <p>
            Choose the questions you
            want to keep, then create
            a deck or add them to one
            you already have.
          </p>
        </div>

        {!isOpen && (
          <button
            className="button secondary-button"
            type="button"
            onClick={() => {
              setIsOpen(true)
              setMessage('')
              setHasError(false)
            }}
          >
            {saved
              ? 'Save More Questions'
              : 'Save as Study Deck'}
          </button>
        )}
      </div>

      {isOpen && (
        <form
          className="study-deck-form"
          onSubmit={handleSubmit}
        >
          <div className="study-deck-mode-tabs">
            <button
              className={
                mode === 'create'
                  ? 'study-deck-mode active'
                  : 'study-deck-mode'
              }
              type="button"
              disabled={isSaving}
              onClick={() =>
                setMode('create')
              }
            >
              New deck
            </button>

            <button
              className={
                mode === 'existing'
                  ? 'study-deck-mode active'
                  : 'study-deck-mode'
              }
              type="button"
              disabled={
                isSaving ||
                isLoadingDecks ||
                existingDecks.length ===
                  0
              }
              onClick={() =>
                setMode(
                  'existing',
                )
              }
            >
              Existing deck
            </button>
          </div>

          {mode === 'create' ? (
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
                    event.target
                      .value,
                  )
                }}
              />
            </label>
          ) : (
            <label>
              <span>
                Add to deck
              </span>

              <select
                value={
                  selectedDeckId
                }
                disabled={
                  isSaving ||
                  isLoadingDecks
                }
                onChange={(event) =>
                  setSelectedDeckId(
                    event.target
                      .value,
                  )
                }
              >
                {existingDecks.map(
                  (deck) => (
                    <option
                      value={deck.id}
                      key={deck.id}
                    >
                      {deck.name} (
                      {
                        deck.card_count
                      }{' '}
                      {
                        deck.card_count ===
                        1
                          ? 'card'
                          : 'cards'
                      }
                      )
                    </option>
                  ),
                )}
              </select>
            </label>
          )}

          {existingDecks.length ===
            0 &&
            !isLoadingDecks && (
              <p className="study-deck-existing-note">
                No existing decks yet.
                Your first save will
                create one.
              </p>
            )}

          <fieldset className="study-deck-question-picker">
            <div className="study-deck-question-picker-heading">
              <div>
                <legend>
                  Questions to save
                </legend>

                <span>
                  {
                    selectedIndexes.length
                  }{' '}
                  of{' '}
                  {
                    quiz.questions
                      .length
                  }{' '}
                  selected
                </span>
              </div>

              <button
                className="study-deck-select-all"
                type="button"
                disabled={isSaving}
                onClick={() =>
                  setSelectedIndexes(
                    allSelected
                      ? []
                      : allQuestionIndexes(
                          quiz,
                        ),
                  )
                }
              >
                {allSelected
                  ? 'Clear all'
                  : 'Select all'}
              </button>
            </div>

            <div className="study-deck-question-list">
              {quiz.questions.map(
                (
                  question,
                  index,
                ) => {
                  const checked =
                    selectedIndexes.includes(
                      index,
                    )

                  return (
                    <label
                      className={
                        checked
                          ? 'study-deck-question selected'
                          : 'study-deck-question'
                      }
                      key={index}
                    >
                      <input
                        type="checkbox"
                        checked={
                          checked
                        }
                        disabled={
                          isSaving
                        }
                        onChange={() =>
                          toggleQuestion(
                            index,
                          )
                        }
                      />

                      <span className="study-deck-question-number">
                        {index + 1}
                      </span>

                      <span className="study-deck-question-text">
                        {
                          question.question
                        }
                      </span>
                    </label>
                  )
                },
              )}
            </div>
          </fieldset>

          <div className="study-deck-actions">
            <button
              className="button primary-button"
              type="submit"
              disabled={
                isSaving ||
                selectedIndexes.length ===
                  0 ||
                (mode ===
                  'create' &&
                  !deckName.trim()) ||
                (mode ===
                  'existing' &&
                  !selectedDeckId)
              }
            >
              {isSaving
                ? 'Saving...'
                : mode ===
                    'existing'
                  ? `Add ${selectedIndexes.length} to Deck`
                  : `Save ${selectedIndexes.length} as Deck`}
            </button>

            <button
              className="button ghost-button"
              type="button"
              disabled={isSaving}
              onClick={
                resetAndClose
              }
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && (
        <p
          className={
            hasError
              ? 'study-deck-message study-deck-error'
              : 'study-deck-message'
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
