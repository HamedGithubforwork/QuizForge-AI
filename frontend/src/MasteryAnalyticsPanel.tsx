import {
  useMemo,
} from 'react'

import {
  matchesHistoryDocument,
} from './lib/documentIdentity'
import {
  isHistoryQuestionCorrect,
} from './lib/historyQuestionGrader'
import {
  analyzeDocumentMastery,
  getMasteryStatusLabel,
  type MasteryAttempt,
  type MasteryQuestionType,
} from './lib/masteryAnalytics'
import type {
  QuizHistoryRow,
} from './lib/quizHistory'
import type {
  ShortAnswerGradingSpec,
} from './lib/shortAnswerGrader'

import './MasteryAnalyticsPanel.css'

type MasteryAnalyticsPanelProps = {
  history: QuizHistoryRow[]
  currentFilename: string | null
  currentDocumentSha256: string | null
}

type StoredQuestion = {
  question_type: MasteryQuestionType
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
  ai_accepted_answers?: string[]
  explanation: string
  source_pages: number[]
}

type StoredQuiz = {
  title: string
  questions: StoredQuestion[]
}

type StoredAnswers =
  Record<string, number | string>

function getDisplayFilename(name: string) {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function getQuestionTypeLabel(
  type: MasteryQuestionType,
) {
  if (type === 'multiple_choice') {
    return 'Multiple Choice'
  }

  if (type === 'true_false') {
    return 'True / False'
  }

  return 'Short Answer'
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

function formatShortDate(dateString: string) {
  return new Date(dateString).toLocaleDateString(
    undefined,
    {
      month: 'short',
      day: 'numeric',
    },
  )
}

function formatDelta(delta: number | null) {
  if (delta === null) {
    return 'No prior baseline'
  }

  if (delta > 0) {
    return `+${delta} pts`
  }

  if (delta < 0) {
    return `${delta} pts`
  }

  return 'No change'
}

function getStatusDescription(
  status: 'needs_work' | 'improving' | 'mastered',
) {
  if (status === 'mastered') {
    return 'Mastery is confirmed by repeated strong performance, not just one high score.'
  }

  if (status === 'improving') {
    return 'Recent evidence is moving in the right direction, but mastery is not sustained yet.'
  }

  return 'Recent evidence is still below the sustained mastery threshold.'
}

function MasteryAnalyticsPanel({
  history,
  currentFilename,
  currentDocumentSha256,
}: MasteryAnalyticsPanelProps) {
  const summary = useMemo(() => {
    if (!currentFilename) {
      return null
    }

    const matchingHistory = history.filter(
      (item) =>
        matchesHistoryDocument(
          item,
          currentFilename,
          currentDocumentSha256,
        ),
    )

    const attempts: MasteryAttempt[] =
      matchingHistory.flatMap((item) => {
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
            createdAt: item.created_at,
            percentage: item.percentage,
            questions:
              item.quiz_data.questions.map(
                (question, questionIndex) => ({
                  questionType:
                    question.question_type,
                  question: question.question,
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

    return {
      matchingCount: matchingHistory.length,
      mastery:
        analyzeDocumentMastery(attempts),
    }
  }, [
    currentDocumentSha256,
    currentFilename,
    history,
  ])

  if (!currentFilename) {
    return null
  }

  if (!summary?.mastery) {
    return (
      <section className="mastery-panel">
        <div className="mastery-heading">
          <div>
            <span className="mastery-eyebrow">
              Current PDF
            </span>
            <h3>Mastery tracking</h3>
          </div>
          <span className="mastery-status mastery-status-pending">
            No data yet
          </span>
        </div>
        <p className="mastery-empty">
          Save at least one quiz for{' '}
          <strong>
            {getDisplayFilename(
              currentFilename,
            )}
          </strong>{' '}
          to start tracking mastery over time.
        </p>
      </section>
    )
  }

  const mastery = summary.mastery
  const trend = [
    ...mastery.recentTrend,
  ].reverse()

  return (
    <section className="mastery-panel">
      <div className="mastery-heading">
        <div>
          <span className="mastery-eyebrow">
            Current PDF
          </span>
          <h3>Mastery tracking</h3>
        </div>
        <span
          className={`mastery-status mastery-status-${mastery.status}`}
        >
          {getMasteryStatusLabel(
            mastery.status,
          )}
        </span>
      </div>

      <div className="mastery-file">
        <strong>
          {getDisplayFilename(
            currentFilename,
          )}
        </strong>
        <span>
          {mastery.attemptCount}{' '}
          {mastery.attemptCount === 1
            ? 'saved attempt'
            : 'saved attempts'}
        </span>
      </div>

      <p className="mastery-description">
        {getStatusDescription(
          mastery.status,
        )}
      </p>

      <div className="mastery-overview-grid">
        <article>
          <span>Latest Score</span>
          <strong>
            {mastery.latestPercent}%
          </strong>
        </article>
        <article>
          <span>Prior Baseline</span>
          <strong>
            {mastery.priorBaselinePercent ===
            null
              ? '—'
              : `${mastery.priorBaselinePercent}%`}
          </strong>
        </article>
        <article>
          <span>Change</span>
          <strong className="mastery-text-value">
            {formatDelta(
              mastery.scoreDelta,
            )}
          </strong>
        </article>
        <article>
          <span>Sustained</span>
          <strong className="mastery-text-value">
            {mastery.sustainedMastery
              ? 'Confirmed'
              : 'Not yet'}
          </strong>
        </article>
      </div>

      {mastery.typeSummaries.length > 0 && (
        <div className="mastery-block">
          <div className="mastery-subheading">
            <strong>
              Mastery by question type
            </strong>
            <span>
              Two strong attempts required
            </span>
          </div>

          <div className="mastery-type-list">
            {mastery.typeSummaries.map(
              (typeSummary) => (
                <div
                  className="mastery-type-row"
                  key={
                    typeSummary.questionType
                  }
                >
                  <div className="mastery-type-label">
                    <strong>
                      {getQuestionTypeLabel(
                        typeSummary.questionType,
                      )}
                    </strong>
                    <span>
                      {typeSummary.questionCount}{' '}
                      recent{' '}
                      {typeSummary.questionCount ===
                      1
                        ? 'question'
                        : 'questions'}
                    </span>
                  </div>

                  <div className="mastery-type-progress">
                    <div
                      style={{
                        width: `${typeSummary.latestPercent}%`,
                      }}
                    />
                  </div>

                  <div className="mastery-type-score">
                    <strong>
                      {typeSummary.latestPercent}%
                    </strong>
                    <span>
                      {formatDelta(
                        typeSummary.delta,
                      )}
                    </span>
                  </div>

                  <span
                    className={`mastery-mini-status mastery-mini-status-${typeSummary.status}`}
                  >
                    {getMasteryStatusLabel(
                      typeSummary.status,
                    )}
                  </span>
                </div>
              ),
            )}
          </div>
        </div>
      )}

      <div className="mastery-block">
        <div className="mastery-subheading">
          <strong>
            Score trend
          </strong>
          <span>
            Up to 6 recent attempts
          </span>
        </div>

        <div className="mastery-trend-list">
          {trend.map((point, index) => (
            <div
              className="mastery-trend-row"
              key={`${point.createdAt}-${index}`}
            >
              <span className="mastery-trend-date">
                {formatShortDate(
                  point.createdAt,
                )}
              </span>
              <div className="mastery-trend-track">
                <div
                  style={{
                    width: `${point.percentage}%`,
                  }}
                />
              </div>
              <strong>
                {point.percentage}%
              </strong>
            </div>
          ))}
        </div>
      </div>

      <div className="mastery-block">
        <div className="mastery-subheading">
          <strong>
            Recurring weak pages
          </strong>
          <span>
            Missed across multiple attempts
          </span>
        </div>

        {mastery.recurringWeakPages.length ===
        0 ? (
          <p className="mastery-recurring-empty">
            No page has repeated misses across
            multiple recent attempts yet. A
            one-off mistake is not labeled a
            recurring weakness.
          </p>
        ) : (
          <div className="mastery-page-list">
            {mastery.recurringWeakPages.map(
              (page) => (
                <article
                  key={page.pageNumber}
                >
                  <strong>
                    Page {page.pageNumber}
                  </strong>
                  <span>
                    {page.missCount}{' '}
                    {page.missCount === 1
                      ? 'miss'
                      : 'misses'}{' '}
                    across{' '}
                    {page.attemptCount}{' '}
                    attempts
                  </span>
                </article>
              ),
            )}
          </div>
        )}
      </div>

      <p className="mastery-method-note">
        A type is marked Mastered only after at
        least two consecutive strong attempts,
        at least five recent questions, and an
        80%+ combined recent accuracy. This keeps
        one unusually good attempt from being
        mistaken for sustained mastery.
      </p>
    </section>
  )
}

export default MasteryAnalyticsPanel
