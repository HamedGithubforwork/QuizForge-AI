import {
  useState,
} from 'react'

import QuizHistoryAnalytics from './components/history/QuizHistoryAnalytics.tsx'
import QuizHistoryList from './components/history/QuizHistoryList.tsx'
import {
  useQuizHistoryData,
} from './hooks/useQuizHistoryData.ts'
import {
  buildCurrentDocumentSummary,
  type HistoryPracticeFocus,
} from './lib/quizHistoryAnalytics.ts'

import './QuizHistory.css'

export type {
  HistoryPracticeFocus,
} from './lib/quizHistoryAnalytics.ts'

type QuizHistoryProps = {
  refreshKey: number
  currentFilename?: string | null
  canPracticeCurrentDocument?: boolean
  isPracticeGenerating?: boolean
  onPracticeWeakAreas?: (
    focus: HistoryPracticeFocus,
  ) => void | Promise<void>
}

function QuizHistory({
  refreshKey,
  currentFilename = null,
  canPracticeCurrentDocument = false,
  isPracticeGenerating = false,
  onPracticeWeakAreas,
}: QuizHistoryProps) {
  const [expanded, setExpanded] =
    useState(false)
  const [
    isHistoryPracticeGenerating,
    setIsHistoryPracticeGenerating,
  ] = useState(false)

  const {
    history,
    documentHistory,
    totalHistoryCount,
    hasMoreHistory,
    loading,
    loadingMore,
    error,
    loadMoreError,
    historyLoaded,
    canPracticeHistory,
    currentDocumentSha256,
    enableHistory,
    loadMore,
    removeHistoryItem,
  } = useQuizHistoryData({
    refreshKey,
    currentFilename,
    canPracticeCurrentDocument,
  })

  const currentDocumentSummary =
    buildCurrentDocumentSummary(
      currentFilename,
      documentHistory,
    )

  async function handleHistoryPractice() {
    const weakness =
      currentDocumentSummary?.weakness

    if (
      !weakness ||
      !onPracticeWeakAreas ||
      !canPracticeHistory ||
      isHistoryPracticeGenerating ||
      isPracticeGenerating
    ) {
      return
    }

    setIsHistoryPracticeGenerating(true)

    try {
      await onPracticeWeakAreas({
        pages: weakness.pages,
        questionType:
          weakness.questionType,
        avoidQuestions:
          weakness.avoidQuestions,
        baselinePercent:
          weakness.baselinePercent,
        baselineQuestionCount:
          weakness.baselineQuestionCount,
      })
    } finally {
      setIsHistoryPracticeGenerating(false)
    }
  }

  return (
    <section className="history-section">
      <button
        className="history-toggle"
        type="button"
        onClick={() => {
          enableHistory()
          setExpanded(
            (previous) => !previous,
          )
        }}
      >
        <div>
          <strong>My Quiz History</strong>
          <span>
            {historyLoaded ? (
              <>
                {totalHistoryCount}{' '}
                {totalHistoryCount === 1
                  ? 'saved quiz'
                  : 'saved quizzes'}
              </>
            ) : (
              'Open to load saved quizzes'
            )}
          </span>
        </div>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="history-content">
          {loading && (
            <p className="history-status">
              Loading history...
            </p>
          )}

          {error && (
            <div className="history-error">
              {error}
            </div>
          )}

          {!loading &&
            !error &&
            history.length === 0 && (
              <div className="history-empty">
                <strong>
                  No saved quizzes yet
                </strong>
                <p>
                  Finish a quiz and click Save
                  Result to add it here.
                </p>
              </div>
            )}

          {!loading &&
            !error &&
            history.length > 0 && (
              <>
                <QuizHistoryAnalytics
                  history={history}
                  documentHistory={
                    documentHistory
                  }
                  totalHistoryCount={
                    totalHistoryCount
                  }
                  hasMoreHistory={
                    hasMoreHistory
                  }
                  currentFilename={
                    currentFilename
                  }
                  currentDocumentSha256={
                    currentDocumentSha256
                  }
                  currentDocumentSummary={
                    currentDocumentSummary
                  }
                  canPracticeHistory={
                    canPracticeHistory
                  }
                  isHistoryPracticeGenerating={
                    isHistoryPracticeGenerating
                  }
                  isPracticeGenerating={
                    isPracticeGenerating
                  }
                  practiceAvailable={Boolean(
                    onPracticeWeakAreas,
                  )}
                  onPractice={
                    handleHistoryPractice
                  }
                />

                <QuizHistoryList
                  history={history}
                  totalHistoryCount={
                    totalHistoryCount
                  }
                  loadMoreError={
                    loadMoreError
                  }
                  hasMoreHistory={
                    hasMoreHistory
                  }
                  loadingMore={loadingMore}
                  onDelete={
                    removeHistoryItem
                  }
                  onLoadMore={loadMore}
                />
              </>
            )}
        </div>
      )}
    </section>
  )
}

export default QuizHistory
