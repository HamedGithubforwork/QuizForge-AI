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
                    disabled={showResults}
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
                  ? isCorrect
                    ? 'correct-input'
                    : 'incorrect-input'
                  : ''
              )
            }
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
            disabled={showResults}
          />
        </div>
      )}

      {showResults && (
        <div
          className={
            `explanation ${
              isCorrect
                ? 'correct-explanation'
                : 'incorrect-explanation'
            }`
          }
        >
          <strong className="result-label">
            {isCorrect
              ? 'Correct'
              : 'Incorrect'}
          </strong>

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
            !isCorrect &&
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
            shortAnswerGrade?.borderline &&
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
