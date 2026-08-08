import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  deleteQuizHistory,
  getQuizHistory,
  type QuizHistoryRow,
} from './lib/quizHistory'

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
}

type CurrentDocumentSummary = {
  attemptCount: number
  weakness: DocumentWeakness | null
}

function getDisplayFilename(
  name: string,
) {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function normalizeFilename(
  name: string,
) {
  return getDisplayFilename(name)
    .trim()
    .toLowerCase()
}

function getQuestionTypeLabel(
  type: string,
) {
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

function normalizeAnswer(
  answer: string,
) {
  return answer
    .normalize('NFKD')
    .replace(
      /[\u0300-\u036f]/g,
      '',
    )
    .trim()
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(
      /[.,!?;:'"()[\]{}]/g,
      '',
    )
    .replace(/\s+/g, ' ')
}

function removeSimplePlural(
  answer: string,
) {
  const words = answer.split(' ')

  if (words.length === 0) {
    return answer
  }

  const lastIndex = words.length - 1
  const lastWord = words[lastIndex]

  if (
    lastWord.length > 3 &&
    lastWord.endsWith('s') &&
    !lastWord.endsWith('ss')
  ) {
    words[lastIndex] =
      lastWord.slice(0, -1)
  }

  return words.join(' ')
}

function escapeRegExp(
  value: string,
) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )
}

function acceptedAnswerMatches(
  userAnswer: string,
  acceptedAnswer: string,
) {
  if (
    userAnswer === acceptedAnswer
  ) {
    return true
  }

  const userSingular =
    removeSimplePlural(userAnswer)

  const acceptedSingular =
    removeSimplePlural(
      acceptedAnswer,
    )

  if (
    userSingular ===
    acceptedSingular
  ) {
    return true
  }

  const isSingleToken =
    acceptedAnswer.split(' ')
      .length === 1

  const isUsefulToken =
    acceptedAnswer.length >= 4 ||
    /^\d+$/.test(
      acceptedAnswer,
    )

  if (
    isSingleToken &&
    isUsefulToken
  ) {
    const escaped =
      escapeRegExp(
        acceptedAnswer,
      )

    const pattern =
      new RegExp(
        `(^|\\s)${escaped}($|\\s)`,
      )

    if (
      pattern.test(userAnswer)
    ) {
      return true
    }
  }

  return false
}

function isShortAnswerCorrect(
  question: StoredQuestion,
  answer: string,
) {
  const userAnswer =
    normalizeAnswer(answer)

  const acceptedAnswers = [
    question.correct_answer,
    ...question.accepted_answers,
  ]
    .map(normalizeAnswer)
    .filter(
      (
        value,
        index,
        array,
      ) =>
        value.length > 0 &&
        array.indexOf(value) ===
          index,
    )

  return acceptedAnswers.some(
    (acceptedAnswer) =>
      acceptedAnswerMatches(
        userAnswer,
        acceptedAnswer,
      ),
  )
}

function isQuestionCorrect(
  question: StoredQuestion,
  answer:
    | number
    | string
    | undefined,
) {
  if (
    question.question_type ===
    'short_answer'
  ) {
    if (
      typeof answer !== 'string'
    ) {
      return false
    }

    return isShortAnswerCorrect(
      question,
      answer,
    )
  }

  return (
    typeof answer === 'number' &&
    answer ===
      question.correct_index
  )
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

  const question = value as Partial<StoredQuestion>

  return (
    (
      question.question_type ===
        'multiple_choice' ||
      question.question_type ===
        'true_false' ||
      question.question_type ===
        'short_answer'
    ) &&
    typeof question.question ===
      'string' &&
    Array.isArray(
      question.choices,
    ) &&
    typeof question.correct_index ===
      'number' &&
    typeof question.correct_answer ===
      'string' &&
    Array.isArray(
      question.accepted_answers,
    ) &&
    typeof question.explanation ===
      'string' &&
    Array.isArray(
      question.source_pages,
    )
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

  const possibleQuiz =
    value as {
      title?: unknown
      questions?: unknown
    }

  return (
    typeof possibleQuiz.title ===
      'string' &&
    Array.isArray(
      possibleQuiz.questions,
    ) &&
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

function formatDate(
  dateString: string,
) {
  const date =
    new Date(dateString)

  return date.toLocaleString(
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

function QuizHistory({
  refreshKey,
  currentFilename = null,
  canPracticeCurrentDocument = false,
  onPracticeWeakAreas,
}: QuizHistoryProps) {
  const [history, setHistory] =
    useState<QuizHistoryRow[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState('')

  const [expanded, setExpanded] =
    useState(false)

  const [
    isHistoryPracticeGenerating,
    setIsHistoryPracticeGenerating,
  ] = useState(false)

  async function loadHistory() {
    setLoading(true)
    setError('')

    try {
      const rows =
        await getQuizHistory()

      setHistory(rows)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not load quiz history.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadHistory()
  }, [refreshKey])

  async function handleDelete(
    id: string,
  ) {
    try {
      await deleteQuizHistory(id)

      setHistory(
        (previous) =>
          previous.filter(
            (item) =>
              item.id !== id,
          ),
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not delete quiz.',
      )
    }
  }

  const analytics =
    useMemo(() => {
      const quizzesCompleted =
        history.length

      const totalQuestions =
        history.reduce(
          (total, item) =>
            total +
            item.question_count,
          0,
        )

      const averageScore =
        quizzesCompleted > 0
          ? Math.round(
              history.reduce(
                (total, item) =>
                  total +
                  item.percentage,
                0,
              ) /
                quizzesCompleted,
            )
          : 0

      const bestScore =
        quizzesCompleted > 0
          ? Math.max(
              ...history.map(
                (item) =>
                  item.percentage,
              ),
            )
          : 0

      const latestScore =
        quizzesCompleted > 0
          ? history[0].percentage
          : 0

      const typePerformance =
        createTypePerformance()

      history.forEach(
        (item) => {
          if (
            !isStoredQuiz(
              item.quiz_data,
            ) ||
            !isStoredAnswers(
              item.selected_answers,
            )
          ) {
            return
          }

          const quizData =
            item.quiz_data

          const selectedAnswers =
            item.selected_answers

          quizData.questions.forEach(
            (
              question,
              questionIndex,
            ) => {
              const type =
                question.question_type

              typePerformance[
                type
              ].total += 1

              const answer =
                selectedAnswers[
                  String(
                    questionIndex,
                  )
                ]

              if (
                isQuestionCorrect(
                  question,
                  answer,
                )
              ) {
                typePerformance[
                  type
                ].correct += 1
              }
            },
          )
        },
      )

      return {
        quizzesCompleted,
        totalQuestions,
        averageScore,
        bestScore,
        latestScore,
        typePerformance,
      }
    }, [history])

  const currentDocumentSummary:
    CurrentDocumentSummary | null =
    useMemo(() => {
      if (!currentFilename) {
        return null
      }

      const normalizedCurrentFilename =
        normalizeFilename(
          currentFilename,
        )

      const matchingHistory =
        history.filter(
          (item) =>
            normalizeFilename(
              item.source_filename,
            ) ===
            normalizedCurrentFilename,
        )

      const typeMisses:
        Record<
          HistoryQuestionType,
          number
        > = {
          multiple_choice: 0,
          true_false: 0,
          short_answer: 0,
        }

      const typeTotals:
        Record<
          HistoryQuestionType,
          number
        > = {
          multiple_choice: 0,
          true_false: 0,
          short_answer: 0,
        }

      const typeCorrect:
        Record<
          HistoryQuestionType,
          number
        > = {
          multiple_choice: 0,
          true_false: 0,
          short_answer: 0,
        }

      const pageMisses =
        new Map<number, number>()

      const avoidQuestions =
        new Set<string>()

      let missedQuestions = 0

      matchingHistory.forEach(
        (item) => {
          if (
            !isStoredQuiz(
              item.quiz_data,
            ) ||
            !isStoredAnswers(
              item.selected_answers,
            )
          ) {
            return
          }

          const quizData =
            item.quiz_data

          const selectedAnswers =
            item.selected_answers

          quizData.questions.forEach(
            (
              question,
              questionIndex,
            ) => {
              const answer =
                selectedAnswers[
                  String(
                    questionIndex,
                  )
                ]

              typeTotals[
                question.question_type
              ] += 1

              if (
                isQuestionCorrect(
                  question,
                  answer,
                )
              ) {
                typeCorrect[
                  question.question_type
                ] += 1

                return
              }

              missedQuestions += 1

              typeMisses[
                question.question_type
              ] += 1

              avoidQuestions.add(
                question.question,
              )

              question.source_pages.forEach(
                (pageNumber) => {
                  pageMisses.set(
                    pageNumber,
                    (
                      pageMisses.get(
                        pageNumber,
                      ) ?? 0
                    ) + 1,
                  )
                },
              )
            },
          )
        },
      )

      if (missedQuestions === 0) {
        return {
          attemptCount:
            matchingHistory.length,
          weakness: null,
        }
      }

      const [questionType] =
        (
          Object.entries(
            typeMisses,
          ) as [
            HistoryQuestionType,
            number,
          ][]
        ).sort(
          (a, b) =>
            b[1] - a[1],
        )[0]

      const baselinePercent =
        typeTotals[questionType] > 0
          ? Math.round(
              (
                typeCorrect[
                  questionType
                ] /
                typeTotals[
                  questionType
                ]
              ) * 100,
            )
          : 0

      const rankedPageMisses =
        Array.from(
          pageMisses.entries(),
        ).sort(
          (a, b) =>
            b[1] - a[1] ||
            a[0] - b[0],
        )

      const highestPageMissCount =
        rankedPageMisses[0]?.[1] ?? 0

      const meaningfulPageMisses =
        rankedPageMisses.filter(
          ([, missCount]) =>
            missCount >=
            Math.max(
              1,
              Math.ceil(
                highestPageMissCount *
                  0.5,
              ),
            ),
        )

      const selectedPageMisses =
        meaningfulPageMisses.length >=
          2 ||
        rankedPageMisses.length < 2
          ? meaningfulPageMisses
          : rankedPageMisses.slice(
              0,
              2,
            )

      const pages =
        selectedPageMisses
          .slice(0, 3)
          .map(
            ([pageNumber]) =>
              pageNumber,
          )
          .sort(
            (a, b) => a - b,
          )

      return {
        attemptCount:
          matchingHistory.length,
        weakness: {
          questionType,
          pages,
          avoidQuestions:
            Array.from(
              avoidQuestions,
            ).slice(0, 20),
          missedQuestions,
          baselinePercent,
        },
      }
    }, [history, currentFilename])

  const recentHistory =
    history.slice(0, 5)

  function getTypePercentage(
    score: TypeScore,
  ) {
    if (score.total === 0) {
      return 0
    }

    return Math.round(
      (
        score.correct /
        score.total
      ) * 100,
    )
  }

  async function handleHistoryPractice() {
    const weakness =
      currentDocumentSummary
        ?.weakness

    if (
      !weakness ||
      !onPracticeWeakAreas ||
      !canPracticeCurrentDocument ||
      isHistoryPracticeGenerating
    ) {
      return
    }

    setIsHistoryPracticeGenerating(
      true,
    )

    try {
      await onPracticeWeakAreas({
        pages: weakness.pages,
        questionType:
          weakness.questionType,
        avoidQuestions:
          weakness.avoidQuestions,
        baselinePercent:
          weakness.baselinePercent,
      })
    } finally {
      setIsHistoryPracticeGenerating(
        false,
      )
    }
  }

  return (
    <section className="history-section">
      <button
        className="history-toggle"
        type="button"
        onClick={() =>
          setExpanded(
            (previous) =>
              !previous,
          )
        }
      >
        <div>
          <strong>
            My Quiz History
          </strong>

          <span>
            {history.length}{' '}
            {history.length === 1
              ? 'saved quiz'
              : 'saved quizzes'}
          </span>
        </div>

        <span>
          {expanded
            ? '▲'
            : '▼'}
        </span>
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
            history.length ===
              0 && (
              <div className="history-empty">
                <strong>
                  No saved quizzes yet
                </strong>

                <p>
                  Finish a quiz and
                  click Save Result to
                  add it here.
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

                      <h2>
                        Your progress
                      </h2>
                    </div>

                    <span className="analytics-latest">
                      Latest score:{' '}
                      <strong>
                        {analytics.latestScore}%
                      </strong>
                    </span>
                  </div>

                  <div className="analytics-grid">
                    <article className="analytics-card">
                      <span>
                        Quizzes Completed
                      </span>
                      <strong>
                        {analytics.quizzesCompleted}
                      </strong>
                    </article>

                    <article className="analytics-card">
                      <span>
                        Average Score
                      </span>
                      <strong>
                        {analytics.averageScore}%
                      </strong>
                    </article>

                    <article className="analytics-card">
                      <span>
                        Best Score
                      </span>
                      <strong>
                        {analytics.bestScore}%
                      </strong>
                    </article>

                    <article className="analytics-card">
                      <span>
                        Questions Answered
                      </span>
                      <strong>
                        {analytics.totalQuestions}
                      </strong>
                    </article>
                  </div>

                  <div className="performance-panel">
                    <div className="performance-heading">
                      <h3>
                        Performance by
                        question type
                      </h3>

                      <span>
                        Based on saved
                        quizzes
                      </span>
                    </div>

                    <div className="performance-list">
                      {analytics
                        .typePerformance
                        .multiple_choice
                        .total > 0 && (
                        <div className="performance-row">
                          <div className="performance-label">
                            <span>
                              Multiple Choice
                            </span>
                            <strong>
                              {analytics.typePerformance.multiple_choice.correct}{' '}
                              /{' '}
                              {analytics.typePerformance.multiple_choice.total}
                            </strong>
                          </div>

                          <div className="analytics-progress">
                            <div
                              className="analytics-progress-fill"
                              style={{
                                width: `${getTypePercentage(
                                  analytics.typePerformance.multiple_choice,
                                )}%`,
                              }}
                            />
                          </div>

                          <span className="performance-percent">
                            {getTypePercentage(
                              analytics.typePerformance.multiple_choice,
                            )}%
                          </span>
                        </div>
                      )}

                      {analytics
                        .typePerformance
                        .true_false
                        .total > 0 && (
                        <div className="performance-row">
                          <div className="performance-label">
                            <span>
                              True / False
                            </span>
                            <strong>
                              {analytics.typePerformance.true_false.correct}{' '}
                              /{' '}
                              {analytics.typePerformance.true_false.total}
                            </strong>
                          </div>

                          <div className="analytics-progress">
                            <div
                              className="analytics-progress-fill"
                              style={{
                                width: `${getTypePercentage(
                                  analytics.typePerformance.true_false,
                                )}%`,
                              }}
                            />
                          </div>

                          <span className="performance-percent">
                            {getTypePercentage(
                              analytics.typePerformance.true_false,
                            )}%
                          </span>
                        </div>
                      )}

                      {analytics
                        .typePerformance
                        .short_answer
                        .total > 0 && (
                        <div className="performance-row">
                          <div className="performance-label">
                            <span>
                              Short Answer
                            </span>
                            <strong>
                              {analytics.typePerformance.short_answer.correct}{' '}
                              /{' '}
                              {analytics.typePerformance.short_answer.total}
                            </strong>
                          </div>

                          <div className="analytics-progress">
                            <div
                              className="analytics-progress-fill"
                              style={{
                                width: `${getTypePercentage(
                                  analytics.typePerformance.short_answer,
                                )}%`,
                              }}
                            />
                          </div>

                          <span className="performance-percent">
                            {getTypePercentage(
                              analytics.typePerformance.short_answer,
                            )}%
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="history-weakness-panel">
                    <div className="performance-heading">
                      <h3>
                        Long-term weak areas
                      </h3>

                      <span>
                        Current PDF history
                      </span>
                    </div>

                    {!currentFilename && (
                      <div className="history-weakness-empty">
                        Upload and process a PDF to turn
                        your saved mistakes into a targeted
                        practice quiz.
                      </div>
                    )}

                    {currentFilename &&
                      currentDocumentSummary?.attemptCount ===
                        0 && (
                        <div className="history-weakness-empty">
                          <strong>
                            No saved attempts for this PDF yet
                          </strong>
                          <span>
                            Complete and save a quiz for{' '}
                            {getDisplayFilename(
                              currentFilename,
                            )}{' '}
                            to start building long-term weak-area data.
                          </span>
                        </div>
                      )}

                    {currentFilename &&
                      currentDocumentSummary &&
                      currentDocumentSummary.attemptCount > 0 &&
                      !currentDocumentSummary.weakness && (
                        <div className="history-weakness-empty history-weakness-success">
                          <strong>
                            No weak areas detected for this PDF
                          </strong>
                          <span>
                            Your saved attempts do not contain any
                            incorrect answers for this document.
                          </span>
                        </div>
                      )}

                    {currentFilename &&
                      currentDocumentSummary?.weakness && (
                        <>
                          <div className="history-weakness-file">
                            <span>
                              Analyzing saved attempts for
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
                                Saved Attempts
                              </span>
                              <strong>
                                {currentDocumentSummary.attemptCount}
                              </strong>
                            </article>

                            <article>
                              <span>
                                Missed Questions
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
                          </div>

                          <p className="history-weakness-description">
                            QuizForge combines mistakes from every saved
                            attempt for this PDF, finds the question type
                            you miss most often, and targets up to three
                            of your strongest weak pages.
                          </p>

                          <button
                            className="history-practice-button"
                            type="button"
                            onClick={
                              handleHistoryPractice
                            }
                            disabled={
                              !canPracticeCurrentDocument ||
                              isHistoryPracticeGenerating ||
                              !onPracticeWeakAreas
                            }
                          >
                            {isHistoryPracticeGenerating
                              ? 'Building Practice Quiz...'
                              : 'Practice My Weak Areas'}
                          </button>

                          {!canPracticeCurrentDocument && (
                            <span className="history-practice-note">
                              Process this PDF above to enable
                              history-based practice.
                            </span>
                          )}
                        </>
                      )}
                  </div>

                  <div className="recent-progress">
                    <div className="performance-heading">
                      <h3>
                        Recent scores
                      </h3>

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
                    Saved quizzes
                  </span>
                </div>

                <div className="history-list">
                  {history.map(
                    (item) => (
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

                            <h3>
                              {item.quiz_title}
                            </h3>

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
                            handleDelete(
                              item.id,
                            )
                          }
                        >
                          Delete
                        </button>
                      </article>
                    ),
                  )}
                </div>
              </>
            )}
        </div>
      )}
    </section>
  )
}

export default QuizHistory
