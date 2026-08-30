import type {
  QuestionMode,
} from '../../types/quiz'

type QuizSettingsPanelProps = {
  questionCount: number
  difficulty: string
  questionType: QuestionMode
  hasQuiz: boolean
  isGenerating: boolean
  isWeakPracticeGenerating: boolean
  scannedLikely: boolean
  generationStage: string
  onQuestionCountChange:
    (value: number) => void
  onDifficultyChange:
    (value: string) => void
  onQuestionTypeChange:
    (value: QuestionMode) => void
  onGenerateQuiz: () => void
}

function QuizSettingsPanel({
  questionCount,
  difficulty,
  questionType,
  hasQuiz,
  isGenerating,
  isWeakPracticeGenerating,
  scannedLikely,
  generationStage,
  onQuestionCountChange,
  onDifficultyChange,
  onQuestionTypeChange,
  onGenerateQuiz,
}: QuizSettingsPanelProps) {
  const settingsDisabled =
    isGenerating ||
    isWeakPracticeGenerating

  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <span className="step-number">
          2
        </span>

        <div>
          <h2>Quiz settings</h2>

          <p>
            Choose how you want your quiz
            generated.
          </p>
        </div>
      </div>

      <div className="settings-grid">
        <label className="setting-group">
          <span>Number of questions</span>

          <select
            value={questionCount}
            onChange={(event) => {
              onQuestionCountChange(
                Number(event.target.value),
              )
            }}
            disabled={settingsDisabled}
          >
            <option value={5}>
              5 questions
            </option>
            <option value={10}>
              10 questions
            </option>
            <option value={15}>
              15 questions
            </option>
          </select>
        </label>

        <label className="setting-group">
          <span>Difficulty</span>

          <select
            value={difficulty}
            onChange={(event) => {
              onDifficultyChange(
                event.target.value,
              )
            }}
            disabled={settingsDisabled}
          >
            <option value="easy">
              Easy
            </option>
            <option value="medium">
              Medium
            </option>
            <option value="hard">
              Hard
            </option>
          </select>
        </label>

        <label className="setting-group">
          <span>Question type</span>

          <select
            value={questionType}
            onChange={(event) => {
              const value =
                event.target.value

              if (
                value ===
                  'multiple_choice' ||
                value === 'true_false' ||
                value === 'short_answer' ||
                value === 'mixed'
              ) {
                onQuestionTypeChange(value)
              }
            }}
            disabled={settingsDisabled}
          >
            <option value="multiple_choice">
              Multiple Choice
            </option>
            <option value="true_false">
              True / False
            </option>
            <option value="short_answer">
              Short Answer
            </option>
            <option value="mixed">
              Mixed
            </option>
          </select>
        </label>
      </div>

      {!hasQuiz && (
        <>
          <button
            className="button primary-button generate-button"
            type="button"
            onClick={onGenerateQuiz}
            disabled={
              isGenerating ||
              isWeakPracticeGenerating ||
              scannedLikely
            }
          >
            {isGenerating
              ? 'Generating...'
              : 'Generate Quiz'}
          </button>

          {generationStage && (
            <div className="generation-status">
              <span className="loading-spinner" />

              <strong>
                {generationStage}
              </strong>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default QuizSettingsPanel
