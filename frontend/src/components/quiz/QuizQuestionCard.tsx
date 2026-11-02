import type { AiAnswerReviewDecision } from '../../lib/answerFallback.ts'
import {
  gradeShortAnswer,
} from '../../lib/shortAnswerGrader'
import {
  getQuestionTypeLabel,
} from '../../lib/quizPresentation'
import type {
  AnswerValue,
  QuizQuestion,
} from '../../types/quiz'
import SourcePageText from './SourcePageText.tsx'

type QuizQuestionCardProps = {
  question: QuizQuestion
  answerReview?: AiAnswerReviewDecision
  isReviewing?: boolean
  allowManualGrade?: boolean
  onManualGrade?: (index: number, verdict: 'correct' | 'partial' | 'incorrect') => void
  questionIndex: number
  selectedAnswer:
    | AnswerValue
    | undefined
  showResults: boolean
  needsAttention: boolean
  isCorrect: boolean
  isSourceOpen: boolean
  documentSha256: string
  onAnswerChange:
    (
      questionIndex: number,
      answer: AnswerValue,
    ) => void
  onToggleSource:
    (questionIndex: number) => void
}

function QuizQuestionCard({
  question,
  answerReview,
  isReviewing,
  allowManualGrade,
  onManualGrade,
  questionIndex,
  selectedAnswer,
  showResults,
  needsAttention,
  isCorrect,
  isSourceOpen,
  documentSha256,
  onAnswerChange,
  onToggleSource,
}: QuizQuestionCardProps) {
  const shortAnswerGrade =
    question.question_type ===
      'short_answer' &&
    typeof selectedAnswer === 'string'
      ? gradeShortAnswer(
          question,
          selectedAnswer,
        )
      : null

  return (
    <article
      id={`question-${questionIndex}`}
      className={
        `question-card ${
          needsAttention
            ? 'needs-attention'
            : ''
        }`
      }
    >
      <div className="question-card-top">
        <div className="question-number">
          Question {questionIndex + 1}
        </div>

        <span className="question-type-badge">
          {getQuestionTypeLabel(
            question.question_type,
          )}
        </span>
      </div>

      <h3>{question.question}</h3>

      {question.question_type !==
        'short_answer' && (
        <div className="answers-list">
          {question.choices.map(
            (choice, choiceIndex) => {
              const isSelected =
                selectedAnswer ===
                choiceIndex

              const isCorrectChoice =
                question.correct_index ===
                choiceIndex

              const isWrongSelection =
                showResults &&
                isSelected &&
                !isCorrectChoice

              let optionClass =
                'answer-option'

              if (
                isSelected &&
                !showResults
              ) {
                optionClass += ' selected'
              }

              if (
                showResults &&
                isCorrectChoice
              ) {
                optionClass += ' correct'
              }

              if (isWrongSelection) {
                optionClass += ' incorrect'
              }

              return (
                <label
                  className={optionClass}
                  key={choiceIndex}
                >
                  <input
                    type="radio"
                    name={`question-${questionIndex}`}
                    checked={isSelected}
                    onChange={() => {
                      onAnswerChange(
                        questionIndex,
                        choiceIndex,
                      )
                    }}
                    disabled={showResults || isReviewing}
                  />

                  <span className="choice-letter">
                    {question.question_type ===
                    'true_false'
                      ? choice === 'True'
                        ? 'T'
                        : 'F'
                      : String.fromCharCode(
                          65 + choiceIndex,
                        )}
                  </span>

                  <span className="choice-text">
                    {choice}
                  </span>

                  {showResults &&
                    isCorrectChoice && (
                      <span className="answer-symbol">
                        ✓
                      </span>
                    )}

                  {isWrongSelection && (
                    <span className="answer-symbol">
                      ✕
                    </span>
                  )}
                </label>
              )
            },
          )}
        </div>
      )}

      {question.question_type ===
        'short_answer' && (
        <div className="short-answer-area">
          <label
            htmlFor={`short-answer-${questionIndex}`}
          >
            Your answer
          </label>

          <input
            id={`short-answer-${questionIndex}`}
            className={
              'short-answer-input ' +
              (
                showResults
                  ? answerReview?.verdict === 'uncertain' || answerReview?.verdict === 'partial'
                    ? '' : isCorrect
                    ? 'correct-input'
                    : 'incorrect-input'
                  : ''
              )
            }
            maxLength={2000}
            type="text"
            placeholder="Type your answer..."
            value={
              typeof selectedAnswer ===
              'string'
                ? selectedAnswer
                : ''
            }
            onChange={(event) => {
              onAnswerChange(
                questionIndex,
                event.target.value,
              )
            }}
            disabled={showResults || isReviewing}
          />
        </div>
      )}

      {showResults && (
        <div
          className={
            `explanation ${
              answerReview?.verdict === 'uncertain' || answerReview?.verdict === 'partial'
                ? 'review-explanation' : isCorrect
                ? 'correct-explanation'
                : 'incorrect-explanation'
            }`
          }
        >
          <strong className="result-label">
            {answerReview?.verdict === 'uncertain' && answerReview.reason.startsWith('Waiting for Local AI') ? 'Waiting for Local AI'
              : answerReview?.verdict === 'uncertain' && answerReview.engine === 'manual' ? 'Awaiting your grade'
              : answerReview?.verdict === 'uncertain' ? 'Review needed'
              : answerReview?.verdict === 'partial' ? 'Partially correct'
              : isCorrect ? 'Correct — Full credit' : 'Incorrect'}
          </strong>

          {answerReview && <div className="answer-review-feedback">
            <p><strong>{answerReview.engine === 'manual' ? 'Self-check' : answerReview.engine === 'local' ? (answerReview.reason.startsWith('Local matching:') ? 'Local matching' : 'Local AI review') : 'AI review'}</strong></p>
            <p>{answerReview.reason}</p>
            {answerReview.concepts && answerReview.concepts.length > 0 && <>
              <p>{answerReview.concepts.filter(c => c.status === 'matched').length}/{answerReview.concepts.length} required concepts matched
                {answerReview.credit != null && ` · ${Math.round(answerReview.credit * 100)}% credit`}</p>
              <ul>{answerReview.concepts.map((concept, index) => <li key={index}>
                <strong>{concept.status === 'matched' ? '✓ Understood' : concept.status === 'missing' ? 'Missing' : 'Contradiction'}:</strong> {concept.concept}
                <blockquote>{concept.source_quote}</blockquote>
              </li>)}</ul>
            </>}
            <p>{answerReview.engine === 'manual' ? 'Marked by you · No AI grading' : answerReview.engine === 'local' ? (answerReview.reason.startsWith('Local matching:') ? 'Graded without Qwen · No cloud review request' : 'Local AI mode · No cloud review request') : 'Reviewed using Cloud AI'}</p>
            {answerReview.verdict === 'uncertain' && <p>No credit decision was made. Compare your answer with the cited source.</p>}
          </div>}

          {question.question_type ===
            'short_answer' && (
            <p>
              <strong>Your answer:</strong>{' '}
              {typeof selectedAnswer ===
              'string'
                ? selectedAnswer
                : ''}
            </p>
          )}

          {question.question_type ===
            'short_answer' &&
            shortAnswerGrade &&
            !isCorrect && !answerReview &&
            shortAnswerGrade.totalGroups >
              1 && (
              <p>
                <strong>
                  Concepts matched:
                </strong>{' '}
                {
                  shortAnswerGrade
                    .matchedGroups
                }{' '}
                /{' '}
                {
                  shortAnswerGrade
                    .requiredGroups
                }{' '}
                required
              </p>
            )}

          {question.question_type ===
            'short_answer' &&
            !answerReview && shortAnswerGrade?.borderline &&
            !isCorrect && (
              <p>
                The wording includes
                negation, so the answer
                could not be graded
                confidently as correct.
              </p>
            )}

          {!isCorrect && (
            <p>
              <strong>
                Correct answer:
              </strong>{' '}
              {question.correct_answer}
            </p>
          )}

          {question.question_type ===
            'short_answer' &&
            isCorrect && (
              <p>
                <strong>
                  Expected answer:
                </strong>{' '}
                {question.correct_answer}
              </p>
            )}

          <p>{question.explanation}</p>

          {question.question_type === 'short_answer' && allowManualGrade && (
            <div className="manual-short-grade" role="group" aria-label={`Grade short answer question ${questionIndex + 1}`}>
              <p><strong>Mark this answer yourself</strong> — compare it with the expected answer and source.</p>
              {(['correct', 'partial', 'incorrect'] as const).map(verdict => (
                <button key={verdict} type="button" className="button secondary-button"
                  aria-pressed={answerReview?.engine === 'manual' && answerReview.verdict === verdict}
                  onClick={() => onManualGrade?.(questionIndex, verdict)}>
                  {verdict === 'correct' ? 'Correct (100%)' : verdict === 'partial' ? 'Partial (50%)' : 'Incorrect (0%)'}
                </button>
              ))}
            </div>
          )}

          <div className="source-row">
            <span className="source-badge">
              {question.source_pages
                .length === 1
                ? `Source: Page ${
                    question.source_pages[0]
                  }`
                : `Sources: Pages ${question.source_pages.join(
                    ', ',
                  )}`}
            </span>

            <button
              className="source-button"
              type="button"
              onClick={() => {
                onToggleSource(
                  questionIndex,
                )
              }}
            >
              {isSourceOpen
                ? 'Hide Source'
                : 'View Source'}
            </button>
          </div>

          {isSourceOpen && (
            <div className="source-panel">
              {question.source_pages.map(
                (pageNumber) => (
                  <div
                    className="source-page"
                    key={pageNumber}
                  >
                    <strong>
                      Page {pageNumber}
                    </strong>

                    <SourcePageText
                      documentSha256={
                        documentSha256
                      }
                      pageNumber={
                        pageNumber
                      }
                    />
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export default QuizQuestionCard
