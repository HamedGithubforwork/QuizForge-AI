import MasteryAnalyticsPanel from '../../MasteryAnalyticsPanel.tsx'
import {
  buildHistoryAnalytics,
  getDisplayFilename,
  getQuestionTypeLabel,
  getTypePercentage,
  type CurrentDocumentSummary,
  type HistoryQuestionType,
} from '../../lib/quizHistoryAnalytics.ts'
import {
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
} from '../../lib/quizHistoryPagination.ts'
import type {
  QuizHistoryRow,
} from '../../lib/quizHistory.ts'
import {
  formatHistoryDate,
} from './formatHistoryDate.ts'

type QuizHistoryAnalyticsProps = {
  history: QuizHistoryRow[]
  documentHistory: QuizHistoryRow[]
  totalHistoryCount: number
  hasMoreHistory: boolean
  currentFilename: string | null
  currentDocumentSha256: string | null
  currentDocumentSummary:
    CurrentDocumentSummary | null
  canPracticeHistory: boolean
  isHistoryPracticeGenerating: boolean
  isPracticeGenerating: boolean
  practiceAvailable: boolean
  onPractice: () => void | Promise<void>
}

function QuizHistoryAnalytics({
  history,
  documentHistory,
  totalHistoryCount,
  hasMoreHistory,
  currentFilename,
  currentDocumentSha256,
  currentDocumentSummary,
  canPracticeHistory,
  isHistoryPracticeGenerating,
  isPracticeGenerating,
  practiceAvailable,
  onPractice,
}: QuizHistoryAnalyticsProps) {
  const analytics =
    buildHistoryAnalytics(
      history,
      totalHistoryCount,
    )

  const recentHistory =
    history.slice(0, 5)

  return (
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
                onClick={() =>
                  void onPractice()
                }
                disabled={
                  !canPracticeHistory ||
                  isHistoryPracticeGenerating ||
                  isPracticeGenerating ||
                  !practiceAvailable
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
                    {formatHistoryDate(
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
  )
}

export default QuizHistoryAnalytics
