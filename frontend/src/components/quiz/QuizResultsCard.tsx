import {
  getMasteryMessage,
  getQuestionTypeLabel,
  getScoreMessage,
} from '../../lib/quizPresentation'
import type {
  MasteryContext,
  QuestionTypeScore,
  QuizResult,
  UploadResult,
} from '../../types/quiz'
import SaveDeckPanel from './SaveDeckPanel.tsx'
import GenerationTimingPanel from './GenerationTimingPanel.tsx'
import type { GenerationTimeEstimate } from '../../lib/generationTiming.ts'
import type { DesktopLocalQuizProgress } from '../../lib/desktop.ts'

type QuizResultsCardProps = {
  quiz: QuizResult
  documentResult: UploadResult
  questionCount: number
  isReviewingAnswers: boolean
  answerReviewProgress: { completed: number; total: number } | null
  partialCount?: number
  uncertainCount?: number
  partialCredit?: number
  score: number
  percentage: number
  multipleChoiceScore:
    QuestionTypeScore
  trueFalseScore:
    QuestionTypeScore
  shortAnswerScore:
    QuestionTypeScore
  practiceMode: boolean
  masteryContext:
    | MasteryContext
    | null
  masteryDelta: number
  isSavingHistory: boolean
  resultSaved: boolean
  isWeakPracticeGenerating: boolean
  showPracticeTiming: boolean
  practiceTimingElapsedMs: number
  practiceTimingEstimate: GenerationTimeEstimate | null
  localBatchProgress: DesktopLocalQuizProgress | null
  weakPracticeError: string
  canCancelWeakPractice: boolean
  isGenerating: boolean
  saveMessage: string
  onSaveResult: () => void
  onRetryIncorrect: () => void
  onPracticeWeakAreas: () => void
  onCancelWeakPractice: () => void
  onTryAgain: () => void
  onGenerateNewQuiz: () => void
  onUploadNewPdf: () => void
}

function QuizResultsCard({
  quiz,
  documentResult,
  questionCount,
  isReviewingAnswers,
  answerReviewProgress,
  partialCount = 0,
  uncertainCount = 0,
  partialCredit = 0,
  score,
  percentage,
  multipleChoiceScore,
  trueFalseScore,
  shortAnswerScore,
  practiceMode,
  masteryContext,
  masteryDelta,
  isSavingHistory,
  resultSaved,
  isWeakPracticeGenerating,
  showPracticeTiming,
  practiceTimingElapsedMs,
  practiceTimingEstimate,
  localBatchProgress,
  weakPracticeError,
  canCancelWeakPractice,
  isGenerating,
  saveMessage,
  onSaveResult,
  onRetryIncorrect,
  onPracticeWeakAreas,
  onCancelWeakPractice,
  onTryAgain,
  onGenerateNewQuiz,
  onUploadNewPdf,
}: QuizResultsCardProps) {
  const hasIncorrectAnswers = score < questionCount && uncertainCount === 0 && !isReviewingAnswers
  const assessedCount = Math.max(0, questionCount - uncertainCount)
  const earnedCredit = Number((score + partialCredit).toFixed(2))
  const assessedCreditPercentage = assessedCount > 0
    ? Math.round((earnedCredit / assessedCount) * 100)
    : null

  return (
    <section
      className="results-card"
      id="quiz-results"
    >
      <span className="eyebrow">
        Quiz complete
      </span>

      <div className="score-number">
        {percentage}%
      </div>

      <h2>
        {score} / {questionCount} fully correct
      </h2>

      <p className="score-message">
        {uncertainCount > 0 ? 'Provisional result — ungraded short answers are not counted as incorrect.' : getScoreMessage(percentage)}
      </p>
      {isReviewingAnswers && answerReviewProgress && (
        <p className="answer-review-status" role="status">
          Local AI: {answerReviewProgress.completed} of {answerReviewProgress.total} short answers reviewed.
          You can inspect multiple-choice and true/false results now. Each short answer will update as it is checked.
        </p>
      )}

      <p className="incorrect-count">
        {questionCount - score - partialCount - uncertainCount} incorrect
        {partialCount > 0 && ` · ${partialCount} partially correct`}
        {uncertainCount > 0 && ` · ${uncertainCount} need review (not marked incorrect)`}
      </p>

      {(partialCount > 0 || uncertainCount > 0) && <p className="assessed-credit-summary">
        <strong>Study credit: {earnedCredit} / {assessedCount} assessed points
        {assessedCreditPercentage !== null && ` (${assessedCreditPercentage}%)`}</strong>.
        {' '}The large score above counts only fully correct answers, not partial credit.
        {uncertainCount > 0 && ` ${uncertainCount} answer${uncertainCount === 1 ? ' is' : 's are'} pending review and excluded from the assessed points. The overall score is provisional.`}
      </p>}
      <div className="score-breakdown">
        {multipleChoiceScore.total > 0 && (
          <div>
            <span>Multiple Choice</span>
            <strong>
              {multipleChoiceScore.correct}{' '}
              / {multipleChoiceScore.total}
            </strong>
          </div>
        )}

        {trueFalseScore.total > 0 && (
          <div>
            <span>True / False</span>
            <strong>
              {trueFalseScore.correct}{' '}
              / {trueFalseScore.total}
            </strong>
          </div>
        )}

        {shortAnswerScore.total > 0 && (
          <div>
            <span>Short Answer</span>
            <strong>
              {shortAnswerScore.correct}{' '}
              / {shortAnswerScore.total}
            </strong>
          </div>
        )}
      </div>

      {practiceMode &&
        masteryContext && (
          <div className="mastery-progress-card">
            <div className="mastery-progress-heading">
              <div>
                <span className="eyebrow">
                  Mastery progress
                </span>

                <h3>
                  {masteryContext.baselineQuestionCount <
                  3
                    ? 'Preliminary weak-area comparison'
                    : 'Weak-area improvement'}
                </h3>
              </div>

              <strong
                className={
                  `mastery-delta ${
                    masteryDelta > 0
                      ? 'mastery-delta-positive'
                      : masteryDelta < 0
                        ? 'mastery-delta-negative'
                        : ''
                  }`
                }
              >
                {masteryDelta > 0
                  ? '+'
                  : ''}
                {masteryDelta} pts
              </strong>
            </div>

            <div className="mastery-score-grid">
              <div>
                <span>
                  {masteryContext.baselineQuestionCount <
                  3
                    ? 'Preliminary baseline'
                    : 'Recent baseline'}
                </span>

                <strong>
                  {
                    masteryContext
                      .baselinePercent
                  }
                  %
                </strong>
              </div>

              <div>
                <span>
                  Practice score
                </span>

                <strong>
                  {percentage}%
                </strong>
              </div>

              <div>
                <span>Focus</span>

                <strong className="mastery-focus-value">
                  {getQuestionTypeLabel(
                    masteryContext
                      .questionType,
                  )}
                </strong>
              </div>
            </div>

            <p className="mastery-progress-message">
              {getMasteryMessage(
                masteryDelta,
                masteryContext
                  .baselineQuestionCount,
              )}
            </p>

            <span className="mastery-progress-source">
              Compared with{' '}
              {masteryContext.source ===
              'history'
                ? 'your saved-history performance for this question type'
                : 'the quiz that started this practice session'}{' '}
              • Baseline sample:{' '}
              {
                masteryContext
                  .baselineQuestionCount
              }{' '}
              {masteryContext.baselineQuestionCount ===
              1
                ? 'question'
                : 'questions'}
              {masteryContext.pages.length >
                0 && (
                <>
                  {' '}• Focus pages:{' '}
                  {masteryContext.pages.join(
                    ', ',
                  )}
                </>
              )}
            </span>
          </div>
        )}

      <SaveDeckPanel
        quiz={quiz}
        documentResult={documentResult}
      />

      {showPracticeTiming && (
        <GenerationTimingPanel
          label="Generating weak-area practice quiz"
          elapsedMs={practiceTimingElapsedMs}
          estimate={practiceTimingEstimate}
          progress={localBatchProgress}
        />
      )}

      <div className="result-actions">
        <button
          className="button secondary-button"
          type="button"
          onClick={onSaveResult}
          disabled={
            isSavingHistory ||
            resultSaved || isReviewingAnswers || uncertainCount > 0
          }
        >
          {isSavingHistory
            ? 'Saving...'
            : resultSaved
              ? 'Saved ✓'
              : 'Save Result'}
        </button>

        {hasIncorrectAnswers && (
          <button
            className="button retry-button"
            type="button"
            onClick={onRetryIncorrect}
            disabled={
              isWeakPracticeGenerating || isReviewingAnswers || uncertainCount > 0
            }
          >
            Retry Incorrect
          </button>
        )}

        {hasIncorrectAnswers && (
          <button
            className="button weak-practice-button"
            type="button"
            onClick={
              onPracticeWeakAreas
            }
            disabled={
              isWeakPracticeGenerating ||
              isGenerating || isReviewingAnswers || uncertainCount > 0
            }
          >
            {isWeakPracticeGenerating
              ? 'Building Practice Quiz...'
              : 'Practice Weak Areas'}
          </button>
        )}

        {isWeakPracticeGenerating &&
          canCancelWeakPractice && (
            <button
              className="button secondary-button"
              type="button"
              onClick={
                onCancelWeakPractice
              }
            >
              Cancel Local Practice
            </button>
          )}

        <button
          className="button secondary-button"
          type="button"
          onClick={onTryAgain}
          disabled={
            isWeakPracticeGenerating
          }
        >
          Try Again
        </button>

        <button
          className="button primary-button"
          type="button"
          onClick={onGenerateNewQuiz}
          disabled={
            isGenerating ||
            isWeakPracticeGenerating
          }
        >
          {isGenerating
            ? 'Generating...'
            : 'Generate New Quiz'}
        </button>

        <button
          className="button ghost-button"
          type="button"
          onClick={onUploadNewPdf}
          disabled={
            isWeakPracticeGenerating
          }
        >
          Upload New PDF
        </button>
      </div>

      {weakPracticeError && (
        <p className="error-message" role="alert" aria-live="assertive">
          <strong>Could not build weak-area practice</strong>
          <span>{weakPracticeError}</span>
        </p>
      )}

      {saveMessage && (
        <p
          className="save-message"
          role="status"
          aria-live="polite"
        >
          {saveMessage}
        </p>
      )}
    </section>
  )
}

export default QuizResultsCard
