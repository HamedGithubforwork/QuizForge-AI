import {
  useRef,
  useState,
  type ChangeEvent,
} from 'react'

import './App.css'

import QuizHistory from './QuizHistory.tsx'
import {
  saveQuizHistory,
} from './lib/quizHistory'

type PageResult = {
  page_number: number
  character_count: number
  preview: string
  text: string
}

type UploadResult = {
  filename: string
  page_count: number
  character_count: number
  extractable_page_count: number
  scanned_likely: boolean
  warning: string | null
  pages: PageResult[]
}

type QuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

type QuestionMode =
  | QuestionType
  | 'mixed'

type QuizQuestion = {
  question_type: QuestionType
  question: string
  choices: string[]
  correct_index: number
  correct_answer: string
  accepted_answers: string[]
  explanation: string
  source_pages: number[]
}

type QuizResult = {
  title: string
  questions: QuizQuestion[]
}

type GeneratedSettings = {
  questionCount: number
  difficulty: string
  questionType: QuestionMode
}

type PracticeFocus = {
  pages: number[]
  questionType: QuestionType
}

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
    useState<
      Record<number, number | string>
    >({})

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

  function getDisplayFilename(
    name: string,
  ) {
    try {
      return decodeURIComponent(name)
    } catch {
      return name
    }
  }

  function getQuestionTypeLabel(
    type: QuestionMode,
  ) {
    if (type === 'multiple_choice') {
      return 'Multiple Choice'
    }

    if (type === 'true_false') {
      return 'True / False'
    }

    if (type === 'short_answer') {
      return 'Short Answer'
    }

    return 'Mixed'
  }

  function normalizeAnswer(
    answer: string,
  ) {
    return answer
      .normalize('NFKD')
      .replace(
        /[\u0300-\u036f]/g,
        '',
      )
      .trim()
      .toLowerCase()
      .replace(/[-–—]/g, ' ')
      .replace(
        /[.,!?;:'"()[\]{}]/g,
        '',
      )
      .replace(/\s+/g, ' ')
  }

  function removeSimplePlural(
    answer: string,
  ) {
    const words =
      answer.split(' ')

    if (words.length === 0) {
      return answer
    }

    const lastIndex =
      words.length - 1

    const lastWord =
      words[lastIndex]

    if (
      lastWord.length > 3 &&
      lastWord.endsWith('s') &&
      !lastWord.endsWith('ss')
    ) {
      words[lastIndex] =
        lastWord.slice(0, -1)
    }

    return words.join(' ')
  }

  function escapeRegExp(
    value: string,
  ) {
    return value.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    )
  }

  function acceptedAnswerMatches(
    userAnswer: string,
    acceptedAnswer: string,
  ) {
    if (
      userAnswer === acceptedAnswer
    ) {
      return true
    }

    const userSingular =
      removeSimplePlural(
        userAnswer,
      )

    const acceptedSingular =
      removeSimplePlural(
        acceptedAnswer,
      )

    if (
      userSingular ===
      acceptedSingular
    ) {
      return true
    }

    const isSingleToken =
      acceptedAnswer.split(' ')
        .length === 1

    const isUsefulToken =
      acceptedAnswer.length >= 4 ||
      /^\d+$/.test(
        acceptedAnswer,
      )

    if (
      isSingleToken &&
      isUsefulToken
    ) {
      const escaped =
        escapeRegExp(
          acceptedAnswer,
        )

      const pattern =
        new RegExp(
          `(^|\\s)${escaped}($|\\s)`,
        )

      if (
        pattern.test(userAnswer)
      ) {
        return true
      }
    }

    return false
  }

  function isShortAnswerCorrect(
    question: QuizQuestion,
    answer: string,
  ) {
    const userAnswer =
      normalizeAnswer(answer)

    const acceptedAnswers = [
      question.correct_answer,
      ...question.accepted_answers,
    ]
      .map(normalizeAnswer)
      .filter(
        (
          value,
          index,
          array,
        ) =>
          value.length > 0 &&
          array.indexOf(value) ===
            index,
      )

    return acceptedAnswers.some(
      (acceptedAnswer) =>
        acceptedAnswerMatches(
          userAnswer,
          acceptedAnswer,
        ),
    )
  }

  function isQuestionCorrect(
    question: QuizQuestion,
    answer:
      | number
      | string
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

      return isShortAnswerCorrect(
        question,
        answer,
      )
    }

    return (
      typeof answer === 'number' &&
      answer ===
        question.correct_index
    )
  }

  function isQuestionAnswered(
    question: QuizQuestion,
    answer:
      | number
      | string
      | undefined,
  ) {
    if (
      question.question_type ===
      'short_answer'
    ) {
      return (
        typeof answer === 'string' &&
        answer.trim().length > 0
      )
    }

    return (
      typeof answer === 'number'
    )
  }

  function getScoreMessage(
    percentage: number,
  ) {
    if (percentage >= 90) {
      return 'Excellent work!'
    }

    if (percentage >= 75) {
      return 'Strong result!'
    }

    if (percentage >= 60) {
      return 'Good start — keep practicing.'
    }

    return 'Keep practicing — you are making progress.'
  }

  function resetPracticeMode() {
    setPracticeMode(false)
    setPracticeFocus(null)
  }

  function handleQuestionTypeChange(
    event:
      ChangeEvent<HTMLSelectElement>,
  ) {
    const value =
      event.target.value

    if (
      value ===
        'multiple_choice' ||
      value ===
        'true_false' ||
      value ===
        'short_answer' ||
      value === 'mixed'
    ) {
      setQuestionType(value)
    }
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
        await fetch(
          'http://127.0.0.1:8000/api/documents/upload',
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
        await fetch(
          'http://127.0.0.1:8000/api/quizzes/generate',
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
    answer:
      | number
      | string,
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

  function handleCheckAnswers() {
    if (!quiz) {
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
          firstUnansweredIndex +
          1
        } still needs an answer.`,
      )

      scrollToQuestion(
        firstUnansweredIndex,
        true,
      )

      return
    }

    setAttentionQuestionIndex(
      null,
    )

    setOpenSourceQuestionIndex(
      null,
    )

    setError('')
    setShowResults(true)

    setResultSaved(false)
    setSaveMessage('')

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
        await fetch(
          'http://127.0.0.1:8000/api/quizzes/generate',
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
          quiz,

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
            <h1>
              QuizForge AI
            </h1>

            <p className="subtitle">
              Turn your study
              material into an
              AI-generated practice
              quiz.
            </p>
          </div>
        </header>

        <section className="panel upload-panel">
          <div className="section-heading">
            <span className="step-number">
              1
            </span>

            <div>
              <h2>
                Upload your study
                material
              </h2>

              <p>
                Select a PDF
                containing your
                notes.
              </p>
            </div>
          </div>

          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept="application/pdf"
            onChange={
              handleFileChange
            }
          />

          {selectedFile && (
            <div className="selected-file">
              <span className="file-icon">
                PDF
              </span>

              <div>
                <strong>
                  {getDisplayFilename(
                    selectedFile.name,
                  )}
                </strong>

                <span>
                  {(
                    selectedFile.size /
                    1024 /
                    1024
                  ).toFixed(2)}{' '}
                  MB
                </span>
              </div>
            </div>
          )}

          <button
            className="button primary-button"
            type="button"
            onClick={
              handleProcessPdf
            }
            disabled={
              !selectedFile ||
              isProcessing
            }
          >
            {isProcessing
              ? 'Processing PDF...'
              : 'Process PDF'}
          </button>
        </section>

        {error && (
          <div
            className="error-message"
            role="alert"
          >
            <strong>
              Something went wrong
            </strong>

            <span>
              {error}
            </span>
          </div>
        )}

        {documentResult && (
          <>
            <section className="panel document-panel">
              <div className="success-header">
                <span className="success-icon">
                  ✓
                </span>

                <div>
                  <h2>
                    PDF processed
                    successfully
                  </h2>

                  <p>
                    Your document is
                    ready for quiz
                    generation.
                  </p>
                </div>
              </div>

              <div className="document-stats">
                <div className="stat-card">
                  <span className="stat-label">
                    File
                  </span>

                  <strong>
                    {getDisplayFilename(
                      documentResult.filename,
                    )}
                  </strong>
                </div>

                <div className="stat-card">
                  <span className="stat-label">
                    Pages
                  </span>

                  <strong>
                    {
                      documentResult.page_count
                    }
                  </strong>
                </div>

                <div className="stat-card">
                  <span className="stat-label">
                    Characters
                  </span>

                  <strong>
                    {documentResult
                      .character_count
                      .toLocaleString()}
                  </strong>
                </div>
              </div>

              {documentResult.warning && (
                <div className="scan-warning">
                  <strong>
                    Possible scanned
                    PDF
                  </strong>

                  <p>
                    {
                      documentResult.warning
                    }
                  </p>

                  <span>
                    Extractable
                    pages:{' '}
                    {
                      documentResult
                        .extractable_page_count
                    }{' '}
                    /{' '}
                    {
                      documentResult
                        .page_count
                    }
                  </span>
                </div>
              )}
            </section>

            <section className="panel settings-panel">
              <div className="section-heading">
                <span className="step-number">
                  2
                </span>

                <div>
                  <h2>
                    Quiz settings
                  </h2>

                  <p>
                    Choose how you
                    want your quiz
                    generated.
                  </p>
                </div>
              </div>

              <div className="settings-grid">
                <label className="setting-group">
                  <span>
                    Number of
                    questions
                  </span>

                  <select
                    value={
                      questionCount
                    }
                    onChange={(
                      event,
                    ) => {
                      setQuestionCount(
                        Number(
                          event.target
                            .value,
                        ),
                      )
                    }}
                    disabled={
                      isGenerating ||
                      isWeakPracticeGenerating
                    }
                  >
                    <option
                      value={5}
                    >
                      5 questions
                    </option>

                    <option
                      value={10}
                    >
                      10 questions
                    </option>

                    <option
                      value={15}
                    >
                      15 questions
                    </option>
                  </select>
                </label>

                <label className="setting-group">
                  <span>
                    Difficulty
                  </span>

                  <select
                    value={
                      difficulty
                    }
                    onChange={(
                      event,
                    ) => {
                      setDifficulty(
                        event.target
                          .value,
                      )
                    }}
                    disabled={
                      isGenerating ||
                      isWeakPracticeGenerating
                    }
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
                  <span>
                    Question type
                  </span>

                  <select
                    value={
                      questionType
                    }
                    onChange={
                      handleQuestionTypeChange
                    }
                    disabled={
                      isGenerating ||
                      isWeakPracticeGenerating
                    }
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

              {!quiz && (
                <>
                  <button
                    className="button primary-button generate-button"
                    type="button"
                    onClick={
                      handleGenerateQuiz
                    }
                    disabled={
                      isGenerating ||
                      isWeakPracticeGenerating ||
                      documentResult
                        .scanned_likely
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
                        {
                          generationStage
                        }
                      </strong>
                    </div>
                  )}
                </>
              )}
            </section>

            {quiz && (
              <section
                className="quiz-section"
                id="quiz-start"
              >
                <div className="quiz-header">
                  <div>
                    <span className="eyebrow">
                      AI-generated quiz
                    </span>

                    <h2>
                      {quiz.title}
                    </h2>
                  </div>

                  <div className="quiz-meta">
                    <span>
                      {
                        quiz.questions
                          .length
                      }{' '}
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
                          practiceFocus.questionType,
                        )}
                      </span>
                    </div>
                  )}

                {retryQuestionIndexes && (
                  <div className="retry-message">
                    Retrying{' '}
                    {
                      retryQuestionIndexes
                        .length
                    }{' '}
                    missed{' '}
                    {retryQuestionIndexes
                      .length === 1
                      ? 'question'
                      : 'questions'}
                  </div>
                )}

                <div className="progress-text">
                  {answeredCount} of{' '}
                  {
                    activeQuestionIndexes
                      .length
                  }{' '}
                  answered
                </div>

                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${
                        activeQuestionIndexes
                          .length > 0
                          ? (
                              answeredCount /
                              activeQuestionIndexes
                                .length
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
                      (
                        questionIndex,
                      ) => {
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

                        if (
                          showResults
                        ) {
                          navClass +=
                            correct
                              ? ' nav-correct'
                              : ' nav-incorrect'
                        } else if (
                          answered
                        ) {
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
                            key={
                              questionIndex
                            }
                            className={
                              navClass
                            }
                            type="button"
                            onClick={() => {
                              scrollToQuestion(
                                questionIndex,
                                true,
                              )
                            }}
                          >
                            {
                              questionIndex +
                              1
                            }
                          </button>
                        )
                      },
                    )}
                  </div>
                </nav>

                <div className="questions-list">
                  {activeQuestionIndexes.map(
                    (
                      questionIndex,
                    ) => {
                      const question =
                        quiz.questions[
                          questionIndex
                        ]

                      const selectedAnswer =
                        selectedAnswers[
                          questionIndex
                        ]

                      const isCorrect =
                        isQuestionCorrect(
                          question,
                          selectedAnswer,
                        )

                      const needsAttention =
                        attentionQuestionIndex ===
                        questionIndex

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
                          key={
                            questionIndex
                          }
                        >
                          <div className="question-card-top">
                            <div className="question-number">
                              Question{' '}
                              {
                                questionIndex +
                                1
                              }
                            </div>

                            <span className="question-type-badge">
                              {getQuestionTypeLabel(
                                question
                                  .question_type,
                              )}
                            </span>
                          </div>

                          <h3>
                            {
                              question.question
                            }
                          </h3>

                          {question.question_type !==
                            'short_answer' && (
                            <div className="answers-list">
                              {question.choices.map(
                                (
                                  choice,
                                  choiceIndex,
                                ) => {
                                  const isSelected =
                                    selectedAnswer ===
                                    choiceIndex

                                  const isCorrectChoice =
                                    question
                                      .correct_index ===
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
                                    optionClass +=
                                      ' selected'
                                  }

                                  if (
                                    showResults &&
                                    isCorrectChoice
                                  ) {
                                    optionClass +=
                                      ' correct'
                                  }

                                  if (
                                    isWrongSelection
                                  ) {
                                    optionClass +=
                                      ' incorrect'
                                  }

                                  return (
                                    <label
                                      className={
                                        optionClass
                                      }
                                      key={
                                        choiceIndex
                                      }
                                    >
                                      <input
                                        type="radio"
                                        name={`question-${questionIndex}`}
                                        checked={
                                          isSelected
                                        }
                                        onChange={() => {
                                          handleAnswerChange(
                                            questionIndex,
                                            choiceIndex,
                                          )
                                        }}
                                        disabled={
                                          showResults
                                        }
                                      />

                                      <span className="choice-letter">
                                        {question.question_type ===
                                        'true_false'
                                          ? choice ===
                                            'True'
                                            ? 'T'
                                            : 'F'
                                          : String.fromCharCode(
                                              65 +
                                                choiceIndex,
                                            )}
                                      </span>

                                      <span className="choice-text">
                                        {
                                          choice
                                        }
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
                                onChange={(
                                  event,
                                ) => {
                                  handleAnswerChange(
                                    questionIndex,
                                    event
                                      .target
                                      .value,
                                  )
                                }}
                                disabled={
                                  showResults
                                }
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
                                  <strong>
                                    Your
                                    answer:
                                  </strong>{' '}
                                  {typeof selectedAnswer ===
                                  'string'
                                    ? selectedAnswer
                                    : ''}
                                </p>
                              )}

                              {!isCorrect && (
                                <p>
                                  <strong>
                                    Correct
                                    answer:
                                  </strong>{' '}
                                  {
                                    question
                                      .correct_answer
                                  }
                                </p>
                              )}

                              {question.question_type ===
                                'short_answer' &&
                                isCorrect && (
                                  <p>
                                    <strong>
                                      Expected
                                      answer:
                                    </strong>{' '}
                                    {
                                      question
                                        .correct_answer
                                    }
                                  </p>
                                )}

                              <p>
                                {
                                  question
                                    .explanation
                                }
                              </p>

                              <div className="source-row">
                                <span className="source-badge">
                                  {question
                                    .source_pages
                                    .length ===
                                  1
                                    ? `Source: Page ${
                                        question
                                          .source_pages[0]
                                      }`
                                    : `Sources: Pages ${question.source_pages.join(
                                        ', ',
                                      )}`}
                                </span>

                                <button
                                  className="source-button"
                                  type="button"
                                  onClick={() => {
                                    setOpenSourceQuestionIndex(
                                      openSourceQuestionIndex ===
                                        questionIndex
                                        ? null
                                        : questionIndex,
                                    )
                                  }}
                                >
                                  {openSourceQuestionIndex ===
                                  questionIndex
                                    ? 'Hide Source'
                                    : 'View Source'}
                                </button>
                              </div>

                              {openSourceQuestionIndex ===
                                questionIndex && (
                                <div className="source-panel">
                                  {question.source_pages.map(
                                    (
                                      pageNumber,
                                    ) => {
                                      const sourcePage =
                                        documentResult.pages.find(
                                          (
                                            page,
                                          ) =>
                                            page.page_number ===
                                            pageNumber,
                                        )

                                      return (
                                        <div
                                          className="source-page"
                                          key={
                                            pageNumber
                                          }
                                        >
                                          <strong>
                                            Page{' '}
                                            {
                                              pageNumber
                                            }
                                          </strong>

                                          <p className="source-page-text">
                                            {sourcePage
                                              ?.text ||
                                              'Source text unavailable.'}
                                          </p>
                                        </div>
                                      )
                                    },
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </article>
                      )
                    },
                  )}
                </div>

                {!showResults && (
                  <button
                    className="button primary-button check-button"
                    type="button"
                    onClick={
                      handleCheckAnswers
                    }
                  >
                    Check Answers
                  </button>
                )}

                {showResults && (
                  <section
                    className="results-card"
                    id="quiz-results"
                  >
                    <span className="eyebrow">
                      Quiz complete
                    </span>

                    <div className="score-number">
                      {percentage}%
                    </div>

                    <h2>
                      {score} /{' '}
                      {
                        quiz.questions
                          .length
                      }{' '}
                      correct
                    </h2>

                    <p className="score-message">
                      {getScoreMessage(
                        percentage,
                      )}
                    </p>

                    <p className="incorrect-count">
                      You answered{' '}
                      {quiz.questions
                        .length -
                        score}{' '}
                      incorrectly.
                    </p>

                    <div className="score-breakdown">
                      {multipleChoiceScore.total >
                        0 && (
                        <div>
                          <span>
                            Multiple
                            Choice
                          </span>

                          <strong>
                            {
                              multipleChoiceScore
                                .correct
                            }{' '}
                            /{' '}
                            {
                              multipleChoiceScore
                                .total
                            }
                          </strong>
                        </div>
                      )}

                      {trueFalseScore.total >
                        0 && (
                        <div>
                          <span>
                            True / False
                          </span>

                          <strong>
                            {
                              trueFalseScore
                                .correct
                            }{' '}
                            /{' '}
                            {
                              trueFalseScore
                                .total
                            }
                          </strong>
                        </div>
                      )}

                      {shortAnswerScore.total >
                        0 && (
                        <div>
                          <span>
                            Short Answer
                          </span>

                          <strong>
                            {
                              shortAnswerScore
                                .correct
                            }{' '}
                            /{' '}
                            {
                              shortAnswerScore
                                .total
                            }
                          </strong>
                        </div>
                      )}
                    </div>

                    <div className="result-actions">

                      <button
                        className="button secondary-button"
                        type="button"
                        onClick={
                          handleSaveResult
                        }
                        disabled={
                          isSavingHistory ||
                          resultSaved
                        }
                      >
                        {isSavingHistory
                          ? 'Saving...'
                          : resultSaved
                            ? 'Saved ✓'
                            : 'Save Result'}
                      </button>

                      {score <
                        quiz.questions
                          .length && (
                        <button
                          className="button retry-button"
                          type="button"
                          onClick={
                            handleRetryIncorrect
                          }
                          disabled={
                            isWeakPracticeGenerating
                          }
                        >
                          Retry Incorrect
                        </button>
                      )}

                      {score <
                        quiz.questions
                          .length && (
                        <button
                          className="button weak-practice-button"
                          type="button"
                          onClick={
                            handlePracticeWeakAreas
                          }
                          disabled={
                            isWeakPracticeGenerating ||
                            isGenerating
                          }
                        >
                          {isWeakPracticeGenerating
                            ? 'Building Practice Quiz...'
                            : 'Practice Weak Areas'}
                        </button>
                      )}

                      <button
                        className="button secondary-button"
                        type="button"
                        onClick={
                          handleTryAgain
                        }
                        disabled={
                          isWeakPracticeGenerating
                        }
                      >
                        Try Again
                      </button>

                      <button
                        className="button primary-button"
                        type="button"
                        onClick={
                          handleGenerateNewQuiz
                        }
                        disabled={
                          isGenerating ||
                          isWeakPracticeGenerating
                        }
                      >
                        {isGenerating
                          ? 'Generating...'
                          : 'Generate New Quiz'}
                      </button>

                      <button
                        className="button ghost-button"
                        type="button"
                        onClick={
                          handleUploadNewPdf
                        }
                        disabled={
                          isWeakPracticeGenerating
                        }
                      >
                        Upload New PDF
                      </button>
                    </div>

                    {saveMessage && (
                      <p className="save-message">
                        {
                          saveMessage
                        }
                      </p>
                    )}
                  </section>
                )}
              </section>
            )}

            {!quiz && (
              <section className="panel previews-panel">
                <h2>
                  Page previews
                </h2>

                <div className="preview-grid">
                  {documentResult.pages.map(
                    (page) => (
                      <article
                        className="preview-card"
                        key={
                          page.page_number
                        }
                      >
                        <div className="preview-header">
                          <strong>
                            Page{' '}
                            {
                              page.page_number
                            }
                          </strong>

                          <span>
                            {page
                              .character_count
                              .toLocaleString()}{' '}
                            characters
                          </span>
                        </div>

                        <p>
                          {
                            page.preview
                          }
                        </p>
                      </article>
                    ),
                  )}
                </div>
              </section>
            )}
          </>
        )}

        <QuizHistory
          refreshKey={
            historyRefreshKey
          }
        />

      </div>
    </main>
  )
}

export default App
