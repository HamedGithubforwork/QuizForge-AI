import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  getStudyDeck,
} from '../../lib/decks'
import {
  cramStudyCards,
} from '../../lib/studyModes'
import type {
  CardRow,
} from '../../types/api.generated'

type CramDeckPageProps = {
  deckId: string
  onNavigate: (path: string) => void
}

function correctAnswer(
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

function correctChoiceIndex(
  card: CardRow,
) {
  const answer = card.answer

  if (
    answer &&
    typeof answer === 'object' &&
    'correct_index' in answer &&
    typeof answer.correct_index ===
      'number'
  ) {
    return answer.correct_index
  }

  return -1
}

export default function CramDeckPage({
  deckId,
  onNavigate,
}: CramDeckPageProps) {
  const [deckName, setDeckName] =
    useState('Study Deck')
  const [cards, setCards] =
    useState<CardRow[]>([])
  const [totalCardCount, setTotalCardCount] =
    useState(0)
  const [index, setIndex] =
    useState(0)
  const [revealed, setRevealed] =
    useState(false)
  const [loading, setLoading] =
    useState(true)
  const [error, setError] =
    useState('')

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const deck =
          await getStudyDeck(
            deckId,
            apiFetch,
          )

        if (!active) {
          return
        }

        setDeckName(deck.name)
        setTotalCardCount(
          deck.card_count,
        )
        setCards(
          cramStudyCards(
            deck.cards,
          ),
        )
        setIndex(0)
        setRevealed(false)
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not start this cram session.',
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
  }, [deckId])

  const current =
    cards[index] ?? null
  const completed =
    cards.length > 0 &&
    index >= cards.length

  if (loading) {
    return (
      <section
        className="review-session-status"
        role="status"
      >
        <div
          className="decks-spinner"
          aria-hidden="true"
        />

        <span>
          Preparing cram session…
        </span>
      </section>
    )
  }

  if (error) {
    return (
      <section className="review-session-status">
        <h1>
          Could not start cram mode
        </h1>

        <p role="alert">
          {error}
        </p>

        <button
          className="decks-secondary-button"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          Back to Deck
        </button>
      </section>
    )
  }

  if (completed) {
    return (
      <>
        <button
          className="decks-back"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          ← {deckName}
        </button>

        <section className="review-complete">
          <div
            className="review-complete-mark"
            aria-hidden="true"
          >
            ✓
          </div>

          <span className="decks-eyebrow">
            CRAM COMPLETE
          </span>

          <h1>
            You studied all active cards
          </h1>

          <p>
            You reviewed{' '}
            <strong>
              {cards.length}
            </strong>
            {' '}
            {cards.length === 1
              ? 'card'
              : 'cards'}.
          </p>

          <p className="cram-schedule-note">
            Your normal FSRS due dates,
            review counts, and history
            were not changed.
          </p>

          <div className="review-complete-actions">
            <button
              className="decks-primary-button"
              type="button"
              onClick={() => {
                setIndex(0)
                setRevealed(false)
              }}
            >
              Cram Again
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deckId}`,
                )
              }
            >
              Back to Deck
            </button>
          </div>
        </section>
      </>
    )
  }

  if (!current) {
    const allSuspended =
      totalCardCount > 0

    return (
      <>
        <button
          className="decks-back"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          ← {deckName}
        </button>

        <section className="review-complete">
          <span className="decks-eyebrow">
            CRAM MODE
          </span>

          <h1>
            {allSuspended
              ? 'No active cards to cram'
              : 'This deck is empty'}
          </h1>

          <p>
            {allSuspended
              ? 'All cards in this deck are suspended. Resume at least one card to study it.'
              : 'Add cards to this deck before starting a cram session.'}
          </p>

          <button
            className="decks-secondary-button"
            type="button"
            onClick={() =>
              onNavigate(
                `/decks/${deckId}`,
              )
            }
          >
            Back to Deck
          </button>
        </section>
      </>
    )
  }

  const answer =
    correctAnswer(current)
  const correctIndex =
    correctChoiceIndex(current)

  return (
    <>
      <div className="review-session-topbar">
        <button
          className="decks-back"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          ← Exit Cram
        </button>

        <div className="cram-session-meta">
          <span className="cram-mode-badge">
            Cram · schedule unchanged
          </span>

          <span className="review-session-count">
            <strong>
              {index + 1}
            </strong>
            {' '}of {cards.length}
          </span>
        </div>
      </div>

      <section className="review-card">
        <header className="review-card-header">
          <div>
            <span className="decks-eyebrow">
              {deckName}
            </span>

            <span className="review-question-type">
              {
                current.question_type
                  .replace(/_/g, ' ')
              }
            </span>
          </div>

          {current.source_pages &&
            current.source_pages
              .length > 0 && (
              <span className="deck-card-pages">
                Pages{' '}
                {current.source_pages.join(
                  ', ',
                )}
              </span>
            )}
        </header>

        <div className="review-question">
          <h1>
            {current.question}
          </h1>

          {current.tags &&
            current.tags.length > 0 && (
            <div className="review-card-tags">
              {current.tags.map(
                (tag) => (
                  <span
                    className="deck-card-tag"
                    key={tag}
                  >
                    #{tag}
                  </span>
                ),
              )}
            </div>
          )}

          {current.choices &&
            current.choices.length >
              0 && (
              <div className="review-choices">
                {current.choices.map(
                  (
                    choice,
                    choiceIndex,
                  ) => (
                    <div
                      className={
                        revealed &&
                        choiceIndex ===
                          correctIndex
                          ? 'review-choice review-choice-correct'
                          : 'review-choice'
                      }
                      key={choiceIndex}
                    >
                      <span>
                        {String.fromCharCode(
                          65 + choiceIndex,
                        )}
                      </span>

                      {choice}
                    </div>
                  ),
                )}
              </div>
            )}
        </div>

        {!revealed ? (
          <button
            className="review-show-answer"
            type="button"
            onClick={() =>
              setRevealed(true)
            }
          >
            Show Answer
          </button>
        ) : (
          <>
            <div className="review-answer">
              <span>
                Answer
              </span>

              <strong>
                {answer}
              </strong>

              {current.explanation && (
                <p>
                  {
                    current.explanation
                  }
                </p>
              )}
            </div>

            <button
              className="cram-next-button"
              type="button"
              onClick={() => {
                setIndex(
                  (value) =>
                    value + 1,
                )
                setRevealed(false)
              }}
            >
              {index + 1 >=
              cards.length
                ? 'Finish Cram'
                : 'Next Card →'}
            </button>
          </>
        )}
      </section>
    </>
  )
}
