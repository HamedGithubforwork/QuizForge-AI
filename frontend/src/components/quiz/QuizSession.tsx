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
import QuizQuestionCard from './QuizQuestionCard.tsx'
import QuizResultsCard from './QuizResultsCard.tsx'

type QuizSessionProps = {
  quiz: QuizResult
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
  isReviewingAnswers: boolean
  isSavingHistory: boolean
  resultSaved: boolean
  isWeakPracticeGenerating: boolean
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
  onTryAgain: () => void
  onGenerateNewQuiz: () => void
  onUploadNewPdf: () => void
}

function QuizSession({
  quiz,
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
  isReviewingAnswers,
  isSavingHistory,
  resultSaved,
  isWeakPracticeGenerating,
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
  onTryAgain,
  onGenerateNewQuiz,
  onUploadNewPdf,
}: QuizSessionProps) {
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
                navClass += correct
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

      <div className="questions-list">
        {activeQuestionIndexes.map(
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
                documentPages={
                  documentResult.pages
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
          questionCount={
            quiz.questions.length
          }
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
          isGenerating={isGenerating}
          saveMessage={saveMessage}
          onSaveResult={onSaveResult}
          onRetryIncorrect={
            onRetryIncorrect
          }
          onPracticeWeakAreas={
            onPracticeWeakAreas
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
