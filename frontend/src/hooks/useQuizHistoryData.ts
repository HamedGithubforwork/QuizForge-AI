import {
  useEffect,
  useState,
} from 'react'

import {
  deleteQuizHistory,
  getQuizHistoryForDocument,
  getQuizHistoryPage,
  type QuizHistoryRow,
} from '../lib/quizHistory.ts'
import {
  getCurrentDocumentSha256,
} from '../lib/documentIdentity.ts'
import {
  appendUniqueHistoryRows,
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
  type QuizHistoryCursor,
} from '../lib/quizHistoryPagination.ts'

type UseQuizHistoryDataInput = {
  refreshKey: number
  currentFilename: string | null
  canPracticeCurrentDocument: boolean
}

export function useQuizHistoryData({
  refreshKey,
  currentFilename,
  canPracticeCurrentDocument,
}: UseQuizHistoryDataInput) {
  const [history, setHistory] =
    useState<QuizHistoryRow[]>([])
  const [documentHistory, setDocumentHistory] =
    useState<QuizHistoryRow[]>([])
  const [totalHistoryCount, setTotalHistoryCount] =
    useState(0)
  const [hasMoreHistory, setHasMoreHistory] =
    useState(false)
  const [
    nextHistoryCursor,
    setNextHistoryCursor,
  ] = useState<QuizHistoryCursor | null>(null)
  const [loading, setLoading] =
    useState(true)
  const [loadingMore, setLoadingMore] =
    useState(false)
  const [error, setError] =
    useState('')
  const [loadMoreError, setLoadMoreError] =
    useState('')
  const [historyEnabled, setHistoryEnabled] =
    useState(false)
  const [historyLoaded, setHistoryLoaded] =
    useState(false)
  const [
    practiceReadyFilename,
    setPracticeReadyFilename,
  ] = useState<string | null>(null)

  useEffect(() => {
    if (
      canPracticeCurrentDocument &&
      currentFilename
    ) {
      setPracticeReadyFilename(
        currentFilename,
      )
      return
    }

    if (!currentFilename) {
      setPracticeReadyFilename(null)
      return
    }

    if (
      practiceReadyFilename &&
      practiceReadyFilename !== currentFilename
    ) {
      setPracticeReadyFilename(null)
    }
  }, [
    canPracticeCurrentDocument,
    currentFilename,
    practiceReadyFilename,
  ])

  const canPracticeHistory = Boolean(
    currentFilename &&
      practiceReadyFilename === currentFilename,
  )

  const currentDocumentSha256 =
    canPracticeCurrentDocument
      ? getCurrentDocumentSha256(
          currentFilename,
        )
      : null

  useEffect(() => {
    if (!historyEnabled) {
      return
    }

    let cancelled = false

    async function loadFirstPage() {
      setLoading(true)
      setError('')
      setLoadMoreError('')
      setHasMoreHistory(false)
      setNextHistoryCursor(null)

      try {
        const page =
          await getQuizHistoryPage()

        if (cancelled) {
          return
        }

        setHistory(page.items)
        if (page.totalCount !== null) {
          setTotalHistoryCount(
            page.totalCount,
          )
        }
        setHasMoreHistory(page.hasMore)
        setNextHistoryCursor(
          page.nextCursor,
        )
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Could not load quiz history.',
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setHistoryLoaded(true)
        }
      }
    }

    void loadFirstPage()

    return () => {
      cancelled = true
    }
  }, [historyEnabled, refreshKey])

  useEffect(() => {
    if (!historyEnabled) {
      return
    }

    let cancelled = false

    async function loadCurrentDocumentHistory() {
      if (!currentFilename) {
        setDocumentHistory([])
        return
      }

      try {
        const rows =
          await getQuizHistoryForDocument({
            sourceFilename: currentFilename,
            documentSha256:
              currentDocumentSha256,
            limit:
              DOCUMENT_HISTORY_ANALYSIS_LIMIT,
          })

        if (!cancelled) {
          setDocumentHistory(rows)
        }
      } catch {
        if (!cancelled) {
          setDocumentHistory([])
        }
      }
    }

    void loadCurrentDocumentHistory()

    return () => {
      cancelled = true
    }
  }, [
    currentDocumentSha256,
    currentFilename,
    historyEnabled,
    refreshKey,
  ])

  async function loadMore() {
    if (
      loadingMore ||
      !hasMoreHistory ||
      !nextHistoryCursor
    ) {
      return
    }

    setLoadingMore(true)
    setLoadMoreError('')

    try {
      const page =
        await getQuizHistoryPage({
          cursor: nextHistoryCursor,
        })

      setHistory((previous) =>
        appendUniqueHistoryRows(
          previous,
          page.items,
        ),
      )
      setHasMoreHistory(page.hasMore)
      setNextHistoryCursor(
        page.nextCursor,
      )
    } catch (err) {
      setLoadMoreError(
        err instanceof Error
          ? err.message
          : 'Could not load more saved quizzes.',
      )
    } finally {
      setLoadingMore(false)
    }
  }

  async function removeHistoryItem(id: string) {
    try {
      await deleteQuizHistory(id)
      setHistory((previous) =>
        previous.filter(
          (item) => item.id !== id,
        ),
      )
      setDocumentHistory((previous) =>
        previous.filter(
          (item) => item.id !== id,
        ),
      )
      setTotalHistoryCount(
        (previous) =>
          Math.max(0, previous - 1),
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not delete quiz.',
      )
    }
  }

  return {
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
    enableHistory: () =>
      setHistoryEnabled(true),
    loadMore,
    removeHistoryItem,
  }
}
