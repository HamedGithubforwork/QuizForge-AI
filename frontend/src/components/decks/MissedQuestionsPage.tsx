import {
  useEffect,
  useState,
} from 'react'

import {
  getQuizHistoryPage,
} from '../../lib/quizHistory'
import {
  missedAnswerLabel,
  missedStudyQuestions,
  type MissedStudyQuestion,
} from '../../lib/missedQuestions'

type MissedQuestionsPageProps = {
  onNavigate: (path: string) => void
}

function formatDate(
  value: string,
) {
  const date = new Date(value)

  if (
    Number.isNaN(date.getTime())
  ) {
    return 'Saved quiz'
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

function correctChoiceIndex(
  item: MissedStudyQuestion,
) {
  return item.correct_index
}

export default function MissedQuestionsPage({
  onNavigate,
}: MissedQuestionsPageProps) {
  const [questions, setQuestions] =
    useState<
      MissedStudyQuestion[]
    >([])
  const [historyCount, setHistoryCount] =
    useState(0)
  const [loadedCount, setLoadedCount] =
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
        const page =
          await getQuizHistoryPage({
            limit: 50,
          })

        if (!active) {
          return
        }

        setHistoryCount(
          page.totalCount ??
            page.items.length,
        )
        setLoadedCount(
          page.items.length,
        )
        setQuestions(
          missedStudyQuestions(
            page.items,
          ),
        )
        setIndex(0)
        setRevealed(false)
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load missed questions.',
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

  const current =
    questions[index] ??
    null
  const completed =
    questions.length > 0 &&
    index >= questions.length

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
          Finding recent missed questions…
        </span>
      </section>
    )
  }

  if (error) {
    return (
      <section className="review-session-status">
        <h1>
          Could not load Missed Questions
        </h1>

        <p role="alert">
          {error}
        </p>

        <button
          className="decks-secondary-button"
          type="button"
          onClick={() =>
            onNavigate('/decks')
          }
        >
          Back to My Decks
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
            onNavigate('/decks')
          }
        >
          ← My Decks
        </button>

        <section className="review-complete">
          <div
            className="review-complete-mark"
            aria-hidden="true"
          >
            ✓
          </div>

          <span className="decks-eyebrow">
            MISSED QUESTIONS COMPLETE
          </span>

          <h1>
            You revisited your recent misses
          </h1>

          <p>
            You reviewed{' '}
            <strong>
              {questions.length}
            </strong>
            {' '}
            {questions.length === 1
              ? 'question'
              : 'questions'}.
          </p>

          <p className="cram-schedule-note">
            This practice session did not
            change any FSRS due dates,
            review counts, or deck history.
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
              Practice Again
            </button>

            <button
              className="decks-secondary-button"
              type="button"
              onClick={() =>
                onNavigate('/decks')
              }
            >
              Back to My Decks
            </button>
          </div>
        </section>
      </>
    )
  }

  if (!current) {
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

        <section className="review-complete">
          <span className="decks-eyebrow">
            MISSED QUESTIONS
          </span>

          <h1>
            {historyCount === 0
              ? 'No saved quiz history yet'
              : 'No unresolved recent misses'}
          </h1>

          <p>
            {historyCount === 0
              ? 'Finish a quiz and save the result to build a Missed Questions practice set.'
              : 'Your newest saved evidence for each loaded question is correct, so there is nothing to retry right now.'}
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
      </>
    )
  }

  const studentAnswer =
    missedAnswerLabel(
      current,
    )
  const correctIndex =
    correctChoiceIndex(
      current,
    )
  const historyScope =
    historyCount > loadedCount
      ? `Latest ${loadedCount} of ${historyCount} saved quizzes`
      : `${loadedCount} saved ${loadedCount === 1 ? 'quiz' : 'quizzes'}`

  return (
    <>
      <div className="review-session-topbar">
        <button
          className="decks-back"
          type="button"
          onClick={() =>
            onNavigate('/decks')
          }
        >
          ← Exit Missed Questions
        </button>

        <div className="cram-session-meta">
          <span className="cram-mode-badge">
            Missed Questions · schedule unchanged
          </span>

          <span className="review-session-count">
            <strong>
              {index + 1}
            </strong>
            {' '}of {questions.length}
          </span>
        </div>
      </div>

      <section className="review-card">
        <header className="review-card-header">
          <div>
            <span className="decks-eyebrow">
              {current.source_filename}
            </span>

            <span className="review-question-type">
              {
                current.question_type
                  .replace(
                    /_/g,
                    ' ',
                  )
              }
            </span>

            <span className="missed-evidence-badge">
              Missed {formatDate(
                current.missed_at,
              )}
            </span>
          </div>

          {current.source_pages.length >
            0 && (
            <span className="deck-card-pages">
              Pages{' '}
              {current.source_pages.join(
                ', ',
              )}
            </span>
          )}
        </header>

        <div className="missed-history-scope">
          {historyScope}
          {' '}· newest evidence wins
        </div>

        <div className="review-question">
          <h1>
            {current.question}
          </h1>

          {current.choices.length >
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
            <div className="missed-answer-grid">
              <div className="missed-your-answer">
                <span>
                  Your saved answer
                </span>

                <strong>
                  {studentAnswer}
                </strong>
              </div>

              <div className="review-answer">
                <span>
                  Correct answer
                </span>

                <strong>
                  {
                    current.correct_answer
                  }
                </strong>

                {current.explanation && (
                  <p>
                    {
                      current.explanation
                    }
                  </p>
                )}
              </div>
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
              questions.length
                ? 'Finish Missed Questions'
                : 'Next Question →'}
            </button>
          </>
        )}
      </section>
    </>
  )
}
