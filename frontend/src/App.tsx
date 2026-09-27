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
  useQuizGeneration,
} from './hooks/useQuizGeneration.ts'
import {
  apiFetch,
} from './lib/api.ts'
import {
  requestQuizGeneration,
} from './lib/quizGenerationClient.ts'
import {
  buildCurrentQuizPracticeFocus,
} from './lib/currentQuizPractice.ts'
import type {
  MasteryContext,
  PracticeFocus,
  QuestionType,
  UploadResult,
} from './types/quiz.ts'

type WeakPracticeRequest = {
  pages: number[]
  questionType: QuestionType
  avoidQuestions: string[]
  baselinePercent: number
  baselineQuestionCount: number
  source: MasteryContext['source']
  responseError: string
  fallbackError: string
}

function scrollToQuiz() {
  window.setTimeout(() => {
    document
      .getElementById('quiz-start')
      ?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
  }, 150)
}

function App() {
  const fileInputRef =
    useRef<HTMLInputElement | null>(null)

  const [selectedFile, setSelectedFile] =
    useState<File | null>(null)
  const [documentResult, setDocumentResult] =
    useState<UploadResult | null>(null)
  const [isProcessing, setIsProcessing] =
    useState(false)
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

  const generation = useQuizGeneration({
    selectedFile,
    documentResult,
    setError,
  })

  const attempt = useQuizAttempt({
    quiz: generation.quiz,
    documentResult,
    generatedSettings:
      generation.generatedSettings,
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

  function resetProcessedDocument() {
    setDocumentResult(null)
    generation.resetQuizState()
    attempt.resetAttempt()
    resetPracticeMode()
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file =
      event.target.files?.[0] ?? null

    setSelectedFile(file)
    resetProcessedDocument()
    generation.clearGenerationStage()
    setError('')
  }

  async function handleProcessPdf() {
    if (!selectedFile) {
      setError('Please choose a PDF first.')
      return
    }

    setIsProcessing(true)
    resetProcessedDocument()

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
    await generation.generateQuiz({
      beforeGenerate: () => {
        attempt.resetAttempt()
        resetPracticeMode()
      },
      afterGenerate: scrollToQuiz,
    })
  }

  async function generateWeakAreaPractice({
    pages,
    questionType: practiceQuestionType,
    avoidQuestions,
    baselinePercent,
    baselineQuestionCount,
    source,
    responseError,
    fallbackError,
  }: WeakPracticeRequest) {
    if (!selectedFile) {
      return
    }

    const practiceDifficulty =
      generation.generatedSettings
        ?.difficulty ??
      generation.difficulty

    setIsWeakPracticeGenerating(true)
    setError('')
    attempt.clearSaveMessage()

    try {
      const data =
        await requestQuizGeneration(
          apiFetch,
          {
            file: selectedFile,
            questionCount: 5,
            difficulty:
              practiceDifficulty,
            questionType:
              practiceQuestionType,
            focusPages: pages,
            focusQuestionTypes: [
              practiceQuestionType,
            ],
            avoidQuestions,
          },
          responseError,
        )

      generation.replaceGeneratedQuiz(
        data,
        {
          questionCount:
            data.questions.length,
          difficulty:
            practiceDifficulty,
          questionType:
            practiceQuestionType,
        },
      )
      attempt.resetAttempt()
      setPracticeMode(true)
      setPracticeFocus({
        pages,
        questionType:
          practiceQuestionType,
      })
      setMasteryContext({
        baselinePercent,
        baselineQuestionCount,
        source,
        pages,
        questionType:
          practiceQuestionType,
      })
      scrollToQuiz()
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : fallbackError,
      )
    } finally {
      setIsWeakPracticeGenerating(false)
    }
  }

  async function handlePracticeWeakAreas() {
    if (
      !generation.quiz ||
      !selectedFile ||
      !attempt.showResults
    ) {
      return
    }

    const focus =
      buildCurrentQuizPracticeFocus(
        generation.quiz,
        attempt.selectedAnswers,
        attempt.isQuestionCorrect,
      )

    if (!focus) {
      setError(
        'You did not miss any questions.',
      )
      return
    }

    await generateWeakAreaPractice({
      ...focus,
      source: 'current_quiz',
      responseError:
        'Weak-area practice generation failed.',
      fallbackError:
        'Could not generate weak-area practice.',
    })
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

    await generateWeakAreaPractice({
      pages: focus.pages,
      questionType:
        focus.questionType,
      avoidQuestions:
        focus.avoidQuestions,
      baselinePercent:
        focus.baselinePercent,
      baselineQuestionCount:
        focus.baselineQuestionCount,
      source: 'history',
      responseError:
        'History-based weak-area practice generation failed.',
      fallbackError:
        'Could not generate history-based weak-area practice.',
    })
  }

  async function handleGenerateNewQuiz() {
    setError('')
    generation.clearQuiz()
    await handleGenerateQuiz()
  }

  function handleUploadNewPdf() {
    setSelectedFile(null)
    resetProcessedDocument()
    generation.resetSettings()
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
              questionCount={
                generation.questionCount
              }
              difficulty={
                generation.difficulty
              }
              questionType={
                generation.questionType
              }
              hasQuiz={Boolean(
                generation.quiz,
              )}
              isGenerating={
                generation.isGenerating
              }
              isWeakPracticeGenerating={
                isWeakPracticeGenerating
              }
              scannedLikely={
                documentResult.scanned_likely
              }
              generationStage={
                generation.generationStage
              }
              onQuestionCountChange={
                generation.setQuestionCount
              }
              onDifficultyChange={
                generation.setDifficulty
              }
              onQuestionTypeChange={
                generation.setQuestionType
              }
              onGenerateQuiz={
                handleGenerateQuiz
              }
            />

            {generation.quiz ? (
              <QuizSession
                quiz={generation.quiz}
                documentResult={
                  documentResult
                }
                generatedSettings={
                  generation.generatedSettings
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
                isGenerating={
                  generation.isGenerating
                }
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
