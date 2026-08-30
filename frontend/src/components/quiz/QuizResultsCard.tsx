import {
  getMasteryMessage,
  getQuestionTypeLabel,
  getScoreMessage,
} from '../../lib/quizPresentation'
import type {
  MasteryContext,
  QuestionTypeScore,
} from '../../types/quiz'

type QuizResultsCardProps = {
  questionCount: number
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
  isGenerating: boolean
  saveMessage: string
  onSaveResult: () => void
  onRetryIncorrect: () => void
  onPracticeWeakAreas: () => void
  onTryAgain: () => void
  onGenerateNewQuiz: () => void
  onUploadNewPdf: () => void
}

function QuizResultsCard({
  questionCount,
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
  isGenerating,
  saveMessage,
  onSaveResult,
  onRetryIncorrect,
  onPracticeWeakAreas,
  onTryAgain,
  onGenerateNewQuiz,
  onUploadNewPdf,
}: QuizResultsCardProps) {
  const hasIncorrectAnswers =
    score < questionCount

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
        {score} / {questionCount} correct
      </h2>

      <p className="score-message">
        {getScoreMessage(percentage)}
      </p>

      <p className="incorrect-count">
        You answered{' '}
        {questionCount - score}{' '}
        incorrectly.
      </p>

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

      <div className="result-actions">
        <button
          className="button secondary-button"
          type="button"
          onClick={onSaveResult}
          disabled={
            isSavingHistory ||
            resultSaved
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
              isWeakPracticeGenerating
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
              isGenerating
            }
          >
            {isWeakPracticeGenerating
              ? 'Building Practice Quiz...'
              : 'Practice Weak Areas'}
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

      {saveMessage && (
        <p className="save-message">
          {saveMessage}
        </p>
      )}
    </section>
  )
}

export default QuizResultsCard
