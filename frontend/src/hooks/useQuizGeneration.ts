import { useState } from 'react'

import {
  apiFetch,
} from '../lib/api.ts'
import {
  requestQuizGeneration,
} from '../lib/quizGenerationClient.ts'
import type {
  GeneratedSettings,
  QuestionMode,
  QuizResult,
  UploadResult,
} from '../types/quiz.ts'

type GenerateQuizOptions = {
  beforeGenerate?: () => void
  afterGenerate?: () => void
}

type UseQuizGenerationOptions = {
  selectedFile: File | null
  documentResult: UploadResult | null
  setError: (message: string) => void
}

export function useQuizGeneration({
  selectedFile,
  documentResult,
  setError,
}: UseQuizGenerationOptions) {
  const [quiz, setQuiz] =
    useState<QuizResult | null>(null)
  const [
    generatedSettings,
    setGeneratedSettings,
  ] = useState<GeneratedSettings | null>(null)
  const [questionCount, setQuestionCount] =
    useState(5)
  const [difficulty, setDifficulty] =
    useState('medium')
  const [questionType, setQuestionType] =
    useState<QuestionMode>('multiple_choice')
  const [isGenerating, setIsGenerating] =
    useState(false)
  const [generationStage, setGenerationStage] =
    useState('')

  function resetQuizState() {
    setQuiz(null)
    setGeneratedSettings(null)
  }

  function clearQuiz() {
    setQuiz(null)
  }

  function resetSettings() {
    setQuestionCount(5)
    setDifficulty('medium')
    setQuestionType('multiple_choice')
    setGenerationStage('')
  }

  function clearGenerationStage() {
    setGenerationStage('')
  }

  function replaceGeneratedQuiz(
    nextQuiz: QuizResult,
    nextSettings: GeneratedSettings,
  ) {
    setQuiz(nextQuiz)
    setGeneratedSettings(nextSettings)
  }

  async function generateQuiz({
    beforeGenerate,
    afterGenerate,
  }: GenerateQuizOptions = {}) {
    if (!selectedFile) {
      setError('Please choose a PDF first.')
      return
    }

    if (!documentResult) {
      setError(
        'Process the PDF before generating a quiz.',
      )
      return
    }

    if (documentResult.scanned_likely) {
      setError(
        documentResult.warning ||
          'This PDF does not contain enough selectable text.',
      )
      return
    }

    const settingsForRequest:
      GeneratedSettings = {
        questionCount,
        difficulty,
        questionType,
      }

    setIsGenerating(true)
    setGenerationStage(
      'Analyzing document...',
    )
    setError('')
    beforeGenerate?.()

    const stageTimers: number[] = []

    stageTimers.push(
      window.setTimeout(() => {
        setGenerationStage(
          'Building questions...',
        )
      }, 1000),
    )
    stageTimers.push(
      window.setTimeout(() => {
        setGenerationStage(
          'Validating quiz...',
        )
      }, 3500),
    )

    try {
      const data =
        await requestQuizGeneration(
          apiFetch,
          {
            file: selectedFile,
            questionCount,
            difficulty,
            questionType,
          },
          'Quiz generation failed.',
        )

      setGenerationStage('Quiz ready!')
      setQuiz(data)
      setGeneratedSettings(
        settingsForRequest,
      )
      afterGenerate?.()
    } catch (caughtError) {
      setGenerationStage('')
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Something went wrong while generating the quiz.',
      )
    } finally {
      stageTimers.forEach((timer) =>
        window.clearTimeout(timer),
      )
      setIsGenerating(false)
      window.setTimeout(() => {
        setGenerationStage('')
      }, 900)
    }
  }

  return {
    quiz,
    generatedSettings,
    questionCount,
    difficulty,
    questionType,
    isGenerating,
    generationStage,
    setQuestionCount,
    setDifficulty,
    setQuestionType,
    generateQuiz,
    resetQuizState,
    clearQuiz,
    resetSettings,
    clearGenerationStage,
    replaceGeneratedQuiz,
  }
}
