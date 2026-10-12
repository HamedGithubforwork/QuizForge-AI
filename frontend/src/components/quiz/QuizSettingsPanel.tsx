import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api.ts'

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
  const staging = import.meta.env.VITE_COGNITO_STAGING === 'true'
  const [allowance, setAllowance] = useState<{
    remaining: number
    allowance: number
  } | null>(null)
  const [allowanceUnavailable, setAllowanceUnavailable] = useState(false)
  const refreshAllowance = useCallback(async () => {
    if (!staging) return
    try {
      const response = await apiFetch('/api/staging/ai-budget')
      if (!response.ok) throw new Error('Allowance unavailable')
      const data = await response.json() as {
        remaining?: number
        allowance?: number
      }
      if (typeof data.remaining !== 'number' ||
          !Number.isInteger(data.remaining) ||
          data.allowance !== 10 ||
          data.remaining < 0 || data.remaining > 10) {
        throw new Error('Unexpected allowance response')
      }
      setAllowance({ remaining: data.remaining, allowance: 10 })
      setAllowanceUnavailable(false)
    } catch {
      setAllowance(null)
      setAllowanceUnavailable(true)
    }
  }, [staging])

  useEffect(() => {
    void refreshAllowance()
  }, [refreshAllowance, isGenerating])

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

      {staging && (
        <p className="staging-allowance" role="status">
          {allowance
            ? `Staging AI requests remaining: ${allowance.remaining} / ${allowance.allowance}`
            : allowanceUnavailable
              ? 'Staging AI request count unavailable'
              : 'Checking staging AI allowance...'}
          <button type="button" onClick={() => void refreshAllowance()}>
            Refresh count
          </button>
        </p>
      )}

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
            <div
              className="generation-status"
              role="status"
              aria-live="polite"
            >
              <span
                className="loading-spinner"
                aria-hidden="true"
              />

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
