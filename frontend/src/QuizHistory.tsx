import {
  useState,
} from 'react'

import MasteryAnalyticsPanel from './MasteryAnalyticsPanel.tsx'
import {
  useQuizHistoryData,
} from './hooks/useQuizHistoryData.ts'
import {
  buildCurrentDocumentSummary,
  buildHistoryAnalytics,
  getDisplayFilename,
  getQuestionTypeLabel,
  getTypePercentage,
  type HistoryPracticeFocus,
  type HistoryQuestionType,
} from './lib/quizHistoryAnalytics.ts'
import {
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
} from './lib/quizHistoryPagination.ts'

import './QuizHistory.css'

export type {
  HistoryPracticeFocus,
} from './lib/quizHistoryAnalytics.ts'

type QuizHistoryProps = {
  refreshKey: number
  currentFilename?: string | null
  canPracticeCurrentDocument?: boolean
  isPracticeGenerating?: boolean
  onPracticeWeakAreas?: (
    focus: HistoryPracticeFocus,
  ) => void | Promise<void>
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleString(
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  )
}

function QuizHistory({
  refreshKey,
  currentFilename = null,
  canPracticeCurrentDocument = false,
  isPracticeGenerating = false,
  onPracticeWeakAreas,
}: QuizHistoryProps) {
  const [expanded, setExpanded] =
    useState(false)
  const [
    isHistoryPracticeGenerating,
    setIsHistoryPracticeGenerating,
  ] = useState(false)

  const {
    history,
    documentHistory,
    totalHistoryCount,
    hasMoreHistory,
    loading,
    loadingMore,
    error,
    loadMoreError,
    historyLoaded,
    canPracticeHistory,
    currentDocumentSha256,
    enableHistory,
    loadMore,
    removeHistoryItem,
  } = useQuizHistoryData({
    refreshKey,
    currentFilename,
    canPracticeCurrentDocument,
  })

  const analytics =
    buildHistoryAnalytics(
      history,
      totalHistoryCount,
    )

  const currentDocumentSummary =
    buildCurrentDocumentSummary(
      currentFilename,
      documentHistory,
    )

  const recentHistory =
    history.slice(0, 5)

  async function handleHistoryPractice() {
    const weakness =
      currentDocumentSummary?.weakness

    if (
      !weakness ||
      !onPracticeWeakAreas ||
      !canPracticeHistory ||
      isHistoryPracticeGenerating ||
      isPracticeGenerating
    ) {
      return
    }

    setIsHistoryPracticeGenerating(true)

    try {
      await onPracticeWeakAreas({
        pages: weakness.pages,
        questionType:
          weakness.questionType,
        avoidQuestions:
          weakness.avoidQuestions,
        baselinePercent:
          weakness.baselinePercent,
        baselineQuestionCount:
          weakness.baselineQuestionCount,
      })
    } finally {
      setIsHistoryPracticeGenerating(false)
    }
  }

  return (
    <section className="history-section">
      <button
        className="history-toggle"
        type="button"
        onClick={() => {
          enableHistory()
          setExpanded(
            (previous) => !previous,
          )
        }}
      >
        <div>
          <strong>My Quiz History</strong>
          <span>
            {historyLoaded ? (
              <>
                {totalHistoryCount}{' '}
                {totalHistoryCount === 1
                  ? 'saved quiz'
                  : 'saved quizzes'}
              </>
            ) : (
              'Open to load saved quizzes'
            )}
          </span>
        </div>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="history-content">
          {loading && (
            <p className="history-status">
              Loading history...
            </p>
          )}

          {error && (
            <div className="history-error">
              {error}
            </div>
          )}

          {!loading &&
            !error &&
            history.length === 0 && (
              <div className="history-empty">
                <strong>
                  No saved quizzes yet
                </strong>
                <p>
                  Finish a quiz and click Save
                  Result to add it here.
                </p>
              </div>
            )}

          {!loading &&
            !error &&
            history.length > 0 && (
              <>
                <section className="analytics-section">
                  <div className="analytics-heading">
                    <div>
                      <span className="analytics-eyebrow">
                        Study Analytics
                      </span>
                      <h2>Your progress</h2>
                    </div>
                    <span className="analytics-latest">
                      Latest score:{' '}
                      <strong>
                        {analytics.latestScore}%
                      </strong>
                    </span>
                  </div>

                  <p className="history-status">
                    Score analytics currently use{' '}
                    {analytics.loadedQuizCount} of{' '}
                    {analytics.quizzesCompleted} saved{' '}
                    {analytics.quizzesCompleted === 1
                      ? 'quiz'
                      : 'quizzes'}.
                    {hasMoreHistory
                      ? ' Load more below to include older attempts.'
                      : ''}
                  </p>

                  <div className="analytics-grid">
                    <article className="analytics-card">
                      <span>Saved Quizzes</span>
                      <strong>
                        {analytics.quizzesCompleted}
                      </strong>
                    </article>
                    <article className="analytics-card">
                      <span>Average Score</span>
                      <strong>
                        {analytics.averageScore}%
                      </strong>
                    </article>
                    <article className="analytics-card">
                      <span>Best Score</span>
                      <strong>
                        {analytics.bestScore}%
                      </strong>
                    </article>
                    <article className="analytics-card">
                      <span>
                        Questions Analyzed
                      </span>
                      <strong>
                        {analytics.totalQuestions}
                      </strong>
                    </article>
                  </div>

                  <div className="performance-panel">
                    <div className="performance-heading">
                      <h3>
                        Performance by question type
                      </h3>
                      <span>
                        Based on loaded quizzes
                      </span>
                    </div>

                    <div className="performance-list">
                      {(
                        [
                          'multiple_choice',
                          'true_false',
                          'short_answer',
                        ] as HistoryQuestionType[]
                      ).map((type) => {
                        const score =
                          analytics.typePerformance[
                            type
                          ]

                        if (score.total === 0) {
                          return null
                        }

                        return (
                          <div
                            className="performance-row"
                            key={type}
                          >
                            <div className="performance-label">
                              <span>
                                {getQuestionTypeLabel(
                                  type,
                                )}
                              </span>
                              <strong>
                                {score.correct} /{' '}
                                {score.total}
                              </strong>
                            </div>
                            <div className="analytics-progress">
                              <div
                                className="analytics-progress-fill"
                                style={{
                                  width: `${getTypePercentage(
                                    score,
                                  )}%`,
                                }}
                              />
                            </div>
                            <span className="performance-percent">
                              {getTypePercentage(
                                score,
                              )}%
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <MasteryAnalyticsPanel
                    history={documentHistory}
                    currentFilename={
                      currentFilename
                    }
                    currentDocumentSha256={
                      currentDocumentSha256
                    }
                  />

                  <div className="history-weakness-panel">
                    <div className="performance-heading">
                      <h3>
                        Long-term weak areas
                      </h3>
                      <span>
                        Up to the latest{' '}
                        {DOCUMENT_HISTORY_ANALYSIS_LIMIT}{' '}
                        attempts for this PDF
                      </span>
                    </div>

                    {!currentFilename && (
                      <div className="history-weakness-empty">
                        Upload and process a PDF to
                        turn your saved mistakes into
                        a targeted practice quiz.
                      </div>
                    )}

                    {currentFilename &&
                      currentDocumentSummary?.attemptCount ===
                        0 && (
                        <div className="history-weakness-empty">
                          <strong>
                            No saved attempts for this
                            PDF yet
                          </strong>
                          <span>
                            Complete and save a quiz for{' '}
                            {getDisplayFilename(
                              currentFilename,
                            )}{' '}
                            to start building long-term
                            weak-area data.
                          </span>
                        </div>
                      )}

                    {currentFilename &&
                      currentDocumentSummary &&
                      currentDocumentSummary.attemptCount >
                        0 &&
                      !currentDocumentSummary.weakness && (
                        <div className="history-weakness-empty history-weakness-success">
                          <strong>
                            No weak areas detected for
                            this PDF
                          </strong>
                          <span>
                            Your newest saved evidence for
                            each tested question type has
                            no unresolved misses.
                          </span>
                        </div>
                      )}

                    {currentFilename &&
                      currentDocumentSummary?.weakness && (
                        <>
                          <div className="history-weakness-file">
                            <span>
                              Analyzing recent saved
                              attempts for
                            </span>
                            <strong>
                              {getDisplayFilename(
                                currentFilename,
                              )}
                            </strong>
                          </div>

                          <div className="history-weakness-grid">
                            <article>
                              <span>
                                Recent Attempts
                              </span>
                              <strong>
                                {currentDocumentSummary.attemptCount}
                              </strong>
                            </article>
                            <article>
                              <span>
                                Recent Misses
                              </span>
                              <strong>
                                {currentDocumentSummary.weakness.missedQuestions}
                              </strong>
                            </article>
                            <article>
                              <span>
                                Weakest Type
                              </span>
                              <strong className="history-weakness-text-value">
                                {getQuestionTypeLabel(
                                  currentDocumentSummary.weakness.questionType,
                                )}
                              </strong>
                            </article>
                            <article>
                              <span>
                                Focus Pages
                              </span>
                              <strong className="history-weakness-text-value">
                                {currentDocumentSummary.weakness.pages.length > 0
                                  ? currentDocumentSummary.weakness.pages.join(', ')
                                  : 'Whole PDF'}
                              </strong>
                            </article>
                            <article>
                              <span>
                                Recent Baseline
                              </span>
                              <strong>
                                {currentDocumentSummary.weakness.baselinePercent}%
                              </strong>
                            </article>
                            <article>
                              <span>
                                Baseline Sample
                              </span>
                              <strong>
                                {currentDocumentSummary.weakness.baselineQuestionCount}{' '}
                                {currentDocumentSummary.weakness.baselineQuestionCount === 1
                                  ? 'question'
                                  : 'questions'}
                              </strong>
                            </article>
                          </div>

                          <p className="history-weakness-description">
                            QuizForge uses your newest
                            evidence for each question type
                            so old mistakes do not stay weak
                            forever after you master them. It
                            uses up to three recent attempts
                            to set the baseline and rank up to
                            three focus pages.
                          </p>

                          {!currentDocumentSummary.weakness.baselineReliable && (
                            <span className="history-practice-note">
                              Preliminary baseline: only{' '}
                              {currentDocumentSummary.weakness.baselineQuestionCount}{' '}
                              {currentDocumentSummary.weakness.baselineQuestionCount === 1
                                ? 'question is'
                                : 'questions are'}{' '}
                              available for this comparison.
                            </span>
                          )}

                          <button
                            className="history-practice-button"
                            type="button"
                            onClick={
                              handleHistoryPractice
                            }
                            disabled={
                              !canPracticeHistory ||
                              isHistoryPracticeGenerating ||
                              isPracticeGenerating ||
                              !onPracticeWeakAreas
                            }
                          >
                            {isHistoryPracticeGenerating ||
                            isPracticeGenerating
                              ? 'Building Practice Quiz...'
                              : 'Practice My Weak Areas'}
                          </button>

                          {!canPracticeHistory && (
                            <span className="history-practice-note">
                              Process this PDF above to
                              enable history-based practice.
                            </span>
                          )}
                        </>
                      )}
                  </div>

                  <div className="recent-progress">
                    <div className="performance-heading">
                      <h3>Recent scores</h3>
                      <span>
                        Last {recentHistory.length}{' '}
                        saved{' '}
                        {recentHistory.length === 1
                          ? 'quiz'
                          : 'quizzes'}
                      </span>
                    </div>

                    <div className="recent-score-list">
                      {recentHistory.map(
                        (item, index) => (
                          <div
                            className="recent-score-row"
                            key={item.id}
                          >
                            <span className="recent-score-number">
                              {index + 1}
                            </span>
                            <div className="recent-score-info">
                              <strong>
                                {item.quiz_title}
                              </strong>
                              <span>
                                {formatDate(
                                  item.created_at,
                                )}
                              </span>
                            </div>
                            <strong className="recent-score-value">
                              {item.percentage}%
                            </strong>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                </section>

                <div className="history-divider">
                  <span>
                    Saved quizzes · Showing{' '}
                    {history.length} of{' '}
                    {totalHistoryCount}
                  </span>
                </div>

                <div className="history-list">
                  {history.map((item) => (
                    <article
                      className="history-card"
                      key={item.id}
                    >
                      <div className="history-card-main">
                        <div className="history-card-details">
                          <span className="history-date">
                            {formatDate(
                              item.created_at,
                            )}
                          </span>
                          <h3>{item.quiz_title}</h3>
                          <p>
                            {getDisplayFilename(
                              item.source_filename,
                            )}
                          </p>
                          <div className="history-meta">
                            <span>
                              {item.difficulty}
                            </span>
                            <span>
                              {getQuestionTypeLabel(
                                item.question_type,
                              )}
                            </span>
                            <span>
                              {item.question_count}{' '}
                              questions
                            </span>
                          </div>
                        </div>

                        <div className="history-score">
                          <strong>
                            {item.percentage}%
                          </strong>
                          <span>
                            {item.score} /{' '}
                            {item.question_count}
                          </span>
                        </div>
                      </div>

                      <button
                        className="history-delete"
                        type="button"
                        onClick={() =>
                          void removeHistoryItem(
                            item.id,
                          )
                        }
                      >
                        Delete
                      </button>
                    </article>
                  ))}
                </div>

                {loadMoreError && (
                  <div className="history-error">
                    {loadMoreError}
                  </div>
                )}

                {hasMoreHistory && (
                  <button
                    className="history-practice-button"
                    type="button"
                    onClick={() =>
                      void loadMore()
                    }
                    disabled={loadingMore}
                  >
                    {loadingMore
                      ? 'Loading More...'
                      : 'Load More Saved Quizzes'}
                  </button>
                )}
              </>
            )}
        </div>
      )}
    </section>
  )
}

export default QuizHistory
