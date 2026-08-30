import {
  getCurrentDocumentSha256,
  matchesHistoryDocument,
  normalizeDocumentSha256,
  withDocumentIdentityInQuizData,
} from './documentIdentity'
import {
  appendUniqueHistoryRows,
  buildHistoryCursorFilter,
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
  normalizeHistoryPageSize,
  QUIZ_HISTORY_PAGE_SIZE,
  splitHistoryPageRows,
  type QuizHistoryCursor,
} from './quizHistoryPagination'
import { supabase } from './supabase'

type StoredSelectedAnswers =
  Record<string, number | string>

export type QuizHistoryRow = {
  id: string
  user_id: string
  quiz_title: string
  source_filename: string
  document_sha256?: string | null
  difficulty: string
  question_type: string
  question_count: number
  score: number
  percentage: number
  quiz_data: unknown
  selected_answers: StoredSelectedAnswers
  created_at: string
}

type SaveQuizHistoryInput = {
  quizTitle: string
  sourceFilename: string
  difficulty: string
  questionType: string
  questionCount: number
  score: number
  percentage: number
  quizData: unknown
  selectedAnswers: StoredSelectedAnswers
}

type SupabaseInsertError = {
  code?: string
  message?: string
}

export type QuizHistoryPage = {
  items: QuizHistoryRow[]
  totalCount: number
  hasMore: boolean
}

type GetQuizHistoryPageInput = {
  offset?: number
  limit?: number
}

type GetDocumentHistoryInput = {
  sourceFilename: string
  documentSha256?: string | null
  limit?: number
}

type HistoryPaginationState = {
  initialized: boolean
  pageSize: number
  loadedIds: string[]
  nextCursor: QuizHistoryCursor | null
  totalCount: number
}

const historyPaginationState: HistoryPaginationState = {
  initialized: false,
  pageSize: QUIZ_HISTORY_PAGE_SIZE,
  loadedIds: [],
  nextCursor: null,
  totalCount: 0,
}

function resetHistoryPaginationState({
  pageSize,
  items,
  nextCursor,
  totalCount,
}: {
  pageSize: number
  items: QuizHistoryRow[]
  nextCursor: QuizHistoryCursor | null
  totalCount: number
}) {
  historyPaginationState.initialized = true
  historyPaginationState.pageSize = pageSize
  historyPaginationState.loadedIds =
    items.map((item) => item.id)
  historyPaginationState.nextCursor =
    nextCursor
  historyPaginationState.totalCount =
    totalCount
}

function appendHistoryPaginationState(
  items: QuizHistoryRow[],
  nextCursor: QuizHistoryCursor | null,
) {
  const seen = new Set(
    historyPaginationState.loadedIds,
  )

  items.forEach((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      historyPaginationState.loadedIds.push(
        item.id,
      )
    }
  })

  historyPaginationState.nextCursor =
    nextCursor
}

function isMissingDocumentSha256Column(
  error: SupabaseInsertError,
) {
  const message =
    (error.message ?? '').toLowerCase()

  return (
    message.includes('document_sha256') &&
    (
      error.code === 'PGRST204' ||
      error.code === '42703' ||
      message.includes('column')
    )
  )
}

function sortNewestFirst(
  first: QuizHistoryRow,
  second: QuizHistoryRow,
) {
  const timeDifference =
    new Date(second.created_at).getTime() -
    new Date(first.created_at).getTime()

  if (timeDifference !== 0) {
    return timeDifference
  }

  return second.id.localeCompare(first.id)
}

export async function saveQuizHistory(
  input: SaveQuizHistoryInput,
) {
  const {
    data: userData,
    error: userError,
  } =
    await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!userData.user) {
    throw new Error(
      'You must be logged in to save a quiz.',
    )
  }

  const documentSha256 =
    getCurrentDocumentSha256(
      input.sourceFilename,
    )

  const payload = {
    user_id: userData.user.id,
    quiz_title: input.quizTitle,
    source_filename: input.sourceFilename,
    difficulty: input.difficulty,
    question_type: input.questionType,
    question_count: input.questionCount,
    score: input.score,
    percentage: input.percentage,
    quiz_data:
      withDocumentIdentityInQuizData(
        input.quizData,
        documentSha256,
      ),
    selected_answers:
      input.selectedAnswers,
  }

  if (documentSha256) {
    const { error } =
      await supabase
        .from('quiz_history')
        .insert({
          ...payload,
          document_sha256:
            documentSha256,
        })

    if (!error) {
      return
    }

    if (
      !isMissingDocumentSha256Column(
        error,
      )
    ) {
      throw error
    }
  }

  const { error } =
    await supabase
      .from('quiz_history')
      .insert(payload)

  if (error) {
    throw error
  }
}

export async function getQuizHistoryPage({
  offset = 0,
  limit = QUIZ_HISTORY_PAGE_SIZE,
}: GetQuizHistoryPageInput = {}): Promise<QuizHistoryPage> {
  const safeOffset = Math.max(
    0,
    Math.floor(offset),
  )
  const pageSize =
    normalizeHistoryPageSize(limit)
  const shouldStartNewPagination =
    safeOffset === 0 ||
    !historyPaginationState.initialized ||
    historyPaginationState.pageSize !== pageSize

  if (shouldStartNewPagination) {
    const {
      data,
      error,
      count,
    } = await supabase
      .from('quiz_history')
      .select('*', {
        count: 'exact',
      })
      .order('created_at', {
        ascending: false,
      })
      .order('id', {
        ascending: false,
      })
      .limit(pageSize + 1)

    if (error) {
      throw error
    }

    const page = splitHistoryPageRows(
      (data ?? []) as QuizHistoryRow[],
      pageSize,
    )
    const totalCount =
      count ??
      page.items.length +
        (page.hasMore ? 1 : 0)

    resetHistoryPaginationState({
      pageSize,
      items: page.items,
      nextCursor: page.nextCursor,
      totalCount,
    })

    return {
      items: page.items,
      totalCount,
      hasMore: page.hasMore,
    }
  }

  if (
    safeOffset !==
    historyPaginationState.loadedIds.length
  ) {
    throw new Error(
      'Quiz history changed while loading. Please refresh the history list.',
    )
  }

  const cursor =
    historyPaginationState.nextCursor

  if (!cursor) {
    return {
      items: [],
      totalCount:
        historyPaginationState.totalCount,
      hasMore: false,
    }
  }

  const { data, error } = await supabase
    .from('quiz_history')
    .select('*')
    .or(buildHistoryCursorFilter(cursor))
    .order('created_at', {
      ascending: false,
    })
    .order('id', {
      ascending: false,
    })
    .limit(pageSize + 1)

  if (error) {
    throw error
  }

  const page = splitHistoryPageRows(
    (data ?? []) as QuizHistoryRow[],
    pageSize,
  )

  appendHistoryPaginationState(
    page.items,
    page.nextCursor,
  )

  return {
    items: page.items,
    totalCount:
      historyPaginationState.totalCount,
    hasMore: page.hasMore,
  }
}

export async function getQuizHistoryForDocument({
  sourceFilename,
  documentSha256,
  limit = DOCUMENT_HISTORY_ANALYSIS_LIMIT,
}: GetDocumentHistoryInput) {
  const pageSize =
    normalizeHistoryPageSize(limit)
  const normalizedHash =
    normalizeDocumentSha256(
      documentSha256,
    )

  const createQuery = () =>
    supabase
      .from('quiz_history')
      .select('*')
      .order('created_at', {
        ascending: false,
      })
      .order('id', {
        ascending: false,
      })
      .limit(pageSize)

  if (!normalizedHash) {
    const { data, error } =
      await createQuery().eq(
        'source_filename',
        sourceFilename,
      )

    if (error) {
      throw error
    }

    return (
      (data ?? []) as QuizHistoryRow[]
    ).slice(0, pageSize)
  }

  const [hashedResult, legacyResult] =
    await Promise.all([
      createQuery().eq(
        'document_sha256',
        normalizedHash,
      ),
      createQuery()
        .is('document_sha256', null)
        .eq(
          'source_filename',
          sourceFilename,
        ),
    ])

  if (hashedResult.error) {
    throw hashedResult.error
  }

  if (legacyResult.error) {
    throw legacyResult.error
  }

  return appendUniqueHistoryRows(
    (hashedResult.data ?? []) as QuizHistoryRow[],
    (legacyResult.data ?? []) as QuizHistoryRow[],
  )
    .filter((item) =>
      matchesHistoryDocument(
        item,
        sourceFilename,
        normalizedHash,
      ),
    )
    .sort(sortNewestFirst)
    .slice(0, pageSize)
}

export async function deleteQuizHistory(
  id: string,
) {
  const { error } =
    await supabase
      .from('quiz_history')
      .delete()
      .eq('id', id)

  if (error) {
    throw error
  }

  if (
    historyPaginationState.loadedIds.includes(
      id,
    )
  ) {
    historyPaginationState.loadedIds =
      historyPaginationState.loadedIds.filter(
        (loadedId) => loadedId !== id,
      )
    historyPaginationState.totalCount =
      Math.max(
        0,
        historyPaginationState.totalCount - 1,
      )
  }
}
