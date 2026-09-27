import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  getStudyDeck,
  listStudyDecks,
} from '../../lib/decks'
import type {
  CardRow,
  DeckDetail,
  DeckSummary,
} from '../../types/api.generated'
import ReviewDeckPage from './ReviewDeckPage'
import './DecksPage.css'

type DecksPageProps = {
  pathname: string
  onNavigate: (path: string) => void
}

const DECK_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

const REVIEW_PATH =
  /^\/decks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/review$/i

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

              <span
                className={
                  deck.due_count > 0
                    ? 'deck-due-badge deck-due-badge-active'
                    : 'deck-due-badge'
                }
              >
                {deck.due_count > 0
                  ? `${deck.due_count} due`
                  : 'Caught up'}
              </span>
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
  onNavigate,
}: {
  deck: DeckDetail
  onNavigate: (path: string) => void
}) {
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

      {deck.cards.length === 0 ? (
        <section className="decks-empty deck-detail-empty">
          <h2>
            This deck is empty
          </h2>

          <p>
            Save quiz questions into
            this deck to start studying.
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
      ) : (
        <div className="deck-card-list">
          {deck.cards.map(
            (card, index) => (
              <article
                className="deck-card-row"
                key={card.id}
              >
                <div className="deck-card-number">
                  {index + 1}
                </div>

                <div className="deck-card-content">
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
                  </div>

                  <h2>
                    {card.question}
                  </h2>

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
  const detailMatch =
    pathname.match(DECK_PATH)
  const deckId =
    detailMatch?.[1] ?? null
  const invalidPath =
    pathname !== '/decks' &&
    !deckId &&
    !reviewDeckId

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      setDeck(null)

      try {
        if (reviewDeckId) {
          return
        }

        if (invalidPath) {
          throw new Error(
            'This study deck link is invalid.',
          )
        }

        if (deckId) {
          const next =
            await getStudyDeck(
              deckId,
              apiFetch,
            )

          if (active) {
            setDeck(next)
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
    deckId,
    invalidPath,
    pathname,
    reviewDeckId,
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
        {reviewDeckId ? (
          <ReviewDeckPage
            deckId={reviewDeckId}
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
            onNavigate={onNavigate}
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

              <button
                className="decks-primary-button"
                type="button"
                onClick={() =>
                  onNavigate('/')
                }
              >
                + Generate Quiz
              </button>
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
