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
  useQuizAttempt,
} from './hooks/useQuizAttempt.ts'
import {
  apiFetch,
} from './lib/api.ts'
import type {
  GeneratedSettings,
  MasteryContext,
  PracticeFocus,
  QuestionMode,
  QuestionType,
  QuizResult,
  UploadResult,
} from './types/quiz.ts'

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
  ] = useState<GeneratedSettings | null>(null)
  const [questionCount, setQuestionCount] =
    useState(5)
  const [difficulty, setDifficulty] =
    useState('medium')
  const [questionType, setQuestionType] =
    useState<QuestionMode>('multiple_choice')
  const [isProcessing, setIsProcessing] =
    useState(false)
  const [isGenerating, setIsGenerating] =
    useState(false)
  const [generationStage, setGenerationStage] =
    useState('')
  const [error, setError] = useState('')
  const [
    historyRefreshKey,
    setHistoryRefreshKey,
  ] = useState(0)
  const [
    isWeakPracticeGenerating,
    setIsWeakPracticeGenerating,
  ] = useState(false)
  const [practiceMode, setPracticeMode] =
    useState(false)
  const [practiceFocus, setPracticeFocus] =
    useState<PracticeFocus | null>(null)
  const [masteryContext, setMasteryContext] =
    useState<MasteryContext | null>(null)

  const attempt = useQuizAttempt({
    quiz,
    documentResult,
    generatedSettings,
    setError,
    onHistorySaved: () => {
      setHistoryRefreshKey(
        (previous) => previous + 1,
      )
    },
  })

  function resetPracticeMode() {
    setPracticeMode(false)
    setPracticeFocus(null)
    setMasteryContext(null)
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file =
      event.target.files?.[0] ?? null

    setSelectedFile(file)
    setDocumentResult(null)
    setQuiz(null)
    setGeneratedSettings(null)
    attempt.resetAttempt()
    resetPracticeMode()
    setGenerationStage('')
    setError('')
  }

  async function handleProcessPdf() {
    if (!selectedFile) {
      setError('Please choose a PDF first.')
      return
    }

    setIsProcessing(true)
    setError('')
    setDocumentResult(null)
    setQuiz(null)
    setGeneratedSettings(null)
    attempt.resetAttempt()
    resetPracticeMode()

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)

      const response = await apiFetch(
        '/api/documents/upload',
        {
          method: 'POST',
          body: formData,
        },
      )
      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'PDF processing failed.',
        )
      }

      setDocumentResult(data)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Something went wrong while processing the PDF.',
      )
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleGenerateQuiz() {
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
    attempt.resetAttempt()
    resetPracticeMode()

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
      const formData = new FormData()
      formData.append('file', selectedFile)
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

      const response = await apiFetch(
        '/api/quizzes/generate',
        {
          method: 'POST',
          body: formData,
        },
      )
      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          data.detail ||
            'Quiz generation failed.',
        )
      }

      setGenerationStage('Quiz ready!')
      setQuiz(data)
      setGeneratedSettings(
        settingsForRequest,
      )

      window.setTimeout(() => {
        document
          .getElementById('quiz-start')
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
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

  async function handlePracticeWeakAreas() {
    if (
      !quiz ||
      !selectedFile ||
      !attempt.showResults
    ) {
      return
    }

    const incorrectIndexes =
      quiz.questions
        .map((_, index) => index)
        .filter(
          (index) =>
            !attempt.isQuestionCorrect(
              quiz.questions[index],
              attempt.selectedAnswers[index],
            ),
        )

    if (incorrectIndexes.length === 0) {
      setError(
        'You did not miss any questions.',
      )
      return
    }

    const weakPages = Array.from(
      new Set(
        incorrectIndexes.flatMap(
          (index) =>
            quiz.questions[index]
              .source_pages,
        ),
      ),
    ).sort((a, b) => a - b)

    const typeCounts:
      Record<QuestionType, number> = {
        multiple_choice: 0,
        true_false: 0,
        short_answer: 0,
      }

    incorrectIndexes.forEach((index) => {
      typeCounts[
        quiz.questions[index].question_type
      ] += 1
    })

    const weakQuestionType = (
      Object.entries(typeCounts) as [
        QuestionType,
        number,
      ][]
    ).sort(
      (first, second) =>
        second[1] - first[1],
    )[0][0]

    const missedQuestionText =
      incorrectIndexes.map(
        (index) =>
          quiz.questions[index].question,
      )

    const baselineQuestions =
      quiz.questions
        .map((question, index) => ({
          question,
          answer:
            attempt.selectedAnswers[index],
        }))
        .filter(
          (item) =>
            item.question.question_type ===
            weakQuestionType,
        )

    const baselineScore =
      baselineQuestions.filter((item) =>
        attempt.isQuestionCorrect(
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
      generatedSettings?.difficulty ??
      difficulty

    setIsWeakPracticeGenerating(true)
    setError('')
    attempt.clearSaveMessage()

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      formData.append('question_count', '5')
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

      const response = await apiFetch(
        '/api/quizzes/generate',
        {
          method: 'POST',
          body: formData,
        },
      )
      const data = await response.json()

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
      attempt.resetAttempt()
      setPracticeMode(true)
      setPracticeFocus({
        pages: weakPages,
        questionType:
          weakQuestionType,
      })
      setMasteryContext({
        baselinePercent,
        baselineQuestionCount,
        source: 'current_quiz',
        pages: weakPages,
        questionType:
          weakQuestionType,
      })

      window.setTimeout(() => {
        document
          .getElementById('quiz-start')
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not generate weak-area practice.',
      )
    } finally {
      setIsWeakPracticeGenerating(false)
    }
  }

  async function handleHistoryPracticeWeakAreas(
    focus: HistoryPracticeFocus,
  ) {
    if (!selectedFile || !documentResult) {
      setError(
        'Upload and process this PDF before generating history-based practice.',
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

    const practiceDifficulty =
      generatedSettings?.difficulty ??
      difficulty

    setIsWeakPracticeGenerating(true)
    setError('')
    attempt.clearSaveMessage()

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      formData.append('question_count', '5')
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

      const response = await apiFetch(
        '/api/quizzes/generate',
        {
          method: 'POST',
          body: formData,
        },
      )
      const data = await response.json()

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
      attempt.resetAttempt()
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
          .getElementById('quiz-start')
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          })
      }, 150)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not generate history-based weak-area practice.',
      )
    } finally {
      setIsWeakPracticeGenerating(false)
    }
  }

  async function handleGenerateNewQuiz() {
    setError('')
    setQuiz(null)
    await handleGenerateQuiz()
  }

  function handleUploadNewPdf() {
    setSelectedFile(null)
    setDocumentResult(null)
    setQuiz(null)
    setGeneratedSettings(null)
    attempt.resetAttempt()
    setQuestionCount(5)
    setDifficulty('medium')
    setQuestionType('multiple_choice')
    resetPracticeMode()
    setGenerationStage('')
    setError('')

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
  }

  const masteryDelta =
    masteryContext
      ? attempt.percentage -
        masteryContext.baselinePercent
      : 0

  return (
    <main className="app-shell">
      <div className="app-container">
        <header className="app-header">
          <div className="logo">QF</div>
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
              questionCount={questionCount}
              difficulty={difficulty}
              questionType={questionType}
              hasQuiz={Boolean(quiz)}
              isGenerating={isGenerating}
              isWeakPracticeGenerating={
                isWeakPracticeGenerating
              }
              scannedLikely={
                documentResult.scanned_likely
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
                  attempt.selectedAnswers
                }
                showResults={
                  attempt.showResults
                }
                retryQuestionIndexes={
                  attempt.retryQuestionIndexes
                }
                attentionQuestionIndex={
                  attempt.attentionQuestionIndex
                }
                openSourceQuestionIndex={
                  attempt.openSourceQuestionIndex
                }
                practiceMode={practiceMode}
                practiceFocus={practiceFocus}
                activeQuestionIndexes={
                  attempt.activeQuestionIndexes
                }
                answeredCount={
                  attempt.answeredCount
                }
                score={attempt.score}
                percentage={
                  attempt.percentage
                }
                masteryContext={
                  masteryContext
                }
                masteryDelta={masteryDelta}
                multipleChoiceScore={
                  attempt.multipleChoiceScore
                }
                trueFalseScore={
                  attempt.trueFalseScore
                }
                shortAnswerScore={
                  attempt.shortAnswerScore
                }
                isReviewingAnswers={
                  attempt.isReviewingAnswers
                }
                isSavingHistory={
                  attempt.isSavingHistory
                }
                resultSaved={
                  attempt.resultSaved
                }
                isWeakPracticeGenerating={
                  isWeakPracticeGenerating
                }
                isGenerating={isGenerating}
                saveMessage={
                  attempt.saveMessage
                }
                isQuestionCorrect={
                  attempt.isQuestionCorrect
                }
                onJumpQuestion={
                  attempt.jumpToQuestion
                }
                onAnswerChange={
                  attempt.handleAnswerChange
                }
                onToggleSource={
                  attempt.handleToggleSource
                }
                onCheckAnswers={
                  attempt.handleCheckAnswers
                }
                onSaveResult={
                  attempt.handleSaveResult
                }
                onRetryIncorrect={
                  attempt.handleRetryIncorrect
                }
                onPracticeWeakAreas={
                  handlePracticeWeakAreas
                }
                onTryAgain={
                  attempt.handleTryAgain
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
          refreshKey={historyRefreshKey}
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
