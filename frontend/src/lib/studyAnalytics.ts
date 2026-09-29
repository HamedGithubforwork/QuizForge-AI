import type {
  StudyAnalyticsSummary,
} from '../types/api.generated'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

export async function getStudyAnalytics(
  timezone: string,
  fetcher: ApiFetch,
): Promise<StudyAnalyticsSummary> {
  const params =
    new URLSearchParams({
      timezone,
    })

  const response =
    await fetcher(
      '/api/study-analytics/summary?'
        + params.toString(),
    )

  let data: unknown = null

  try {
    data = await response.json()
  } catch {
    // Keep bounded fallback below.
  }

  if (!response.ok) {
    const detail =
      data &&
      typeof data === 'object' &&
      'detail' in data &&
      typeof data.detail === 'string'
        ? data.detail
        : 'Could not load study progress.'

    throw new Error(detail)
  }

  return data as StudyAnalyticsSummary
}

export function formatStudyDuration(
  milliseconds: number,
) {
  const totalMinutes =
    Math.max(
      0,
      Math.round(
        milliseconds / 60000,
      ),
    )

  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }

  const hours =
    Math.floor(
      totalMinutes / 60,
    )
  const minutes =
    totalMinutes % 60

  return minutes
    ? `${hours}h ${minutes}m`
    : `${hours}h`
}

export function formatRetention(
  value: number | null,
) {
  if (value === null) {
    return '—'
  }

  return (
    Math.round(
      Math.max(
        0,
        Math.min(1, value),
      )
      * 100,
    )
    + '%'
  )
}

export function ratingPercent(
  value: number,
  total: number,
) {
  if (total <= 0) {
    return 0
  }

  return Math.round(
    value / total * 100,
  )
}

export function detectedAnalyticsTimezone() {
  try {
    return (
      Intl.DateTimeFormat()
        .resolvedOptions()
        .timeZone
      || 'UTC'
    )
  } catch {
    return 'UTC'
  }
}
