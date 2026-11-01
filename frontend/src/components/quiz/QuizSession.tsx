import type { AiAnswerReviewDecision } from '../../lib/answerFallback.ts'
import type { DesktopLocalQuizProgress } from '../../lib/desktop.ts'
import {
  getQuestionTypeLabel,
  isQuestionAnswered,
} from '../../lib/quizPresentation'
import type {
  AnswerValue,
  GeneratedSettings,
  MasteryContext,
  PracticeFocus,
  QuestionTypeScore,
  QuizQuestion,
  QuizResult,
  UploadResult,
} from '../../types/quiz'
import { formatGenerationDuration, type GenerationTimeEstimate } from '../../lib/generationTiming.ts'
import QuizQuestionCard from './QuizQuestionCard.tsx'
import QuizResultsCard from './QuizResultsCard.tsx'

type QuizSessionProps = {
  quiz: QuizResult
  generationDurationMs: number | null
  showPracticeTiming: boolean
  practiceTimingElapsedMs: number
  practiceTimingEstimate: GenerationTimeEstimate | null
  localBatchProgress: DesktopLocalQuizProgress | null
  documentResult: UploadResult
  generatedSettings:
    | GeneratedSettings
    | null
  selectedAnswers:
    Record<number, AnswerValue>
  showResults: boolean
  retryQuestionIndexes:
    | number[]
    | null
  attentionQuestionIndex:
    | number
    | null
  openSourceQuestionIndex:
    | number
    | null
  practiceMode: boolean
  practiceFocus:
    | PracticeFocus
    | null
  activeQuestionIndexes: number[]
  answeredCount: number
  score: number
  percentage: number
  masteryContext:
    | MasteryContext
    | null
  masteryDelta: number
  multipleChoiceScore:
    QuestionTypeScore
  trueFalseScore:
    QuestionTypeScore
  shortAnswerScore:
    QuestionTypeScore
  getAnswerReview?: (question: QuizQuestion, answer: AnswerValue | undefined) => AiAnswerReviewDecision | undefined
  isReviewingAnswers: boolean
  shortAnswerReviewMode: 'local-ai' | 'manual'
  answerReviewProgress: { completed: number; total: number } | null
  onShortAnswerReviewModeChange: (mode: 'local-ai' | 'manual') => void
  onManualShortAnswerGrade: (index: number, verdict: 'correct' | 'partial' | 'incorrect') => void
  onStopLocalAnswerReview: () => void
  isSavingHistory: boolean
  resultSaved: boolean
  isWeakPracticeGenerating: boolean
  weakPracticeError: string
  canCancelWeakPractice: boolean
  isGenerating: boolean
  saveMessage: string
  isQuestionCorrect:
    (
      question: QuizQuestion,
      answer:
        | AnswerValue
        | undefined,
    ) => boolean
  onJumpQuestion:
    (questionIndex: number) => void
  onAnswerChange:
    (
      questionIndex: number,
      answer: AnswerValue,
    ) => void
  onToggleSource:
    (questionIndex: number) => void
  onCheckAnswers: () => void
  onSaveResult: () => void
  onRetryIncorrect: () => void
  onPracticeWeakAreas: () => void
  onCancelWeakPractice: () => void
  onTryAgain: () => void
  onGenerateNewQuiz: () => void
  onUploadNewPdf: () => void
}

function QuizSession({
  quiz,
  generationDurationMs,
  showPracticeTiming,
  practiceTimingElapsedMs,
  practiceTimingEstimate,
  localBatchProgress,
  documentResult,
  generatedSettings,
  selectedAnswers,
  showResults,
  retryQuestionIndexes,
  attentionQuestionIndex,
  openSourceQuestionIndex,
  practiceMode,
  practiceFocus,
  activeQuestionIndexes,
  answeredCount,
  score,
  percentage,
  masteryContext,
  masteryDelta,
  multipleChoiceScore,
  trueFalseScore,
  shortAnswerScore,
  getAnswerReview,
  isReviewingAnswers,
  shortAnswerReviewMode,
  answerReviewProgress,
  onShortAnswerReviewModeChange,
  onManualShortAnswerGrade,
  onStopLocalAnswerReview,
  isSavingHistory,
  resultSaved,
  isWeakPracticeGenerating,
  weakPracticeError,
  canCancelWeakPractice,
  isGenerating,
  saveMessage,
  isQuestionCorrect,
  onJumpQuestion,
  onAnswerChange,
  onToggleSource,
  onCheckAnswers,
  onSaveResult,
  onRetryIncorrect,
  onPracticeWeakAreas,
  onCancelWeakPractice,
  onTryAgain,
  onGenerateNewQuiz,
  onUploadNewPdf,
}: QuizSessionProps) {
  // Keep the original numbering and jump targets, but on the results screen
  // present instant objective scores first. Then show the short answers as
  // Local AI finishes reviewing them or the student grades them manually.
  const displayedQuestionIndexes = showResults
    ? [
        ...activeQuestionIndexes.filter(index => quiz.questions[index].question_type !== 'short_answer'),
        ...activeQuestionIndexes.filter(index => quiz.questions[index].question_type === 'short_answer'),
      ]
    : activeQuestionIndexes

  return (
    <section
      className="quiz-section"
      id="quiz-start"
    >
      <div className="quiz-header">
        <div>
          <span className="eyebrow">
            AI-generated quiz
          </span>

          <h2>{quiz.title}</h2>
        </div>

        <div className="quiz-meta">
          {generationDurationMs !== null && (
            <span className="generation-duration">
              Generated in {formatGenerationDuration(generationDurationMs)}
              {generatedSettings?.engine ? ` • ${generatedSettings.engine === 'local' ? 'Local AI' : 'Cloud AI'}` : ''}
            </span>
          )}
          <span>
            {quiz.questions.length}{' '}
            questions
          </span>

          {generatedSettings && (
            <>
              <span className="difficulty-badge">
                {
                  generatedSettings
                    .difficulty
                }
              </span>

              <span className="type-badge">
                {getQuestionTypeLabel(
                  generatedSettings
                    .questionType,
                )}
              </span>
            </>
          )}

          {retryQuestionIndexes && (
            <span className="retry-badge">
              Retry Mode
            </span>
          )}

          {practiceMode && (
            <span className="weak-practice-badge">
              Weak Areas Practice
            </span>
          )}
        </div>
      </div>

      {generatedSettings?.requestedQuestionCount &&
        quiz.questions.length < generatedSettings.requestedQuestionCount && (
          <div className="weak-practice-banner" role="status">
            <strong>
              Generated {quiz.questions.length} of {generatedSettings.requestedQuestionCount} requested questions
            </strong>
            <span>
              The app kept the questions it could validate and excluded unsupported or
              malformed candidates. For more questions, try selecting additional source
              pages or a lower difficulty.
            </span>
          </div>
        )}

      {practiceMode &&
        practiceFocus && (
          <div className="weak-practice-banner">
            <strong>
              Targeted practice
            </strong>

            <span>
              Focus pages:{' '}
              {practiceFocus.pages.join(
                ', ',
              )}
              {' • '}
              {getQuestionTypeLabel(
                practiceFocus
                  .questionType,
              )}
            </span>
          </div>
        )}

      {retryQuestionIndexes && (
        <div className="retry-message">
          Retrying{' '}
          {retryQuestionIndexes.length}{' '}
          missed{' '}
          {retryQuestionIndexes.length ===
          1
            ? 'question'
            : 'questions'}
        </div>
      )}

      <div className="progress-text">
        {answeredCount} of{' '}
        {activeQuestionIndexes.length}{' '}
        answered
      </div>

      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{
            width: `${
              activeQuestionIndexes.length >
              0
                ? (
                    answeredCount /
                    activeQuestionIndexes.length
                  ) * 100
                : 0
            }%`,
          }}
        />
      </div>

      <nav className="question-navigator">
        <span className="navigator-label">
          Jump to question
        </span>

        <div className="navigator-buttons">
          {activeQuestionIndexes.map(
            (questionIndex) => {
              const question =
                quiz.questions[
                  questionIndex
                ]

              const answer =
                selectedAnswers[
                  questionIndex
                ]

              const answered =
                isQuestionAnswered(
                  question,
                  answer,
                )

              const correct =
                isQuestionCorrect(
                  question,
                  answer,
                )

              let navClass =
                'question-nav-button'

              if (showResults) {
                const verdict = getAnswerReview?.(question, selectedAnswers[questionIndex])?.verdict
                navClass += verdict === 'uncertain' || verdict === 'partial' ? ' nav-review' : correct
                  ? ' nav-correct'
                  : ' nav-incorrect'
              } else if (answered) {
                navClass +=
                  ' nav-answered'
              } else {
                navClass +=
                  ' nav-unanswered'
              }

              if (
                attentionQuestionIndex ===
                questionIndex
              ) {
                navClass +=
                  ' nav-attention'
              }

              return (
                <button
                  key={questionIndex}
                  className={navClass}
                  type="button"
                  onClick={() => {
                    onJumpQuestion(
                      questionIndex,
                    )
                  }}
                >
                  {questionIndex + 1}
                </button>
              )
            },
          )}
        </div>
      </nav>

      {showResults && generatedSettings?.engine === 'local' && (
        <p className="review-section-intro">
          Multiple-choice and true/false results are shown first. Short answers follow
          with individual Local AI decisions or your own self-grading.
        </p>
      )}
      <div className="questions-list">
        {displayedQuestionIndexes.map(
          (questionIndex) => {
            const question =
              quiz.questions[
                questionIndex
              ]

            const selectedAnswer =
              selectedAnswers[
                questionIndex
              ]

            return (
              <QuizQuestionCard
                key={questionIndex}
                question={question}
                answerReview={getAnswerReview?.(question, selectedAnswer)}
                isReviewing={isReviewingAnswers}
                allowManualGrade={showResults && generatedSettings?.engine === 'local' && !isReviewingAnswers && (
                  shortAnswerReviewMode === 'manual' || getAnswerReview?.(question, selectedAnswer)?.verdict === 'uncertain'
                )}
                onManualGrade={onManualShortAnswerGrade}
                questionIndex={
                  questionIndex
                }
                selectedAnswer={
                  selectedAnswer
                }
                showResults={showResults}
                needsAttention={
                  attentionQuestionIndex ===
                  questionIndex
                }
                isCorrect={
                  isQuestionCorrect(
                    question,
                    selectedAnswer,
                  )
                }
                isSourceOpen={
                  openSourceQuestionIndex ===
                  questionIndex
                }
                documentSha256={
                  documentResult.pdf_sha256
                }
                onAnswerChange={
                  onAnswerChange
                }
                onToggleSource={
                  onToggleSource
                }
              />
            )
          },
        )}
      </div>

      {!showResults && generatedSettings?.engine === 'local' &&
        quiz.questions.some(question => question.question_type === 'short_answer') && (
        <fieldset className="short-review-options">
          <legend>How should short answers be graded?</legend>
          <label><input type="radio" name="local-short-review-mode"
            checked={shortAnswerReviewMode === 'local-ai'}
            onChange={() => onShortAnswerReviewModeChange('local-ai')} />
            Local AI — show other answers immediately, then review short answers one by one</label>
          <label><input type="radio" name="local-short-review-mode"
            checked={shortAnswerReviewMode === 'manual'}
            onChange={() => onShortAnswerReviewModeChange('manual')} />
            Self-check — grade multiple choice and true/false immediately; I will mark short answers</label>
        </fieldset>
      )}

      {!showResults && (
        <button
          className="button primary-button check-button"
          type="button"
          onClick={onCheckAnswers}
          disabled={isReviewingAnswers}
        >
          {isReviewingAnswers
            ? 'Reviewing Answers...'
            : 'Check Answers'}
        </button>
      )}

      {showResults && (
        <QuizResultsCard
          quiz={quiz}
          documentResult={documentResult}
          isReviewingAnswers={isReviewingAnswers}
          answerReviewProgress={answerReviewProgress}
          onStopLocalAnswerReview={onStopLocalAnswerReview}
          questionCount={
            quiz.questions.length
          }
          partialCount={quiz.questions.filter((q, i) => getAnswerReview?.(q, selectedAnswers[i])?.verdict === 'partial').length}
          uncertainCount={quiz.questions.filter((q, i) => getAnswerReview?.(q, selectedAnswers[i])?.verdict === 'uncertain').length}
          partialCredit={quiz.questions.reduce((total, q, i) => {
            const review = getAnswerReview?.(q, selectedAnswers[i])
            return total + (review?.verdict === 'partial' ? review.credit ?? 0 : 0)
          }, 0)}
          score={score}
          percentage={percentage}
          multipleChoiceScore={
            multipleChoiceScore
          }
          trueFalseScore={
            trueFalseScore
          }
          shortAnswerScore={
            shortAnswerScore
          }
          practiceMode={practiceMode}
          masteryContext={
            masteryContext
          }
          masteryDelta={masteryDelta}
          isSavingHistory={
            isSavingHistory
          }
          resultSaved={resultSaved}
          isWeakPracticeGenerating={
            isWeakPracticeGenerating
          }
          showPracticeTiming={showPracticeTiming}
          practiceTimingElapsedMs={practiceTimingElapsedMs}
          practiceTimingEstimate={practiceTimingEstimate}
          localBatchProgress={localBatchProgress}
          weakPracticeError={weakPracticeError}
          canCancelWeakPractice={
            canCancelWeakPractice
          }
          isGenerating={isGenerating}
          saveMessage={saveMessage}
          onSaveResult={onSaveResult}
          onRetryIncorrect={
            onRetryIncorrect
          }
          onPracticeWeakAreas={
            onPracticeWeakAreas
          }
          onCancelWeakPractice={
            onCancelWeakPractice
          }
          onTryAgain={onTryAgain}
          onGenerateNewQuiz={
            onGenerateNewQuiz
          }
          onUploadNewPdf={
            onUploadNewPdf
          }
        />
      )}
    </section>
  )
}

export default QuizSession
