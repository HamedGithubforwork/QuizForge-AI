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
  const [shortAnswerReviewMode, setShortAnswerReviewMode] =
    useState<'local-ai' | 'manual'>('local-ai')
  const [answerReviewProgress, setAnswerReviewProgress] =
    useState<{ completed: number; total: number } | null>(null)

  const reviewEpoch = useRef(0)
  const reviewingRef = useRef(false)
  useEffect(() => {
    reviewEpoch.current += 1
    reviewingRef.current = false
    setIsReviewingAnswers(false)
    setAnswerReviewProgress(null)
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
    if (reviewingRef.current && !allowRemoteAnswerReview) {
      void desktopBridge()?.cancelLocalAiQuiz?.()
    }
    reviewingRef.current = false
    setIsReviewingAnswers(false)
    setAiGradeReviews({})
    setAnswerReviewProgress(null)
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

  function setManualShortAnswerGrade(questionIndex: number, verdict: 'correct' | 'partial' | 'incorrect') {
    if (!quiz || !showResults || isReviewingAnswers || allowRemoteAnswerReview) return
    const question = quiz.questions[questionIndex]
    const answer = selectedAnswers[questionIndex]
    if (question?.question_type !== 'short_answer' || typeof answer !== 'string') return
    const key = buildAiAnswerReviewKey(question, answer)
    setAiGradeReviews(previous => ({
      ...previous,
      [key]: {
        question_index: questionIndex,
        engine: 'manual',
        verdict,
        confidence: 1,
        credit: verdict === 'correct' ? 1 : verdict === 'partial' ? 0.5 : 0,
        reason: 'Self-graded against the expected answer and source.',
        concepts: [],
      },
    }))
    setResultSaved(false)
    setSaveMessage('')
  }

  async function handleCheckAnswers() {
    if (!quiz || isReviewingAnswers) return

    const indexesToCheck = retryQuestionIndexes ?? quiz.questions.map((_, index) => index)
    const firstUnansweredIndex = indexesToCheck.find(
      index => !isQuestionAnswered(quiz.questions[index], selectedAnswers[index]),
    )
    if (firstUnansweredIndex !== undefined) {
      setAttentionQuestionIndex(firstUnansweredIndex)
      setError(`Question ${firstUnansweredIndex + 1} still needs an answer.`)
      scrollToQuestion(firstUnansweredIndex, true)
      return
    }

    setAttentionQuestionIndex(null)
    setOpenSourceQuestionIndex(null)
    setError('')
    setSaveMessage('')
    setResultSaved(false)

    const local = !allowRemoteAnswerReview
    const manual = local && shortAnswerReviewMode === 'manual'
    const shortAnswerIndexes = indexesToCheck.filter(
      index => quiz.questions[index]?.question_type === 'short_answer' &&
        typeof selectedAnswers[index] === 'string',
    )
    const reviewCases = manual ? [] : buildAttemptReviewCases(
      quiz, selectedAnswers, indexesToCheck, local,
    )
    const awaiting = manual ? shortAnswerIndexes : reviewCases.map(item => item.question_index)
    const epoch = reviewEpoch.current

    if (local) {
      // Show multiple-choice and true/false answers immediately. Short answers
      // awaiting a human or Qwen decision are NOT counted as incorrect.
      setAiGradeReviews(previous => {
        const next = { ...previous }
        for (const index of awaiting) {
          const question = quiz.questions[index]
          const answer = selectedAnswers[index]
          if (typeof answer !== 'string') continue
          next[buildAiAnswerReviewKey(question, answer)] = {
            question_index: index, engine: manual ? 'manual' : 'local',
            verdict: 'uncertain', confidence: 0, credit: null, concepts: [],
            reason: manual
              ? 'Not graded yet. Compare your answer with the expected answer and source below.'
              : 'Waiting for Local AI review. This answer is not marked incorrect.',
          }
        }
        return next
      })
      setShowResults(true)
      setAnswerReviewProgress({ completed: 0, total: awaiting.length })
      window.setTimeout(() => {
        document.getElementById('quiz-results')?.scrollIntoView({
          behavior: 'smooth', block: 'center',
        })
      }, 100)
      if (manual) {
        setSaveMessage('Multiple-choice and true/false questions were graded immediately. Mark each short answer yourself; no Local AI grading was requested.')
        return
      }
    }

    if (reviewCases.length > 0) {
      setIsReviewingAnswers(true)
      reviewingRef.current = true
      let timer: ReturnType<typeof setInterval> | null = null
      if (local && desktopBridge()?.localAiAnswerReviewProgress) {
        let polling = false
        timer = setInterval(() => {
          if (polling || epoch !== reviewEpoch.current) return
          polling = true
          void desktopBridge()?.localAiAnswerReviewProgress?.().then(progress => {
            if (!progress || epoch !== reviewEpoch.current) return
            const decisions = progress.decisions.filter(
              d => reviewCases.some(c => c.question_index === d.question_index),
            )
            setAnswerReviewProgress({ completed: decisions.length, total: reviewCases.length })
            if (decisions.length) {
              setAiGradeReviews(previous =>
                mergeAttemptReviewDecisions(previous, quiz, reviewCases, decisions))
            }
          }).catch(() => {}).finally(() => { polling = false })
        }, 750)
      }

      try {
        let decisions: AiAnswerReviewDecision[]
        if (local) {
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
        setAiGradeReviews(previous =>
          mergeAttemptReviewDecisions(previous, quiz, reviewCases, decisions))
        setAnswerReviewProgress({ completed: decisions.length, total: reviewCases.length })
        setSaveMessage(`${local ? 'Local AI' : 'Cloud AI'} reviewed ${decisions.length} short ${decisions.length === 1 ? 'answer' : 'answers'}. Any uncertain answers can be checked manually.`)
      } catch {
        if (epoch === reviewEpoch.current) {
          setSaveMessage(local
            ? 'Local AI review was interrupted. You can check the remaining short answers manually.'
            : 'Semantic review was unavailable; deterministic grading was used.')
        }
      } finally {
        if (timer !== null) clearInterval(timer)
        if (epoch === reviewEpoch.current) {
          reviewingRef.current = false
          setIsReviewingAnswers(false)
        }
      }
    }

    if (!local && epoch === reviewEpoch.current) {
      setShowResults(true)
      window.setTimeout(() => {
        document.getElementById('quiz-results')?.scrollIntoView({
          behavior: 'smooth', block: 'center',
        })
      }, 100)
    }
  }

  function stopLocalAnswerReview() {
    if (allowRemoteAnswerReview || !isReviewingAnswers || !quiz) return
    reviewEpoch.current += 1
    reviewingRef.current = false
    setIsReviewingAnswers(false)
    setAnswerReviewProgress(null)
    setAiGradeReviews(previous => {
      const next = { ...previous }
      quiz.questions.forEach((question, index) => {
        const answer = selectedAnswers[index]
        if (question.question_type !== 'short_answer' || typeof answer !== 'string') return
        const key = buildAiAnswerReviewKey(question, answer)
        if (next[key]?.verdict === 'uncertain' &&
            next[key]?.reason.startsWith('Waiting for Local AI')) {
          next[key] = { ...next[key],
            reason: 'Local AI review was stopped. Compare this answer with the source and grade it manually.' }
        }
      })
      return next
    })
    setSaveMessage('Local AI review stopped. Completed grades remain visible; mark any remaining uncertain short answers yourself.')
    void desktopBridge()?.cancelLocalAiQuiz?.().catch(() => {})
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
    if (!quiz || isReviewingAnswers) {
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
      !showResults ||
      isReviewingAnswers ||
      (!allowRemoteAnswerReview && quiz.questions.some((question, index) =>
        question.question_type === 'short_answer' &&
        typeof selectedAnswers[index] === 'string' &&
        aiGradeReviews[buildAiAnswerReviewKey(question, selectedAnswers[index] as string)]?.verdict === 'uncertain'))
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
    shortAnswerReviewMode,
    setShortAnswerReviewMode,
    answerReviewProgress,
    setManualShortAnswerGrade,
    stopLocalAnswerReview,
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
