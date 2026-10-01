import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  deckTagOptions,
  filterStudyCards,
} from '../../lib/cardTags'
import {
  addCardsToStudyDeck,
  deleteStudyCard,
  getStudyDeck,
  moveStudyCard,
  resetStudyCardProgress,
  resumeStudyCard,
  suspendStudyCard,
  updateStudyCard,
} from '../../lib/decks'
import type {
  CardCreate,
  CardRow,
  DeckDetail,
  DeckSummary,
} from '../../types/api.generated'
import CardEditor from './CardEditor'

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


export default function DeckCardManager({
  deck,
  availableDecks,
  onNavigate,
  onDeckUpdated,
}: {
  deck: DeckDetail
  availableDecks: DeckSummary[]
  onNavigate: (path: string) => void
  onDeckUpdated: (deck: DeckDetail) => void
}) {
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
  return (
    <>
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
