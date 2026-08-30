export const QUIZ_HISTORY_PAGE_SIZE = 20
export const MAX_QUIZ_HISTORY_PAGE_SIZE = 50
export const DOCUMENT_HISTORY_ANALYSIS_LIMIT = 30

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

export function hasMoreHistoryRows({
  offset,
  loadedCount,
  totalCount,
  pageSize,
}: {
  offset: number
  loadedCount: number
  totalCount: number | null
  pageSize: number
}) {
  if (totalCount !== null) {
    return offset + loadedCount < totalCount
  }

  return loadedCount === pageSize
}
