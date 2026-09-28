import {
  useCallback,
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  getReviewQueue,
  submitReview,
} from '../../lib/decks'
import type {
  CardRow,
} from '../../types/api.generated'

type ReviewDeckPageProps = {
  deckId: string
  onNavigate: (path: string) => void
}

type RatingValue = 1 | 2 | 3 | 4

const RATINGS: Array<{
  value: RatingValue
  label: string
  hint: string
  className: string
}> = [
  {
    value: 1,
    label: 'Again',
    hint: 'Forgot',
    className: 'review-rating-again',
  },
  {
    value: 2,
    label: 'Hard',
    hint: 'Difficult',
    className: 'review-rating-hard',
  },
  {
    value: 3,
    label: 'Good',
    hint: 'Got it',
    className: 'review-rating-good',
  },
  {
    value: 4,
    label: 'Easy',
    hint: 'Easy recall',
    className: 'review-rating-easy',
  },
]

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

function formatNextDue(
  value: string | null,
) {
  if (!value) {
    return null
  }

  const due = new Date(value)

  if (
    Number.isNaN(due.getTime())
  ) {
    return null
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ).format(due)
}

export default function ReviewDeckPage({
  deckId,
  onNavigate,
}: ReviewDeckPageProps) {
  const [deckName, setDeckName] =
    useState('Study Deck')
  const [cards, setCards] =
    useState<CardRow[]>([])
  const [dueCount, setDueCount] =
    useState(0)
  const [nextDueAt, setNextDueAt] =
    useState<string | null>(null)
  const [loading, setLoading] =
    useState(true)
  const [saving, setSaving] =
    useState(false)
  const [revealed, setRevealed] =
    useState(false)
  const [error, setError] =
    useState('')
  const [startedAt, setStartedAt] =
    useState(() => Date.now())

  const loadQueue = useCallback(
    async (
      showLoading = true,
    ) => {
      if (showLoading) {
        setLoading(true)
      }
      setError('')

      try {
        const queue =
          await getReviewQueue(
            deckId,
            apiFetch,
            50,
          )

        setDeckName(
          queue.deck_name,
        )
        setCards(queue.cards)
        setDueCount(
          queue.due_count,
        )
        setNextDueAt(
          queue.next_due_at,
        )
        setRevealed(false)
        setStartedAt(Date.now())
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load this review session.',
        )
      } finally {
        if (showLoading) {
          setLoading(false)
        }
      }
    },
    [deckId],
  )

  useEffect(() => {
    void loadQueue()

    return () => {
      setCards([])
    }
  }, [loadQueue])

  const current = cards[0] ?? null

  async function handleRating(
    rating: RatingValue,
  ) {
    if (
      !current ||
      !revealed ||
      saving
    ) {
      return
    }

    setSaving(true)
    setError('')

    try {
      const duration =
        Math.min(
          86_400_000,
          Math.max(
            0,
            Date.now() - startedAt,
          ),
        )

      const result =
        await submitReview(
          deckId,
          {
            card_id: current.id,
            rating,
            review_duration_ms:
              duration,
          },
          apiFetch,
        )

      const remainingLocal =
        cards.slice(1)

      setDueCount(
        result.remaining_due_count,
      )
      setNextDueAt(
        result.next_due_at,
      )

      if (
        remainingLocal.length > 0
      ) {
        setCards(
          remainingLocal,
        )
        setRevealed(false)
        setStartedAt(Date.now())
      } else if (
        result.remaining_due_count > 0
      ) {
        await loadQueue(false)
      } else {
        setCards([])
        setRevealed(false)
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save this review.',
      )
    } finally {
      setSaving(false)
    }
  }

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
          Preparing review…
        </span>
      </section>
    )
  }

  if (error && !current) {
    return (
      <section className="review-session-status">
        <h1>
          Could not start review
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

  if (!current) {
    const nextDue =
      formatNextDue(
        nextDueAt,
      )

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
            REVIEW COMPLETE
          </span>

          <h1>
            You’re caught up
          </h1>

          <p>
            No cards in this deck
            are due right now.
          </p>

          {nextDue && (
            <p className="review-next-due">
              Next review:{' '}
              <strong>
                {nextDue}
              </strong>
            </p>
          )}

          <div className="review-complete-actions">
            <button
              className="decks-primary-button"
              type="button"
              onClick={() =>
                onNavigate(
                  `/decks/${deckId}`,
                )
              }
            >
              Back to Deck
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate('/decks')
              }
            >
              My Decks
            </button>
          </div>
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
          disabled={saving}
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          ← Exit Review
        </button>

        <div className="review-session-count">
          <strong>
            {dueCount}
          </strong>
          {' '}due
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
                    index,
                  ) => (
                    <div
                      className={
                        revealed &&
                        index ===
                          correctIndex
                          ? 'review-choice review-choice-correct'
                          : 'review-choice'
                      }
                      key={index}
                    >
                      <span>
                        {String.fromCharCode(
                          65 + index,
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

            <div className="review-rating-copy">
              How well did you
              remember it?
            </div>

            <div className="review-ratings">
              {RATINGS.map(
                (rating) => (
                  <button
                    className={
                      `review-rating ${rating.className}`
                    }
                    type="button"
                    key={
                      rating.value
                    }
                    disabled={saving}
                    onClick={() =>
                      void handleRating(
                        rating.value,
                      )
                    }
                  >
                    <strong>
                      {rating.label}
                    </strong>

                    <span>
                      {rating.hint}
                    </span>
                  </button>
                ),
              )}
            </div>
          </>
        )}

        {error && (
          <p
            className="review-error"
            role="alert"
          >
            {error}
          </p>
        )}
      </section>
    </>
  )
}
