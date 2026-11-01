import { desktopBridge } from '../lib/desktop.ts'
import { reviewAnswersLocally } from '../lib/localAnswerReview.ts'
import { buildAiAnswerReviewKey } from '../lib/answerFallback.ts'
import {
  useState, useRef, useEffect,
} from 'react'

import {
  apiFetch,
} from '../lib/api.ts'
import {
  saveQuizHistory,
} from '../lib/quizHistory.ts'
import {
  buildAttemptReviewCases,
  buildQuizForHistory,
  calculateAttemptScore,
  getAttemptTypeScore,
  getIncorrectQuestionIndexes,
  isAttemptQuestionCorrect,
  mergeAttemptReviewDecisions,
  type AiGradeReviewMap,
} from '../lib/quizAttempt.ts'
import {
  isQuestionAnswered,
} from '../lib/quizPresentation.ts'
import type {
  AiAnswerReviewDecision,
} from '../lib/answerFallback.ts'
import type {
  AnswerValue,
  GeneratedSettings,
  QuestionType,
  QuizQuestion,
  QuizResult,
  UploadResult,
} from '../types/quiz.ts'

type UseQuizAttemptInput = {
  quiz: QuizResult | null
  documentResult: UploadResult | null
  generatedSettings: GeneratedSettings | null
  /** Local quizzes must never send a user's answer text to the cloud grader. */
  allowRemoteAnswerReview: boolean
  setError: (message: string) => void
  onHistorySaved: () => void
}

function scrollToQuestion(
  questionIndex: number,
  focusInput = false,
) {
  const questionElement =
    document.getElementById(
      `question-${questionIndex}`,
    )

  questionElement?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })

  if (!focusInput) {
    return
  }

  window.setTimeout(() => {
    const input =
      questionElement
        ?.querySelector<HTMLInputElement>(
          'input:not(:disabled)',
        )

    input?.focus({
      preventScroll: true,
    })
  }, 350)
}

export function useQuizAttempt({
  quiz,
  documentResult,
  generatedSettings,
  allowRemoteAnswerReview,
  setError,
  onHistorySaved,
}: UseQuizAttemptInput) {
  const [
    selectedAnswers,
    setSelectedAnswers,
  ] = useState<Record<number, AnswerValue>>(
    {},
  )
  const [showResults, setShowResults] =
    useState(false)
  const [
    retryQuestionIndexes,
    setRetryQuestionIndexes,
  ] = useState<number[] | null>(null)
  const [
    openSourceQuestionIndex,
    setOpenSourceQuestionIndex,
  ] = useState<number | null>(null)
  const [
    attentionQuestionIndex,
    setAttentionQuestionIndex,
  ] = useState<number | null>(null)
  const [
    isSavingHistory,
    setIsSavingHistory,
  ] = useState(false)
  const [resultSaved, setResultSaved] =
    useState(false)
  const [saveMessage, setSaveMessage] =
    useState('')
  const [
    aiGradeReviews,
    setAiGradeReviews,
  ] = useState<AiGradeReviewMap>({})
  const [
    isReviewingAnswers,
    setIsReviewingAnswers,
  ] = useState(false)

  const reviewEpoch = useRef(0)
  const reviewingRef = useRef(false)
  useEffect(() => {
    reviewEpoch.current += 1
    setAiGradeReviews({})
    return () => {
      reviewEpoch.current += 1
      if (reviewingRef.current && !allowRemoteAnswerReview) void desktopBridge()?.cancelLocalAiQuiz?.()
    }
  }, [quiz, allowRemoteAnswerReview])

  function isQuestionCorrect(
    question: QuizQuestion,
    answer: AnswerValue | undefined,
  ) {
    return isAttemptQuestionCorrect(
      question,
      answer,
      aiGradeReviews,
    )
  }

  function resetAttempt() {
    reviewEpoch.current += 1
    setAiGradeReviews({})
    setSelectedAnswers({})
    setShowResults(false)
    setRetryQuestionIndexes(null)
    setOpenSourceQuestionIndex(null)
    setAttentionQuestionIndex(null)
    setResultSaved(false)
    setSaveMessage('')
  }

  function clearSaveMessage() {
    setSaveMessage('')
  }

  function jumpToQuestion(
    questionIndex: number,
  ) {
    scrollToQuestion(
      questionIndex,
      true,
    )
  }

  function handleToggleSource(
    questionIndex: number,
  ) {
    setOpenSourceQuestionIndex(
      (current) =>
        current === questionIndex
          ? null
          : questionIndex,
    )
  }

  function handleAnswerChange(
    questionIndex: number,
    answer: AnswerValue,
  ) {
    if (reviewingRef.current) return
    setSelectedAnswers(
      (previous) => ({
        ...previous,
        [questionIndex]: answer,
      }),
    )

    if (
      attentionQuestionIndex ===
      questionIndex
    ) {
      setAttentionQuestionIndex(null)
    }

    setError('')
  }

  async function handleCheckAnswers() {
    if (!quiz || isReviewingAnswers) {
      return
    }

    const indexesToCheck =
      retryQuestionIndexes ??
      quiz.questions.map(
        (_, index) => index,
      )

    const firstUnansweredIndex =
      indexesToCheck.find(
        (questionIndex) =>
          !isQuestionAnswered(
            quiz.questions[questionIndex],
            selectedAnswers[questionIndex],
          ),
      )

    if (
      firstUnansweredIndex !== undefined
    ) {
      setAttentionQuestionIndex(
        firstUnansweredIndex,
      )
      setError(
        `Question ${
          firstUnansweredIndex + 1
        } still needs an answer.`,
      )
      scrollToQuestion(
        firstUnansweredIndex,
        true,
      )
      return
    }

    setAttentionQuestionIndex(null)
    setOpenSourceQuestionIndex(null)
    setError('')
    setSaveMessage('')

    const reviewCases = buildAttemptReviewCases(
            quiz,
            selectedAnswers,
            indexesToCheck,
            !allowRemoteAnswerReview,
          )

    if (reviewCases.length > 0) {
      setIsReviewingAnswers(true)
      reviewingRef.current = true
      const epoch = reviewEpoch.current

      try {
        let decisions: AiAnswerReviewDecision[]
        if (!allowRemoteAnswerReview) {
          decisions = await reviewAnswersLocally(desktopBridge(), reviewCases)
        } else {
          const response = await apiFetch('/api/answers/review', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cases: reviewCases }),
          })
          const data = await response.json() as { decisions?: AiAnswerReviewDecision[] }
          if (!response.ok) throw new Error('Answer review unavailable.')
          decisions = data.decisions ?? []
        }
        if (epoch !== reviewEpoch.current) return

        setAiGradeReviews(
          (previous) =>
            mergeAttemptReviewDecisions(
              previous,
              quiz,
              reviewCases,
              decisions,
            ),
        )

        setSaveMessage(
          `${!allowRemoteAnswerReview ? "Local AI: " : "Cloud AI: "}${decisions.length} short ${
            decisions.length === 1
              ? 'answer received'
              : 'answers received'
          } a semantic second review.`,
        )
      } catch {
        setSaveMessage(
          'Semantic second review was unavailable; deterministic grading was used.',
        )
      } finally {
        reviewingRef.current = false
        setIsReviewingAnswers(false)
      }
    }

    setShowResults(true)
    setResultSaved(false)

    window.setTimeout(() => {
      document
        .getElementById(
          'quiz-results',
        )
        ?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
    }, 100)
  }

  function handleTryAgain() {
    resetAttempt()
    setError('')

    window.setTimeout(() => {
      document
        .getElementById(
          'quiz-start',
        )
        ?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
    }, 50)
  }

  function handleRetryIncorrect() {
    if (!quiz) {
      return
    }

    const incorrectIndexes =
      getIncorrectQuestionIndexes(
        quiz,
        selectedAnswers,
        aiGradeReviews,
      )

    if (incorrectIndexes.length === 0) {
      return
    }

    setRetryQuestionIndexes(
      incorrectIndexes,
    )
    setSelectedAnswers(
      (previous) => {
        const next = {
          ...previous,
        }

        incorrectIndexes.forEach(
          (index) => {
            delete next[index]
          },
        )

        return next
      },
    )
    setShowResults(false)
    setOpenSourceQuestionIndex(null)
    setAttentionQuestionIndex(null)
    setResultSaved(false)
    setSaveMessage('')
    setError('')

    window.setTimeout(() => {
      scrollToQuestion(
        incorrectIndexes[0],
        true,
      )
    }, 100)
  }

  const activeQuestionIndexes =
    quiz
      ? (
          retryQuestionIndexes ??
          quiz.questions.map(
            (_, index) => index,
          )
        )
      : []

  const answeredCount =
    quiz
      ? activeQuestionIndexes.filter(
          (questionIndex) =>
            isQuestionAnswered(
              quiz.questions[questionIndex],
              selectedAnswers[questionIndex],
            ),
        ).length
      : 0

  const score =
    calculateAttemptScore(
      quiz,
      selectedAnswers,
      aiGradeReviews,
    )

  const percentage =
    quiz && quiz.questions.length > 0
      ? Math.round(
          (
            score /
            quiz.questions.length
          ) * 100,
        )
      : 0

  function getTypeScore(
    type: QuestionType,
  ) {
    return getAttemptTypeScore(
      quiz,
      type,
      selectedAnswers,
      aiGradeReviews,
    )
  }

  const multipleChoiceScore =
    getTypeScore('multiple_choice')
  const trueFalseScore =
    getTypeScore('true_false')
  const shortAnswerScore =
    getTypeScore('short_answer')

  async function handleSaveResult() {
    if (
      !quiz ||
      !documentResult ||
      !generatedSettings ||
      !showResults
    ) {
      return
    }

    setIsSavingHistory(true)
    setSaveMessage('')

    try {
      await saveQuizHistory({
        quizTitle: quiz.title,
        sourceFilename:
          documentResult.filename,
        difficulty:
          generatedSettings.difficulty,
        questionType:
          generatedSettings.questionType,
        questionCount:
          quiz.questions.length,
        score,
        percentage,
        quizData: buildQuizForHistory(
          quiz,
          selectedAnswers,
          aiGradeReviews,
        ),
        selectedAnswers,
      })

      setResultSaved(true)
      setSaveMessage(
        'Quiz result saved to your history.',
      )
      onHistorySaved()
    } catch (error) {
      setSaveMessage(
        error instanceof Error
          ? error.message
          : 'Could not save quiz result.',
      )
    } finally {
      setIsSavingHistory(false)
    }
  }

  return {
    aiGradeReviews,
    getAnswerReview: (question: QuizQuestion, answer: AnswerValue | undefined) =>
      typeof answer === 'string' ? aiGradeReviews[buildAiAnswerReviewKey(question, answer)] : undefined,
    selectedAnswers,
    showResults,
    retryQuestionIndexes,
    openSourceQuestionIndex,
    attentionQuestionIndex,
    isSavingHistory,
    resultSaved,
    saveMessage,
    isReviewingAnswers,
    activeQuestionIndexes,
    answeredCount,
    score,
    percentage,
    multipleChoiceScore,
    trueFalseScore,
    shortAnswerScore,
    isQuestionCorrect,
    resetAttempt,
    clearSaveMessage,
    jumpToQuestion,
    handleToggleSource,
    handleAnswerChange,
    handleCheckAnswers,
    handleTryAgain,
    handleRetryIncorrect,
    handleSaveResult,
  }
}
