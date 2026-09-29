import type {
  DeckDetail,
} from '../types/api.generated'
import {
  isWeakStudyCard,
} from './studyModes.ts'

export type ExamIntensity =
  | 'relaxed'
  | 'balanced'
  | 'intensive'

export type ExamPlan = {
  examDate: string
  daysRemaining: number
  intensity: ExamIntensity
  activeCardCount: number
  newCardCount: number
  reviewDueCount: number
  weakCardCount: number
  recommendedNewCardsToday: number
  requiredNewCardsPerDay: number
  recommendedReviewCardsToday: number
  recommendedTotalToday: number
  workloadCapped: boolean
  weakTags: Array<{
    tag: string
    count: number
  }>
}

const DAY_MS =
  24 * 60 * 60 * 1000
const MAX_NEW_PER_DAY = 50
const MAX_REVIEWS_PER_DAY = 150

function dateSerial(
  year: number,
  month: number,
  day: number,
) {
  return Math.floor(
    Date.UTC(
      year,
      month,
      day,
    ) / DAY_MS,
  )
}

function examDateSerial(
  value: string,
) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/
      .exec(value)

  if (!match) {
    return null
  }

  const year = Number(
    match[1],
  )
  const month =
    Number(match[2]) - 1
  const day = Number(
    match[3],
  )
  const date = new Date(
    Date.UTC(
      year,
      month,
      day,
    ),
  )

  if (
    date.getUTCFullYear() !==
      year ||
    date.getUTCMonth() !==
      month ||
    date.getUTCDate() !==
      day
  ) {
    return null
  }

  return dateSerial(
    year,
    month,
    day,
  )
}

function todaySerial(
  now: Date,
) {
  return dateSerial(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )
}

function intensityForDays(
  daysRemaining: number,
): ExamIntensity {
  if (daysRemaining > 30) {
    return 'relaxed'
  }

  if (daysRemaining > 14) {
    return 'balanced'
  }

  return 'intensive'
}

function extraWeakReviews(
  intensity: ExamIntensity,
) {
  if (intensity === 'relaxed') {
    return 3
  }

  if (
    intensity === 'balanced'
  ) {
    return 7
  }

  return 15
}

function bufferDays(
  intensity: ExamIntensity,
) {
  if (intensity === 'relaxed') {
    return 7
  }

  if (
    intensity === 'balanced'
  ) {
    return 3
  }

  return 0
}

export function buildExamPlan(
  deck: DeckDetail,
  now = new Date(),
): ExamPlan | null {
  const examDate =
    deck.exam_date

  if (!examDate) {
    return null
  }

  const examSerial =
    examDateSerial(examDate)

  if (examSerial === null) {
    return null
  }

  const daysRemaining =
    examSerial -
    todaySerial(now)
  const active =
    deck.cards.filter(
      (card) =>
        !card.suspended,
    )
  const newCards =
    active.filter(
      (card) =>
        card.review_count === 0,
    )
  const nowMs = now.getTime()
  const reviewDue =
    active.filter(
      (card) =>
        card.review_count > 0 &&
        Number.isFinite(
          Date.parse(
            card.due_at,
          ),
        ) &&
        Date.parse(
          card.due_at,
        ) <= nowMs,
    )
  const weak =
    active.filter(
      isWeakStudyCard,
    )
  const reviewDueIds =
    new Set(
      reviewDue.map(
        (card) => card.id,
      ),
    )
  const weakNotDue =
    weak.filter(
      (card) =>
        !reviewDueIds.has(
          card.id,
        ),
    )

  const intensity =
    intensityForDays(
      daysRemaining,
    )

  let requiredNewCardsPerDay = 0
  let recommendedNewCardsToday =
    0
  let recommendedReviewCardsToday =
    0

  if (daysRemaining >= 0) {
    const studyDays =
      Math.max(
        1,
        daysRemaining -
          bufferDays(
            intensity,
          ),
      )

    requiredNewCardsPerDay =
      Math.ceil(
        newCards.length /
          studyDays,
      )

    recommendedNewCardsToday =
      Math.min(
        MAX_NEW_PER_DAY,
        requiredNewCardsPerDay,
      )

    recommendedReviewCardsToday =
      Math.min(
        MAX_REVIEWS_PER_DAY,
        reviewDue.length +
          Math.min(
            weakNotDue.length,
            extraWeakReviews(
              intensity,
            ),
          ),
      )
  }

  const tagCounts =
    new Map<string, number>()

  for (const card of weak) {
    for (
      const tag of
      card.tags ?? []
    ) {
      tagCounts.set(
        tag,
        (
          tagCounts.get(
            tag,
          ) ?? 0
        ) + 1,
      )
    }
  }

  const weakTags = [
    ...tagCounts.entries(),
  ]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        left[0].localeCompare(
          right[0],
        ),
    )
    .slice(0, 5)
    .map(
      ([tag, count]) => ({
        tag,
        count,
      }),
    )

  const recommendedTotalToday =
    recommendedNewCardsToday +
    recommendedReviewCardsToday

  return {
    examDate,
    daysRemaining,
    intensity,
    activeCardCount:
      active.length,
    newCardCount:
      newCards.length,
    reviewDueCount:
      reviewDue.length,
    weakCardCount:
      weak.length,
    recommendedNewCardsToday,
    requiredNewCardsPerDay,
    recommendedReviewCardsToday,
    recommendedTotalToday,
    workloadCapped:
      requiredNewCardsPerDay >
        MAX_NEW_PER_DAY ||
      reviewDue.length >
        MAX_REVIEWS_PER_DAY,
    weakTags,
  }
}
