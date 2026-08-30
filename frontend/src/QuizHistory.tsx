import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import MasteryAnalyticsPanel from './MasteryAnalyticsPanel.tsx'
import {
  deleteQuizHistory,
  getQuizHistoryForDocument,
  getQuizHistoryPage,
  type QuizHistoryRow,
} from './lib/quizHistory'
import {
  getCurrentDocumentSha256,
} from './lib/documentIdentity'
import {
  isHistoryQuestionCorrect,
} from './lib/historyQuestionGrader'
import {
  analyzeWeakAreas,
  type WeakAreaAttempt,
} from './lib/weakAreaAnalytics'
import {
  appendUniqueHistoryRows,
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
} from './lib/quizHistoryPagination'
import type {
  ShortAnswerGradingSpec,
} from './lib/shortAnswerGrader'

import './QuizHistory.css'

export type HistoryQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type HistoryPracticeFocus = {
  pages: number[]
  questionType: HistoryQuestionType
  avoidQuestions: string[]
  baselinePercent: number
  baselineQuestionCount: number
}

type QuizHistoryProps = {
  refreshKey: number
  currentFilename?: string | null
  canPracticeCurrentDocument?: boolean
  isPracticeGenerating?: boolean
  onPracticeWeakAreas?: (
    focus: HistoryPracticeFocus,
  ) => void | Promise<void>
}

type StoredQuestion = {
  question_type: HistoryQuestionType
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
  explanation: string
  source_pages: number[]
}

type StoredQuiz = {
  title: string
  questions: StoredQuestion[]
}

type StoredAnswers =
  Record<string, number | string>

type TypeScore = {
  correct: number
  total: number
}

type TypePerformance = {
  multiple_choice: TypeScore
  true_false: TypeScore
  short_answer: TypeScore
}

type DocumentWeakness = {
  questionType: HistoryQuestionType
  pages: number[]
  avoidQuestions: string[]
  missedQuestions: number
  baselinePercent: number
  baselineQuestionCount: number
  baselineAttemptCount: number
  baselineReliable: boolean
}

type CurrentDocumentSummary = {
  attemptCount: number
  weakness: DocumentWeakness | null
}

function getDisplayFilename(name: string) {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function getQuestionTypeLabel(type: string) {
  if (type === 'multiple_choice') {
    return 'Multiple Choice'
  }

  if (type === 'true_false') {
    return 'True / False'
  }

  if (type === 'short_answer') {
    return 'Short Answer'
  }

  if (type === 'mixed') {
    return 'Mixed'
  }

  return type
}

function isStoredQuestion(
  value: unknown,
): value is StoredQuestion {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false
  }

  const question =
    value as Partial<StoredQuestion>

  return (
    (
      question.question_type ===
        'multiple_choice' ||
      question.question_type ===
        'true_false' ||
      question.question_type ===
        'short_answer'
    ) &&
    typeof question.question === 'string' &&
    Array.isArray(question.choices) &&
    typeof question.correct_index === 'number' &&
    typeof question.correct_answer === 'string' &&
    Array.isArray(question.accepted_answers) &&
    typeof question.explanation === 'string' &&
    Array.isArray(question.source_pages)
  )
}

function isStoredQuiz(
  value: unknown,
): value is StoredQuiz {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false
  }

  const possibleQuiz = value as {
    title?: unknown
    questions?: unknown
  }

  return (
    typeof possibleQuiz.title === 'string' &&
    Array.isArray(possibleQuiz.questions) &&
    possibleQuiz.questions.every(
      isStoredQuestion,
    )
  )
}

function isStoredAnswers(
  value: unknown,
): value is StoredAnswers {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
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

function createTypePerformance(): TypePerformance {
  return {
    multiple_choice: {
      correct: 0,
      total: 0,
    },
    true_false: {
      correct: 0,
      total: 0,
    },
    short_answer: {
      correct: 0,
      total: 0,
    },
  }
}

function getTypePercentage(score: TypeScore) {
  if (score.total === 0) {
    return 0
  }

  return Math.round(
    (score.correct / score.total) * 100,
  )
}

function QuizHistory({
  refreshKey,
  currentFilename = null,
  canPracticeCurrentDocument = false,
  isPracticeGenerating = false,
  onPracticeWeakAreas,
}: QuizHistoryProps) {
  const [history, setHistory] =
    useState<QuizHistoryRow[]>([])
  const [documentHistory, setDocumentHistory] =
    useState<QuizHistoryRow[]>([])
  const [totalHistoryCount, setTotalHistoryCount] =
    useState(0)
  const [hasMoreHistory, setHasMoreHistory] =
    useState(false)
  const [loading, setLoading] =
    useState(true)
  const [loadingMore, setLoadingMore] =
    useState(false)
  const [error, setError] =
    useState('')
  const [loadMoreError, setLoadMoreError] =
    useState('')
  const [expanded, setExpanded] =
    useState(false)
  const [historyEnabled, setHistoryEnabled] =
    useState(false)
  const [historyLoaded, setHistoryLoaded] =
    useState(false)
  const [
    isHistoryPracticeGenerating,
    setIsHistoryPracticeGenerating,
  ] = useState(false)
  const [
    practiceReadyFilename,
    setPracticeReadyFilename,
  ] = useState<string | null>(null)

  useEffect(() => {
    if (
      canPracticeCurrentDocument &&
      currentFilename
    ) {
      setPracticeReadyFilename(
        currentFilename,
      )
      return
    }

    if (!currentFilename) {
      setPracticeReadyFilename(null)
      return
    }

    if (
      practiceReadyFilename &&
      practiceReadyFilename !== currentFilename
    ) {
      setPracticeReadyFilename(null)
    }
  }, [
    canPracticeCurrentDocument,
    currentFilename,
    practiceReadyFilename,
  ])

  const canPracticeHistory = Boolean(
    currentFilename &&
      practiceReadyFilename === currentFilename,
  )

  const currentDocumentSha256 =
    canPracticeCurrentDocument
      ? getCurrentDocumentSha256(
          currentFilename,
        )
      : null

  useEffect(() => {
    if (!historyEnabled) {
      return
    }

    let cancelled = false

    async function loadFirstPage() {
      setLoading(true)
      setError('')
      setLoadMoreError('')

      try {
        const page =
          await getQuizHistoryPage()

        if (cancelled) {
          return
        }

        setHistory(page.items)
        setTotalHistoryCount(
          page.totalCount,
        )
        setHasMoreHistory(page.hasMore)
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Could not load quiz history.',
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setHistoryLoaded(true)
        }
      }
    }

    void loadFirstPage()

    return () => {
      cancelled = true
    }
  }, [historyEnabled, refreshKey])

  useEffect(() => {
    if (!historyEnabled) {
      return
    }

    let cancelled = false

    async function loadCurrentDocumentHistory() {
      if (!currentFilename) {
        setDocumentHistory([])
        return
      }

      try {
        const rows =
          await getQuizHistoryForDocument({
            sourceFilename: currentFilename,
            documentSha256:
              currentDocumentSha256,
            limit:
              DOCUMENT_HISTORY_ANALYSIS_LIMIT,
          })

        if (!cancelled) {
          setDocumentHistory(rows)
        }
      } catch {
        if (!cancelled) {
          setDocumentHistory([])
        }
      }
    }

    void loadCurrentDocumentHistory()

    return () => {
      cancelled = true
    }
  }, [
    currentDocumentSha256,
    currentFilename,
    historyEnabled,
    refreshKey,
  ])

  async function handleLoadMore() {
    if (
      loadingMore ||
      !hasMoreHistory
    ) {
      return
    }

    setLoadingMore(true)
    setLoadMoreError('')

    try {
      const page =
        await getQuizHistoryPage({
          offset: history.length,
        })

      setHistory((previous) =>
        appendUniqueHistoryRows(
          previous,
          page.items,
        ),
      )
      setTotalHistoryCount(
        page.totalCount,
      )
      setHasMoreHistory(page.hasMore)
    } catch (err) {
      setLoadMoreError(
        err instanceof Error
          ? err.message
          : 'Could not load more saved quizzes.',
      )
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteQuizHistory(id)
      setHistory((previous) =>
        previous.filter(
          (item) => item.id !== id,
        ),
      )
      setDocumentHistory((previous) =>
        previous.filter(
          (item) => item.id !== id,
        ),
      )
      setTotalHistoryCount(
        (previous) =>
          Math.max(0, previous - 1),
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not delete quiz.',
      )
    }
  }

  const analytics = useMemo(() => {
    const loadedQuizCount = history.length
    const totalQuestions = history.reduce(
      (total, item) =>
        total + item.question_count,
      0,
    )
    const averageScore =
      loadedQuizCount > 0
        ? Math.round(
            history.reduce(
              (total, item) =>
                total + item.percentage,
              0,
            ) / loadedQuizCount,
          )
        : 0
    const bestScore =
      loadedQuizCount > 0
        ? Math.max(
            ...history.map(
              (item) => item.percentage,
            ),
          )
        : 0
    const latestScore =
      loadedQuizCount > 0
        ? history[0].percentage
        : 0
    const typePerformance =
      createTypePerformance()

    history.forEach((item) => {
      if (
        !isStoredQuiz(item.quiz_data) ||
        !isStoredAnswers(
          item.selected_answers,
        )
      ) {
        return
      }

      item.quiz_data.questions.forEach(
        (question, questionIndex) => {
          const type =
            question.question_type
          typePerformance[type].total += 1
          const answer =
            item.selected_answers[
              String(questionIndex)
            ]

          if (
            isHistoryQuestionCorrect(
              question,
              answer,
            )
          ) {
            typePerformance[type].correct += 1
          }
        },
      )
    })

    return {
      loadedQuizCount,
      quizzesCompleted: totalHistoryCount,
      totalQuestions,
      averageScore,
      bestScore,
      latestScore,
      typePerformance,
    }
  }, [history, totalHistoryCount])

  const currentDocumentSummary:
    CurrentDocumentSummary | null =
    useMemo(() => {
      if (!currentFilename) {
        return null
      }

      const attempts: WeakAreaAttempt[] =
        documentHistory.flatMap((item) => {
          if (
            !isStoredQuiz(item.quiz_data) ||
            !isStoredAnswers(
              item.selected_answers,
            )
          ) {
            return []
          }

          return [
            {
              questions:
                item.quiz_data.questions.map(
                  (question, questionIndex) => ({
                    questionType:
                      question.question_type,
                    question:
                      question.question,
                    sourcePages:
                      question.source_pages,
                    correct:
                      isHistoryQuestionCorrect(
                        question,
                        item.selected_answers[
                          String(questionIndex)
                        ],
                      ),
                  }),
                ),
            },
          ]
        })

      const weakness =
        analyzeWeakAreas(attempts)

      return {
        attemptCount:
          documentHistory.length,
        weakness: weakness
          ? {
              questionType:
                weakness.questionType,
              pages: weakness.pages,
              avoidQuestions:
                weakness.avoidQuestions,
              missedQuestions:
                weakness.missedQuestions,
              baselinePercent:
                weakness.baselinePercent,
              baselineQuestionCount:
                weakness.baselineQuestionCount,
              baselineAttemptCount:
                weakness.baselineAttemptCount,
              baselineReliable:
                weakness.baselineReliable,
            }
          : null,
      }
    }, [
      currentFilename,
      documentHistory,
    ])

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
          setHistoryEnabled(true)
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
                          handleDelete(item.id)
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
                    onClick={handleLoadMore}
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