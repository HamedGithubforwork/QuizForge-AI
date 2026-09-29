import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  getStudyDeck,
  updateStudyDeck,
} from '../../lib/decks'
import {
  buildExamPlan,
  type ExamIntensity,
} from '../../lib/examPlanning'
import type {
  DeckDetail,
} from '../../types/api.generated'

type ExamPlanPageProps = {
  deckId: string
  onNavigate: (path: string) => void
}

function formatExamDate(
  value: string,
) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/
      .exec(value)

  if (!match) {
    return value
  }

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )

  return new Intl.DateTimeFormat(
    undefined,
    {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    },
  ).format(date)
}

function intensityLabel(
  value: ExamIntensity,
) {
  if (value === 'relaxed') {
    return 'Relaxed'
  }

  if (value === 'balanced') {
    return 'Balanced'
  }

  return 'Intensive'
}

function intensityCopy(
  value: ExamIntensity,
) {
  if (value === 'relaxed') {
    return 'Build coverage steadily and leave time for consolidation.'
  }

  if (value === 'balanced') {
    return 'Keep new material moving while giving weak cards extra attention.'
  }

  return 'Prioritize required coverage and weak material as the exam approaches.'
}

export default function ExamPlanPage({
  deckId,
  onNavigate,
}: ExamPlanPageProps) {
  const [deck, setDeck] =
    useState<DeckDetail | null>(
      null,
    )
  const [examDate, setExamDate] =
    useState('')
  const [loading, setLoading] =
    useState(true)
  const [saving, setSaving] =
    useState(false)
  const [error, setError] =
    useState('')
  const [message, setMessage] =
    useState('')

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const next =
          await getStudyDeck(
            deckId,
            apiFetch,
          )

        if (!active) {
          return
        }

        setDeck(next)
        setExamDate(
          next.exam_date ?? '',
        )
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load the exam plan.',
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

  const plan = useMemo(
    () =>
      deck
        ? buildExamPlan(
            deck,
          )
        : null,
    [deck],
  )

  async function saveDate(
    event: FormEvent,
  ) {
    event.preventDefault()

    if (!deck || !examDate) {
      return
    }

    setSaving(true)
    setError('')
    setMessage('')

    try {
      const updated =
        await updateStudyDeck(
          deck.id,
          {
            exam_date:
              examDate,
          },
          apiFetch,
        )

      setDeck(updated)
      setExamDate(
        updated.exam_date ??
          examDate,
      )
      setMessage(
        'Exam date saved. Your workload plan has been recalculated.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save the exam date.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function clearDate() {
    if (!deck) {
      return
    }

    setSaving(true)
    setError('')
    setMessage('')

    try {
      const updated =
        await updateStudyDeck(
          deck.id,
          {
            exam_date: null,
          },
          apiFetch,
        )

      setDeck(updated)
      setExamDate('')
      setMessage(
        'Exam date removed.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not remove the exam date.',
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
          Building exam plan…
        </span>
      </section>
    )
  }

  if (!deck) {
    return (
      <section className="review-session-status">
        <h1>
          Could not open exam plan
        </h1>

        <p role="alert">
          {error ||
            'This deck is unavailable.'}
        </p>

        <button
          className="decks-secondary-button"
          type="button"
          onClick={() =>
            onNavigate('/decks')
          }
        >
          My Decks
        </button>
      </section>
    )
  }

  return (
    <>
      <button
        className="decks-back"
        type="button"
        disabled={saving}
        onClick={() =>
          onNavigate(
            `/decks/${deck.id}`,
          )
        }
      >
        ← {deck.name}
      </button>

      <section className="exam-plan">
        <header className="exam-plan-heading">
          <div>
            <span className="decks-eyebrow">
              EXAM MODE
            </span>

            <h1>
              Plan toward your exam
            </h1>

            <p>
              Quiz From Notes uses your
              live deck state to balance
              new material, due reviews,
              and weak cards as the exam
              approaches.
            </p>
          </div>

          {plan && (
            <div className="exam-countdown">
              <strong>
                {Math.max(
                  0,
                  plan.daysRemaining,
                )}
              </strong>

              <span>
                {plan.daysRemaining ===
                1
                  ? 'day left'
                  : 'days left'}
              </span>
            </div>
          )}
        </header>

        <form
          className="exam-date-card"
          onSubmit={saveDate}
        >
          <div>
            <span className="decks-eyebrow">
              EXAM DATE
            </span>

            <h2>
              {deck.exam_date
                ? formatExamDate(
                    deck.exam_date,
                  )
                : 'Choose an exam date'}
            </h2>

            <p>
              The plan updates from the
              current deck every time you
              open it.
            </p>
          </div>

          <div className="exam-date-controls">
            <input
              type="date"
              value={examDate}
              disabled={saving}
              required
              aria-label="Exam date"
              onChange={(event) =>
                setExamDate(
                  event.target.value,
                )
              }
            />

            <button
              className="decks-primary-button"
              type="submit"
              disabled={
                saving ||
                !examDate
              }
            >
              {saving
                ? 'Saving…'
                : deck.exam_date
                  ? 'Update Date'
                  : 'Set Exam Date'}
            </button>

            {deck.exam_date && (
              <button
                className="decks-secondary-button"
                type="button"
                disabled={saving}
                onClick={() =>
                  void clearDate()
                }
              >
                Remove
              </button>
            )}
          </div>
        </form>

        {error && (
          <div
            className="deck-management-error"
            role="alert"
          >
            {error}
          </div>
        )}

        {message && (
          <div
            className="exam-plan-message"
            role="status"
          >
            {message}
          </div>
        )}

        {!plan ? (
          <section className="exam-plan-empty">
            <h2>
              Set a date to build your plan
            </h2>

            <p>
              We’ll calculate days
              remaining, new material,
              due reviews, weak concepts,
              and a manageable daily
              target.
            </p>
          </section>
        ) : plan.daysRemaining < 0 ? (
          <section className="exam-plan-empty">
            <h2>
              This exam date has passed
            </h2>

            <p>
              Choose a new exam date to
              receive a current workload
              recommendation.
            </p>
          </section>
        ) : (
          <>
            <section className="exam-plan-summary">
              <article>
                <span>
                  Material remaining
                </span>

                <strong>
                  {plan.newCardCount}
                </strong>

                <small>
                  New cards not yet
                  reviewed
                </small>
              </article>

              <article>
                <span>
                  Reviews due
                </span>

                <strong>
                  {plan.reviewDueCount}
                </strong>

                <small>
                  Previously studied cards
                  due now
                </small>
              </article>

              <article>
                <span>
                  Weak cards
                </span>

                <strong>
                  {plan.weakCardCount}
                </strong>

                <small>
                  Lapses or high FSRS
                  difficulty
                </small>
              </article>

              <article
                className={
                  `exam-intensity exam-intensity-${plan.intensity}`
                }
              >
                <span>
                  Study intensity
                </span>

                <strong>
                  {intensityLabel(
                    plan.intensity,
                  )}
                </strong>

                <small>
                  {intensityCopy(
                    plan.intensity,
                  )}
                </small>
              </article>
            </section>

            <section className="exam-today-card">
              <div>
                <span className="decks-eyebrow">
                  TODAY’S TARGET
                </span>

                <h2>
                  {plan.recommendedTotalToday}{' '}
                  cards
                </h2>

                <p>
                  Complete today’s due
                  work, keep new material
                  moving, and add weak-card
                  practice when useful.
                </p>
              </div>

              <div className="exam-workload-grid">
                <div>
                  <strong>
                    {
                      plan.recommendedReviewCardsToday
                    }
                  </strong>

                  <span>
                    review / weak
                  </span>
                </div>

                <div>
                  <strong>
                    {
                      plan.recommendedNewCardsToday
                    }
                  </strong>

                  <span>
                    new cards
                  </span>
                </div>
              </div>
            </section>

            {plan.workloadCapped && (
              <div className="exam-workload-warning">
                The pace required to
                finish every new card
                exceeds the planner’s
                daily safety cap. The
                uncapped pace is{' '}
                <strong>
                  {
                    plan.requiredNewCardsPerDay
                  }{' '}
                  new cards/day
                </strong>
                . Consider moving the exam
                date, reducing material,
                or prioritizing the most
                important cards.
              </div>
            )}

            {plan.weakTags.length >
              0 && (
              <section className="exam-weak-concepts">
                <div>
                  <span className="decks-eyebrow">
                    WEAK CONCEPTS
                  </span>

                  <h2>
                    Topics needing extra
                    attention
                  </h2>
                </div>

                <div className="exam-weak-tags">
                  {plan.weakTags.map(
                    (item) => (
                      <span
                        key={
                          item.tag
                        }
                      >
                        #{item.tag}
                        <strong>
                          {
                            item.count
                          }
                        </strong>
                      </span>
                    ),
                  )}
                </div>
              </section>
            )}

            <section className="exam-plan-actions">
              {plan.reviewDueCount >
                0 && (
                <button
                  className="decks-primary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/decks/${deck.id}/review`,
                    )
                  }
                >
                  Review Due Cards
                </button>
              )}

              {plan.newCardCount >
                0 && (
                <button
                  className="decks-secondary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/decks/${deck.id}/recent`,
                    )
                  }
                >
                  Study New Cards
                </button>
              )}

              {plan.weakCardCount >
                0 && (
                <button
                  className="decks-secondary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/decks/${deck.id}/weak`,
                    )
                  }
                >
                  Review Weak Cards
                </button>
              )}
            </section>
          </>
        )}
      </section>
    </>
  )
}
