import {
  useRef,
  useState,
  type ChangeEvent,
} from 'react'

import './App.css'

import QuizHistory, {
  type HistoryPracticeFocus,
} from './QuizHistory.tsx'
import DocumentPanel from './components/quiz/DocumentPanel.tsx'
import PagePreviews from './components/quiz/PagePreviews.tsx'
import QuizSession from './components/quiz/QuizSession.tsx'
import QuizSettingsPanel from './components/quiz/QuizSettingsPanel.tsx'
import UploadPanel from './components/quiz/UploadPanel.tsx'
import {
  saveQuizHistory,
} from './lib/quizHistory'
import {
  apiFetch,
} from './lib/api'
import {
  gradeShortAnswer,
} from './lib/shortAnswerGrader'
import {
  buildAiAnswerReviewCase,
  buildAiAnswerReviewKey,
  shouldRequestAiAnswerReview,
  type AiAnswerReviewDecision,
} from './lib/answerFallback'
import {
  isQuestionAnswered,
} from './lib/quizPresentation'
import type {
  AnswerValue,
  GeneratedSettings,
  MasteryContext,
  PracticeFocus,
  QuestionMode,
  QuestionType,
  QuizQuestion,
  QuizResult,
  UploadResult,
} from './types/quiz'

function App() {
  const fileInputRef =
    useRef<HTMLInputElement | null>(null)

  const [selectedFile, setSelectedFile] =
    useState<File | null>(null)

  const [documentResult, setDocumentResult] =
    useState<UploadResult | null>(null)

  const [quiz, setQuiz] =
    useState<QuizResult | null>(null)

  const [
    generatedSettings,
    setGeneratedSettings,
  ] =
    useState<GeneratedSettings | null>(
      null,
    )

  const [questionCount, setQuestionCount] =
    useState(5)

  const [difficulty, setDifficulty] =
    useState('medium')

  const [questionType, setQuestionType] =
    useState<QuestionMode>(
      'multiple_choice',
    )

  const [
    selectedAnswers,
    setSelectedAnswers,
  ] =
    useState<Record<number, AnswerValue>>(
      {},
    )

  const [showResults, setShowResults] =
    useState(false)

  const [isProcessing, setIsProcessing] =
    useState(false)

  const [isGenerating, setIsGenerating] =
    useState(false)

  const [
    generationStage,
    setGenerationStage,
  ] =
    useState('')

  const [
    retryQuestionIndexes,
    setRetryQuestionIndexes,
  ] =
    useState<number[] | null>(null)

  const [
    openSourceQuestionIndex,
    setOpenSourceQuestionIndex,
  ] =
    useState<number | null>(null)

  const [
    attentionQuestionIndex,
    setAttentionQuestionIndex,
  ] =
    useState<number | null>(null)

  const [error, setError] =
    useState('')

  const [
    isSavingHistory,
    setIsSavingHistory,
  ] =
    useState(false)

  const [resultSaved, setResultSaved] =
    useState(false)

  const [
    historyRefreshKey,
    setHistoryRefreshKey,
  ] =
    useState(0)

  const [saveMessage, setSaveMessage] =
    useState('')

  const [
    aiGradeReviews,
    setAiGradeReviews,
  ] = useState<
    Record<string, AiAnswerReviewDecision>
  >({})

  const [
    isReviewingAnswers,
    setIsReviewingAnswers,
  ] = useState(false)

  const [
    isWeakPracticeGenerating,
    setIsWeakPracticeGenerating,
  ] =
    useState(false)

  const [
    practiceMode,
    setPracticeMode,
  ] =
    useState(false)

  const [
    practiceFocus,
    setPracticeFocus,
  ] =
    useState<PracticeFocus | null>(
      null,
    )

  const [
    masteryContext,
    setMasteryContext,
  ] =
    useState<MasteryContext | null>(
      null,
    )

  function isShortAnswerCorrect(
    question: QuizQuestion,
    answer: string,
  ) {
    return gradeShortAnswer(
      question,
      answer,
    ).correct
  }

  function isQuestionCorrect(
    question: QuizQuestion,
    answer:
      | AnswerValue
      | undefined,
  ) {
    if (
      question.question_type ===
      'short_answer'
    ) {
      if (
        typeof answer !== 'string'
      ) {
        return false
      }

      if (
        isShortAnswerCorrect(
          question,
          answer,
        )
      ) {
        return true
      }

      const review =
        aiGradeReviews[
          buildAiAnswerReviewKey(
            question,
            answer,
          )
        ]

      return (
        review?.verdict === 'correct'
      )
    }

    return (
      typeof answer === 'number' &&
      answer ===
        question.correct_index
    )
  }

  function resetPracticeMode() {
    setPracticeMode(false)
    setPracticeFocus(null)
    setMasteryContext(null)
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

    if (focusInput) {
      setTimeout(() => {
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

  function handleFileChange(
    event:
      ChangeEvent<HTMLInputElement>,
  ) {
    const file =
      event.target.files?.[0] ??
      null

    setSelectedFile(file)

    setDocumentResult(null)
    setQuiz(null)
    setGeneratedSettings(null)

    setSelectedAnswers({})
    setShowResults(false)

    setRetryQuestionIndexes(null)
    setOpenSourceQuestionIndex(
      null,
    )
    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    resetPracticeMode()

    setGenerationStage('')
    setError('')
  }

  async function handleProcessPdf() {
    if (!selectedFile) {
      setError(
        'Please choose a PDF first.',
      )
      return
    }

    setIsProcessing(true)
    setError('')

    setDocumentResult(null)
    setQuiz(null)
    setGeneratedSettings(null)

    setSelectedAnswers({})
    setShowResults(false)

    setRetryQuestionIndexes(null)
    setOpenSourceQuestionIndex(
      null,
    )
    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    resetPracticeMode()

    try {
      const formData =
        new FormData()

      formData.append(
        'file',
        selectedFile,
      )

      const response =
        await apiFetch(
          '/api/documents/upload',
          {
            method: 'POST',
            body: formData,
          },
        )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'PDF processing failed.',
        )
      }

      setDocumentResult(data)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong while processing the PDF.',
      )
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleGenerateQuiz() {
    if (!selectedFile) {
      setError(
        'Please choose a PDF first.',
      )
      return
    }

    if (!documentResult) {
      setError(
        'Process the PDF before generating a quiz.',
      )
      return
    }

    if (
      documentResult.scanned_likely
    ) {
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
    setSelectedAnswers({})
    setShowResults(false)

    setRetryQuestionIndexes(null)
    setOpenSourceQuestionIndex(
      null,
    )
    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    resetPracticeMode()

    const stageTimers:
      number[] = []

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
      const formData =
        new FormData()

      formData.append(
        'file',
        selectedFile,
      )

      formData.append(
        'question_count',
        questionCount.toString(),
      )

      formData.append(
        'difficulty',
        difficulty,
      )

      formData.append(
        'question_type',
        questionType,
      )

      const response =
        await apiFetch(
          '/api/quizzes/generate',
          {
            method: 'POST',
            body: formData,
          },
        )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'Quiz generation failed.',
        )
      }

      setGenerationStage(
        'Quiz ready!',
      )

      setQuiz(data)

      setGeneratedSettings(
        settingsForRequest,
      )

      setTimeout(() => {
        document
          .getElementById(
            'quiz-start',
          )
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
    } catch (err) {
      setGenerationStage('')

      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong while generating the quiz.',
      )
    } finally {
      stageTimers.forEach(
        (timer) =>
          window.clearTimeout(
            timer,
          ),
      )

      setIsGenerating(false)

      window.setTimeout(() => {
        setGenerationStage('')
      }, 900)
    }
  }

  function handleAnswerChange(
    questionIndex: number,
    answer: AnswerValue,
  ) {
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
      setAttentionQuestionIndex(
        null,
      )
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
            quiz.questions[
              questionIndex
            ],
            selectedAnswers[
              questionIndex
            ],
          ),
      )

    if (
      firstUnansweredIndex !==
      undefined
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

    const reviewCases =
      indexesToCheck.flatMap(
        (questionIndex) => {
          const question =
            quiz.questions[
              questionIndex
            ]
          const answer =
            selectedAnswers[
              questionIndex
            ]

          if (
            question.question_type !==
              'short_answer' ||
            typeof answer !== 'string'
          ) {
            return []
          }

          const deterministicGrade =
            gradeShortAnswer(
              question,
              answer,
            )

          if (
            !shouldRequestAiAnswerReview(
              question,
              answer,
              deterministicGrade,
            )
          ) {
            return []
          }

          const reviewCase =
            buildAiAnswerReviewCase(
              questionIndex,
              question,
              answer,
            )

          return reviewCase
            ? [reviewCase]
            : []
        },
      )

    if (reviewCases.length > 0) {
      setIsReviewingAnswers(true)

      try {
        const response = await apiFetch(
          '/api/answers/review',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              cases: reviewCases,
            }),
          },
        )

        const data =
          await response.json() as {
            detail?: string
            decisions?:
              AiAnswerReviewDecision[]
          }

        if (!response.ok) {
          throw new Error(
            data.detail ||
              'Semantic answer review failed.',
          )
        }

        const decisions =
          data.decisions ?? []

        const casesByIndex =
          new Map(
            reviewCases.map(
              (item) => [
                item.question_index,
                item,
              ],
            ),
          )

        setAiGradeReviews(
          (previous) => {
            const next = {
              ...previous,
            }

            decisions.forEach(
              (decision) => {
                const reviewCase =
                  casesByIndex.get(
                    decision.question_index,
                  )

                const question =
                  quiz.questions[
                    decision.question_index
                  ]

                if (
                  !reviewCase ||
                  !question
                ) {
                  return
                }

                next[
                  buildAiAnswerReviewKey(
                    question,
                    reviewCase.student_answer,
                  )
                ] = decision
              },
            )

            return next
          },
        )

        setSaveMessage(
          `${decisions.length} borderline short ${
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
        setIsReviewingAnswers(false)
      }
    }

    setShowResults(true)
    setResultSaved(false)

    setTimeout(() => {
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
    setSelectedAnswers({})
    setShowResults(false)

    setRetryQuestionIndexes(null)

    setOpenSourceQuestionIndex(
      null,
    )

    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    setError('')

    setTimeout(() => {
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
      quiz.questions
        .map(
          (_, index) => index,
        )
        .filter(
          (index) =>
            !isQuestionCorrect(
              quiz.questions[
                index
              ],
              selectedAnswers[
                index
              ],
            ),
        )

    if (
      incorrectIndexes.length ===
      0
    ) {
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

    setOpenSourceQuestionIndex(
      null,
    )

    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    setError('')

    setTimeout(() => {
      scrollToQuestion(
        incorrectIndexes[0],
        true,
      )
    }, 100)
  }

  async function handlePracticeWeakAreas() {
    if (
      !quiz ||
      !selectedFile ||
      !showResults
    ) {
      return
    }

    const incorrectIndexes =
      quiz.questions
        .map(
          (_, index) => index,
        )
        .filter(
          (index) =>
            !isQuestionCorrect(
              quiz.questions[index],
              selectedAnswers[index],
            ),
        )

    if (
      incorrectIndexes.length ===
      0
    ) {
      setError(
        'You did not miss any questions.',
      )
      return
    }

    const weakPages =
      Array.from(
        new Set(
          incorrectIndexes.flatMap(
            (index) =>
              quiz.questions[index]
                .source_pages,
          ),
        ),
      ).sort(
        (a, b) => a - b,
      )

    const typeCounts:
      Record<QuestionType, number> = {
        multiple_choice: 0,
        true_false: 0,
        short_answer: 0,
      }

    incorrectIndexes.forEach(
      (index) => {
        const type =
          quiz.questions[index]
            .question_type

        typeCounts[type] += 1
      },
    )

    const weakQuestionType =
      (
        Object.entries(
          typeCounts,
        ) as [
          QuestionType,
          number,
        ][]
      ).sort(
        (a, b) =>
          b[1] - a[1],
      )[0][0]

    const missedQuestionText =
      incorrectIndexes.map(
        (index) =>
          quiz.questions[index]
            .question,
      )

    const baselineQuestions =
      quiz.questions
        .map((question, index) => ({
          question,
          answer: selectedAnswers[index],
        }))
        .filter(
          (item) =>
            item.question.question_type ===
            weakQuestionType,
        )

    const baselineScore =
      baselineQuestions.filter(
        (item) =>
          isQuestionCorrect(
            item.question,
            item.answer,
          ),
      ).length

    const baselineQuestionCount =
      baselineQuestions.length

    const baselinePercent =
      baselineQuestionCount > 0
        ? Math.round(
            (
              baselineScore /
              baselineQuestionCount
            ) * 100,
          )
        : 0

    const practiceDifficulty =
      generatedSettings
        ?.difficulty ??
      difficulty

    setIsWeakPracticeGenerating(
      true,
    )

    setError('')
    setSaveMessage('')

    try {
      const formData =
        new FormData()

      formData.append(
        'file',
        selectedFile,
      )

      formData.append(
        'question_count',
        '5',
      )

      formData.append(
        'difficulty',
        practiceDifficulty,
      )

      formData.append(
        'question_type',
        weakQuestionType,
      )

      formData.append(
        'focus_pages',
        weakPages.join(','),
      )

      formData.append(
        'focus_question_types',
        weakQuestionType,
      )

      formData.append(
        'avoid_questions',
        JSON.stringify(
          missedQuestionText,
        ),
      )

      const response =
        await apiFetch(
          '/api/quizzes/generate',
          {
            method: 'POST',
            body: formData,
          },
        )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'Weak-area practice generation failed.',
        )
      }

      setQuiz(data)

      setGeneratedSettings({
        questionCount:
          data.questions.length,

        difficulty:
          practiceDifficulty,

        questionType:
          weakQuestionType,
      })

      setSelectedAnswers({})

      setShowResults(false)

      setRetryQuestionIndexes(
        null,
      )

      setOpenSourceQuestionIndex(
        null,
      )

      setAttentionQuestionIndex(
        null,
      )

      setResultSaved(false)
      setSaveMessage('')

      setPracticeMode(true)

      setPracticeFocus({
        pages: weakPages,
        questionType:
          weakQuestionType,
      })

      setMasteryContext({
        baselinePercent,
        baselineQuestionCount,
        source:
          'current_quiz',
        pages: weakPages,
        questionType:
          weakQuestionType,
      })

      window.setTimeout(() => {
        document
          .getElementById(
            'quiz-start',
          )
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not generate weak-area practice.',
      )
    } finally {
      setIsWeakPracticeGenerating(
        false,
      )
    }
  }

  async function handleHistoryPracticeWeakAreas(
    focus: HistoryPracticeFocus,
  ) {
    if (
      !selectedFile ||
      !documentResult
    ) {
      setError(
        'Upload and process this PDF before generating history-based practice.',
      )
      return
    }

    if (
      documentResult.scanned_likely
    ) {
      setError(
        documentResult.warning ||
          'This PDF does not contain enough selectable text.',
      )
      return
    }

    const practiceDifficulty =
      generatedSettings
        ?.difficulty ??
      difficulty

    setIsWeakPracticeGenerating(
      true,
    )

    setError('')
    setSaveMessage('')

    try {
      const formData =
        new FormData()

      formData.append(
        'file',
        selectedFile,
      )

      formData.append(
        'question_count',
        '5',
      )

      formData.append(
        'difficulty',
        practiceDifficulty,
      )

      formData.append(
        'question_type',
        focus.questionType,
      )

      formData.append(
        'focus_pages',
        focus.pages.join(','),
      )

      formData.append(
        'focus_question_types',
        focus.questionType,
      )

      formData.append(
        'avoid_questions',
        JSON.stringify(
          focus.avoidQuestions,
        ),
      )

      const response =
        await apiFetch(
          '/api/quizzes/generate',
          {
            method: 'POST',
            body: formData,
          },
        )

      const data =
        await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'History-based weak-area practice generation failed.',
        )
      }

      setQuiz(data)

      setGeneratedSettings({
        questionCount:
          data.questions.length,
        difficulty:
          practiceDifficulty,
        questionType:
          focus.questionType,
      })

      setSelectedAnswers({})
      setShowResults(false)

      setRetryQuestionIndexes(
        null,
      )

      setOpenSourceQuestionIndex(
        null,
      )

      setAttentionQuestionIndex(
        null,
      )

      setResultSaved(false)
      setSaveMessage('')

      setPracticeMode(true)

      setPracticeFocus({
        pages: focus.pages,
        questionType:
          focus.questionType,
      })

      setMasteryContext({
        baselinePercent:
          focus.baselinePercent,
        baselineQuestionCount:
          focus.baselineQuestionCount,
        source: 'history',
        pages: focus.pages,
        questionType:
          focus.questionType,
      })

      window.setTimeout(() => {
        document
          .getElementById(
            'quiz-start',
          )
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not generate history-based weak-area practice.',
      )
    } finally {
      setIsWeakPracticeGenerating(
        false,
      )
    }
  }

  async function handleGenerateNewQuiz() {
    setError('')

    setSelectedAnswers({})
    setShowResults(false)

    setRetryQuestionIndexes(null)

    setOpenSourceQuestionIndex(
      null,
    )

    setAttentionQuestionIndex(
      null,
    )

    setResultSaved(false)
    setSaveMessage('')

    setQuiz(null)

    await handleGenerateQuiz()
  }

  function handleUploadNewPdf() {
    setSelectedFile(null)

    setDocumentResult(null)
    setQuiz(null)

    setGeneratedSettings(null)

    setSelectedAnswers({})

    setShowResults(false)

    setRetryQuestionIndexes(null)

    setOpenSourceQuestionIndex(
      null,
    )

    setAttentionQuestionIndex(
      null,
    )

    setQuestionCount(5)

    setDifficulty('medium')

    setQuestionType(
      'multiple_choice',
    )

    setResultSaved(false)
    setSaveMessage('')

    resetPracticeMode()

    setGenerationStage('')
    setError('')

    if (
      fileInputRef.current
    ) {
      fileInputRef.current.value =
        ''
    }

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
  }

  function calculateScore() {
    if (!quiz) {
      return 0
    }

    return quiz.questions.reduce(
      (
        currentScore,
        question,
        index,
      ) => {
        if (
          isQuestionCorrect(
            question,
            selectedAnswers[
              index
            ],
          )
        ) {
          return (
            currentScore + 1
          )
        }

        return currentScore
      },
      0,
    )
  }

  function getTypeScore(
    type: QuestionType,
  ) {
    if (!quiz) {
      return {
        correct: 0,
        total: 0,
      }
    }

    const matchingQuestions =
      quiz.questions
        .map(
          (
            question,
            index,
          ) => ({
            question,
            answer:
              selectedAnswers[
                index
              ],
          }),
        )
        .filter(
          (item) =>
            item.question
              .question_type ===
            type,
        )

    const correct =
      matchingQuestions.filter(
        (item) =>
          isQuestionCorrect(
            item.question,
            item.answer,
          ),
      ).length

    return {
      correct,
      total:
        matchingQuestions.length,
    }
  }

  const activeQuestionIndexes =
    quiz
      ? (
          retryQuestionIndexes ??
          quiz.questions.map(
            (_, index) =>
              index,
          )
        )
      : []

  const answeredCount =
    quiz
      ? activeQuestionIndexes.filter(
          (questionIndex) =>
            isQuestionAnswered(
              quiz.questions[
                questionIndex
              ],
              selectedAnswers[
                questionIndex
              ],
            ),
        ).length
      : 0

  const score =
    calculateScore()

  const percentage =
    quiz &&
    quiz.questions.length > 0
      ? Math.round(
          (
            score /
            quiz.questions.length
          ) * 100,
        )
      : 0

  const masteryDelta =
    masteryContext
      ? percentage -
        masteryContext.baselinePercent
      : 0

  const multipleChoiceScore =
    getTypeScore(
      'multiple_choice',
    )

  const trueFalseScore =
    getTypeScore(
      'true_false',
    )

  const shortAnswerScore =
    getTypeScore(
      'short_answer',
    )

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

    const quizDataForHistory = {
      ...quiz,
      questions:
        quiz.questions.map(
          (
            question,
            questionIndex,
          ) => {
            const answer =
              selectedAnswers[
                questionIndex
              ]

            if (
              question.question_type !==
                'short_answer' ||
              typeof answer !== 'string'
            ) {
              return question
            }

            const review =
              aiGradeReviews[
                buildAiAnswerReviewKey(
                  question,
                  answer,
                )
              ]

            if (
              review?.verdict !==
              'correct'
            ) {
              return question
            }

            return {
              ...question,
              ai_accepted_answers:
                Array.from(
                  new Set([
                    ...(
                      question
                        .ai_accepted_answers ??
                      []
                    ),
                    answer,
                  ]),
                ),
            }
          },
        ),
    }

    try {
      await saveQuizHistory({
        quizTitle:
          quiz.title,

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

        quizData:
          quizDataForHistory,

        selectedAnswers,
      })

      setResultSaved(true)

      setSaveMessage(
        'Quiz result saved to your history.',
      )

      setHistoryRefreshKey(
        (previous) =>
          previous + 1,
      )
    } catch (err) {
      setSaveMessage(
        err instanceof Error
          ? err.message
          : 'Could not save quiz result.',
      )
    } finally {
      setIsSavingHistory(false)
    }
  }

  return (
    <main className="app-shell">
      <div className="app-container">
        <header className="app-header">
          <div className="logo">
            QF
          </div>

          <div>
            <h1>QuizForge AI</h1>

            <p className="subtitle">
              Turn your study material
              into an AI-generated
              practice quiz.
            </p>
          </div>
        </header>

        <UploadPanel
          fileInputRef={fileInputRef}
          selectedFile={selectedFile}
          isProcessing={isProcessing}
          onFileChange={handleFileChange}
          onProcessPdf={handleProcessPdf}
        />

        {error && (
          <div
            className="error-message"
            role="alert"
          >
            <strong>
              Something went wrong
            </strong>

            <span>{error}</span>
          </div>
        )}

        {documentResult && (
          <>
            <DocumentPanel
              documentResult={
                documentResult
              }
            />

            <QuizSettingsPanel
              questionCount={
                questionCount
              }
              difficulty={difficulty}
              questionType={questionType}
              hasQuiz={Boolean(quiz)}
              isGenerating={isGenerating}
              isWeakPracticeGenerating={
                isWeakPracticeGenerating
              }
              scannedLikely={
                documentResult
                  .scanned_likely
              }
              generationStage={
                generationStage
              }
              onQuestionCountChange={
                setQuestionCount
              }
              onDifficultyChange={
                setDifficulty
              }
              onQuestionTypeChange={
                setQuestionType
              }
              onGenerateQuiz={
                handleGenerateQuiz
              }
            />

            {quiz ? (
              <QuizSession
                quiz={quiz}
                documentResult={
                  documentResult
                }
                generatedSettings={
                  generatedSettings
                }
                selectedAnswers={
                  selectedAnswers
                }
                showResults={showResults}
                retryQuestionIndexes={
                  retryQuestionIndexes
                }
                attentionQuestionIndex={
                  attentionQuestionIndex
                }
                openSourceQuestionIndex={
                  openSourceQuestionIndex
                }
                practiceMode={
                  practiceMode
                }
                practiceFocus={
                  practiceFocus
                }
                activeQuestionIndexes={
                  activeQuestionIndexes
                }
                answeredCount={
                  answeredCount
                }
                score={score}
                percentage={percentage}
                masteryContext={
                  masteryContext
                }
                masteryDelta={
                  masteryDelta
                }
                multipleChoiceScore={
                  multipleChoiceScore
                }
                trueFalseScore={
                  trueFalseScore
                }
                shortAnswerScore={
                  shortAnswerScore
                }
                isReviewingAnswers={
                  isReviewingAnswers
                }
                isSavingHistory={
                  isSavingHistory
                }
                resultSaved={
                  resultSaved
                }
                isWeakPracticeGenerating={
                  isWeakPracticeGenerating
                }
                isGenerating={
                  isGenerating
                }
                saveMessage={
                  saveMessage
                }
                isQuestionCorrect={
                  isQuestionCorrect
                }
                onJumpQuestion={
                  (questionIndex) => {
                    scrollToQuestion(
                      questionIndex,
                      true,
                    )
                  }
                }
                onAnswerChange={
                  handleAnswerChange
                }
                onToggleSource={
                  handleToggleSource
                }
                onCheckAnswers={
                  handleCheckAnswers
                }
                onSaveResult={
                  handleSaveResult
                }
                onRetryIncorrect={
                  handleRetryIncorrect
                }
                onPracticeWeakAreas={
                  handlePracticeWeakAreas
                }
                onTryAgain={
                  handleTryAgain
                }
                onGenerateNewQuiz={
                  handleGenerateNewQuiz
                }
                onUploadNewPdf={
                  handleUploadNewPdf
                }
              />
            ) : (
              <PagePreviews
                documentResult={
                  documentResult
                }
              />
            )}
          </>
        )}

        <QuizHistory
          refreshKey={
            historyRefreshKey
          }
          currentFilename={
            selectedFile?.name ?? null
          }
          canPracticeCurrentDocument={
            Boolean(
              selectedFile &&
              documentResult &&
              !documentResult.scanned_likely,
            )
          }
          isPracticeGenerating={
            isWeakPracticeGenerating
          }
          onPracticeWeakAreas={
            handleHistoryPracticeWeakAreas
          }
        />
      </div>
    </main>
  )
}

export default App
