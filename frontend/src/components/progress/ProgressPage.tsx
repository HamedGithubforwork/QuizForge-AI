import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  detectedAnalyticsTimezone,
  formatRetention,
  formatStudyDuration,
  getStudyAnalytics,
  ratingPercent,
} from '../../lib/studyAnalytics'
import type {
  DifficultCard,
  StudyAnalyticsSummary,
} from '../../types/api.generated'
import './ProgressPage.css'

type ProgressPageProps = {
  onNavigate: (path: string) => void
}

function MetricCard({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string
  value: string | number
  detail: string
  emphasis?: boolean
}) {
  return (
    <article
      className={
        emphasis
          ? 'progress-metric progress-metric-emphasis'
          : 'progress-metric'
      }
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function MemoryItem({
  label,
  value,
  detail,
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <div className="progress-memory-item">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function RatingRow({
  label,
  value,
  total,
  className,
}: {
  label: string
  value: number
  total: number
  className: string
}) {
  const percent =
    ratingPercent(
      value,
      total,
    )

  return (
    <div className="progress-rating-row">
      <div className="progress-rating-label">
        <span>{label}</span>

        <strong>
          {value}{' '}
          <small>
            ({percent}%)
          </small>
        </strong>
      </div>

      <div
        className="progress-rating-track"
        aria-hidden="true"
      >
        <span
          className={
            'progress-rating-fill '
            + className
          }
          style={{
            width:
              `${percent}%`,
          }}
        />
      </div>
    </div>
  )
}

function DifficultCardRow({
  card,
  onNavigate,
}: {
  card: DifficultCard
  onNavigate: (path: string) => void
}) {
  return (
    <article className="progress-difficult-card">
      <div className="progress-difficult-copy">
        <div className="progress-difficult-meta">
          <span>
            {card.deck_name}
          </span>

          {card.tags &&
            card.tags.length > 0 && (
              <span>
                {card.tags
                  .slice(0, 3)
                  .join(' · ')}
              </span>
            )}
        </div>

        <h3>
          {card.question}
        </h3>

        <div className="progress-difficult-stats">
          <span>
            {card.lapse_count}{' '}
            {card.lapse_count === 1
              ? 'lapse'
              : 'lapses'}
          </span>

          <span>
            {card.review_count}{' '}
            {card.review_count === 1
              ? 'review'
              : 'reviews'}
          </span>

          {card.difficulty !==
            null && (
            <span>
              Difficulty{' '}
              {card.difficulty
                .toFixed(1)}
              /10
            </span>
          )}
        </div>
      </div>

      <button
        className="progress-secondary-button"
        type="button"
        onClick={() =>
          onNavigate(
            `/decks/${card.deck_id}`,
          )
        }
      >
        Open Deck
      </button>
    </article>
  )
}

export default function ProgressPage({
  onNavigate,
}: ProgressPageProps) {
  const [summary, setSummary] =
    useState<StudyAnalyticsSummary | null>(
      null,
    )
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
        const next =
          await getStudyAnalytics(
            detectedAnalyticsTimezone(),
            apiFetch,
          )

        if (active) {
          setSummary(next)
        }
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load study progress.',
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
  }, [])

  if (loading) {
    return (
      <main className="progress-page">
        <section
          className="progress-status"
          role="status"
        >
          <div
            className="progress-spinner"
            aria-hidden="true"
          />

          <span>
            Loading study progress…
          </span>
        </section>
      </main>
    )
  }

  if (
    error ||
    !summary
  ) {
    return (
      <main className="progress-page">
        <section className="progress-status">
          <h1>
            Could not load progress
          </h1>

          <p role="alert">
            {error ||
              'Study progress is unavailable.'}
          </p>

          <button
            className="progress-primary-button"
            type="button"
            onClick={() =>
              onNavigate('/decks')
            }
          >
            My Decks
          </button>
        </section>
      </main>
    )
  }

  const {
    activity,
    memory,
    ratings_last_30_days:
      ratings,
  } = summary
  const hasStudyData =
    memory.total_cards > 0 ||
    ratings.total > 0

  return (
    <main className="progress-page">
      <div className="progress-shell">
        <header className="progress-header">
          <div>
            <span className="progress-eyebrow">
              STUDY PROGRESS
            </span>

            <h1>
              Your learning at a glance
            </h1>

            <p>
              Review activity, FSRS memory
              strength, and the cards that
              need the most attention.
            </p>
          </div>

          <button
            className="progress-primary-button"
            type="button"
            onClick={() =>
              onNavigate('/decks')
            }
          >
            Start Review
          </button>
        </header>

        {!hasStudyData ? (
          <section className="progress-empty">
            <div
              className="progress-empty-icon"
              aria-hidden="true"
            >
              ◫
            </div>

            <h2>
              Your progress starts
              with a study deck
            </h2>

            <p>
              Save generated quiz
              questions into a deck,
              then review them to build
              your learning history.
            </p>

            <button
              className="progress-primary-button"
              type="button"
              onClick={() =>
                onNavigate('/')
              }
            >
              Generate a Quiz
            </button>
          </section>
        ) : (
          <>
            <section className="progress-metric-grid">
              <MetricCard
                label="Reviews today"
                value={
                  activity
                    .reviews_today
                }
                detail={
                  `${activity.active_days_last_7_days}/7 active days`
                }
                emphasis={
                  activity
                    .reviews_today > 0
                }
              />

              <MetricCard
                label="Last 7 days"
                value={
                  activity
                    .reviews_last_7_days
                }
                detail="Completed card reviews"
              />

              <MetricCard
                label="Study time"
                value={
                  formatStudyDuration(
                    activity
                      .study_time_last_7_days_ms,
                  )
                }
                detail={
                  `${formatStudyDuration(activity.study_time_today_ms)} today`
                }
              />

              <MetricCard
                label="Estimated retention"
                value={
                  formatRetention(
                    memory
                      .estimated_retention,
                  )
                }
                detail={
                  memory
                    .retention_card_count > 0
                    ? `Across ${memory.retention_card_count} reviewed cards`
                    : 'Review cards to estimate'
                }
                emphasis={
                  memory
                    .estimated_retention !==
                  null
                }
              />
            </section>

            <div className="progress-two-column">
              <section className="progress-panel">
                <div className="progress-panel-heading">
                  <div>
                    <span className="progress-eyebrow">
                      MEMORY
                    </span>

                    <h2>
                      Card state
                    </h2>
                  </div>

                  <span className="progress-panel-total">
                    {memory.active_cards}
                    {' '}active
                  </span>
                </div>

                <div className="progress-memory-grid">
                  <MemoryItem
                    label="Due now"
                    value={
                      memory.due_cards
                    }
                    detail="Ready to review"
                  />

                  <MemoryItem
                    label="New"
                    value={
                      memory.new_cards
                    }
                    detail="Not reviewed yet"
                  />

                  <MemoryItem
                    label="Learning"
                    value={
                      memory
                        .learning_cards
                    }
                    detail="Learning / relearning"
                  />

                  <MemoryItem
                    label="Review"
                    value={
                      memory
                        .review_cards
                    }
                    detail="In long-term review"
                  />

                  <MemoryItem
                    label="Mature"
                    value={
                      memory
                        .mature_cards
                    }
                    detail="FSRS stability ≥ 21 days"
                  />

                  <MemoryItem
                    label="Suspended"
                    value={
                      memory
                        .suspended_cards
                    }
                    detail="Excluded from review"
                  />
                </div>
              </section>

              <section className="progress-panel">
                <div className="progress-panel-heading">
                  <div>
                    <span className="progress-eyebrow">
                      LAST 30 DAYS
                    </span>

                    <h2>
                      Review ratings
                    </h2>
                  </div>

                  <span className="progress-panel-total">
                    {ratings.total}
                    {' '}ratings
                  </span>
                </div>

                {ratings.total === 0 ? (
                  <p className="progress-panel-empty">
                    Your Again / Hard /
                    Good / Easy mix will
                    appear after reviews.
                  </p>
                ) : (
                  <div className="progress-rating-list">
                    <RatingRow
                      label="Again"
                      value={
                        ratings.again
                      }
                      total={
                        ratings.total
                      }
                      className="progress-rating-again"
                    />

                    <RatingRow
                      label="Hard"
                      value={
                        ratings.hard
                      }
                      total={
                        ratings.total
                      }
                      className="progress-rating-hard"
                    />

                    <RatingRow
                      label="Good"
                      value={
                        ratings.good
                      }
                      total={
                        ratings.total
                      }
                      className="progress-rating-good"
                    />

                    <RatingRow
                      label="Easy"
                      value={
                        ratings.easy
                      }
                      total={
                        ratings.total
                      }
                      className="progress-rating-easy"
                    />
                  </div>
                )}
              </section>
            </div>

            <section className="progress-panel">
              <div className="progress-panel-heading">
                <div>
                  <span className="progress-eyebrow">
                    FOCUS NEXT
                  </span>

                  <h2>
                    Difficult cards
                  </h2>

                  <p>
                    Prioritized by lapses,
                    FSRS difficulty, and
                    review history.
                  </p>
                </div>

                <span className="progress-panel-total">
                  {summary.total_decks}
                  {' '}
                  {summary.total_decks === 1
                    ? 'deck'
                    : 'decks'}
                </span>
              </div>

              {summary
                .difficult_cards
                .length === 0 ? (
                <p className="progress-panel-empty">
                  No reviewed cards yet.
                  Your difficult-card list
                  will appear after study
                  sessions.
                </p>
              ) : (
                <div className="progress-difficult-list">
                  {summary
                    .difficult_cards
                    .map(
                      (card) => (
                        <DifficultCardRow
                          key={
                            card.card_id
                          }
                          card={card}
                          onNavigate={
                            onNavigate
                          }
                        />
                      ),
                    )}
                </div>
              )}
            </section>

            <p className="progress-method-note">
              Estimated retention comes
              from the current FSRS memory
              model for reviewed,
              non-suspended cards. “Mature”
              currently means FSRS
              stability of at least 21
              days.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
