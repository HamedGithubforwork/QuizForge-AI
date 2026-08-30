export const QUIZ_HISTORY_PAGE_SIZE = 20
export const MAX_QUIZ_HISTORY_PAGE_SIZE = 50
export const DOCUMENT_HISTORY_ANALYSIS_LIMIT = 30

export type QuizHistoryCursor = {
  createdAt: string
  id: string
}

export function normalizeHistoryPageSize(
  value: number,
) {
  if (!Number.isFinite(value)) {
    return QUIZ_HISTORY_PAGE_SIZE
  }

  return Math.min(
    MAX_QUIZ_HISTORY_PAGE_SIZE,
    Math.max(1, Math.floor(value)),
  )
}

export function appendUniqueHistoryRows<
  Row extends { id: string },
>(
  existing: Row[],
  incoming: Row[],
) {
  const seen = new Set(
    existing.map((item) => item.id),
  )

  return [
    ...existing,
    ...incoming.filter((item) => {
      if (seen.has(item.id)) {
        return false
      }

      seen.add(item.id)
      return true
    }),
  ]
}

export function createHistoryCursor<
  Row extends {
    created_at: string
    id: string
  },
>(row: Row | null | undefined): QuizHistoryCursor | null {
  if (!row) {
    return null
  }

  return {
    createdAt: row.created_at,
    id: row.id,
  }
}

export function buildHistoryCursorFilter(
  cursor: QuizHistoryCursor,
) {
  return [
    `created_at.lt.${cursor.createdAt},`,
    'and(',
    `created_at.eq.${cursor.createdAt},`,
    `id.lt.${cursor.id}`,
    ')',
  ].join('')
}

export function splitHistoryPageRows<
  Row extends {
    created_at: string
    id: string
  },
>(
  rows: Row[],
  pageSize: number,
) {
  const items = rows.slice(0, pageSize)
  const hasMore = rows.length > pageSize

  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? createHistoryCursor(
          items[items.length - 1],
        )
      : null,
  }
}
