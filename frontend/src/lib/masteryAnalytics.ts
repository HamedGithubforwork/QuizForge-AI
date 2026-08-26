export type MasteryQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type MasteryQuestionResult = {
  questionType: MasteryQuestionType
  question: string
  sourcePages: number[]
  correct: boolean
}

export type MasteryAttempt = {
  createdAt: string
  percentage: number
  questions: MasteryQuestionResult[]
}

export type MasteryStatus =
  | 'needs_work'
  | 'improving'
  | 'mastered'

export type MasteryTrendPoint = {
  createdAt: string
  percentage: number
}

export type MasteryTypeSummary = {
  questionType: MasteryQuestionType
  status: MasteryStatus
  latestPercent: number
  previousPercent: number | null
  delta: number | null
  recentPercent: number
  attemptCount: number
  questionCount: number
  sustainedMastery: boolean
}

export type RecurringWeakPage = {
  pageNumber: number
  missCount: number
  attemptCount: number
}

export type DocumentMasterySummary = {
  status: MasteryStatus
  attemptCount: number
  latestPercent: number
  priorBaselinePercent: number | null
  scoreDelta: number | null
  recentTrend: MasteryTrendPoint[]
  typeSummaries: MasteryTypeSummary[]
  recurringWeakPages: RecurringWeakPage[]
  sustainedMastery: boolean
}

const QUESTION_TYPES: MasteryQuestionType[] = [
  'multiple_choice',
  'true_false',
  'short_answer',
]

const MAX_TREND_ATTEMPTS = 6
const MAX_TYPE_ATTEMPTS = 3
const MAX_RECURRING_PAGE_ATTEMPTS = 5
const STRONG_SCORE = 80
const IMPROVING_SCORE = 65
const MIN_MASTERY_QUESTIONS = 5

function clampPercentage(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(
    0,
    Math.min(100, Math.round(value)),
  )
}

function average(values: number[]) {
  if (values.length === 0) {
    return null
  }

  return Math.round(
    values.reduce(
      (total, value) => total + value,
      0,
    ) / values.length,
  )
}

function getQuestionsForType(
  attempt: MasteryAttempt,
  questionType: MasteryQuestionType,
) {
  return attempt.questions.filter(
    (question) =>
      question.questionType === questionType,
  )
}

function getQuestionAccuracy(
  questions: MasteryQuestionResult[],
) {
  if (questions.length === 0) {
    return 0
  }

  const correct = questions.filter(
    (question) => question.correct,
  ).length

  return Math.round(
    (correct / questions.length) * 100,
  )
}

function buildTypeSummary(
  attemptsNewestFirst: MasteryAttempt[],
  questionType: MasteryQuestionType,
): MasteryTypeSummary | null {
  const attemptsWithType =
    attemptsNewestFirst.filter(
      (attempt) =>
        getQuestionsForType(
          attempt,
          questionType,
        ).length > 0,
    )

  if (attemptsWithType.length === 0) {
    return null
  }

  const recentAttempts =
    attemptsWithType.slice(
      0,
      MAX_TYPE_ATTEMPTS,
    )

  const attemptScores = recentAttempts.map(
    (attempt) =>
      getQuestionAccuracy(
        getQuestionsForType(
          attempt,
          questionType,
        ),
      ),
  )

  const latestPercent = attemptScores[0]
  const previousPercent = average(
    attemptScores.slice(1),
  )
  const delta =
    previousPercent === null
      ? null
      : latestPercent - previousPercent

  const recentQuestions =
    recentAttempts.flatMap(
      (attempt) =>
        getQuestionsForType(
          attempt,
          questionType,
        ),
    )

  const recentPercent =
    getQuestionAccuracy(recentQuestions)

  const secondAttemptPercent =
    attemptScores[1] ?? null

  const sustainedMastery = Boolean(
    attemptsWithType.length >= 2 &&
      secondAttemptPercent !== null &&
      latestPercent >= STRONG_SCORE &&
      secondAttemptPercent >= STRONG_SCORE &&
      recentPercent >= STRONG_SCORE &&
      recentQuestions.length >=
        MIN_MASTERY_QUESTIONS,
  )

  let status: MasteryStatus =
    'needs_work'

  if (sustainedMastery) {
    status = 'mastered'
  } else if (
    latestPercent >= STRONG_SCORE ||
    (
      latestPercent >= IMPROVING_SCORE &&
      recentPercent >= IMPROVING_SCORE
    ) ||
    (delta !== null && delta >= 10)
  ) {
    status = 'improving'
  }

  return {
    questionType,
    status,
    latestPercent,
    previousPercent,
    delta,
    recentPercent,
    attemptCount: attemptsWithType.length,
    questionCount: recentQuestions.length,
    sustainedMastery,
  }
}

function buildRecurringWeakPages(
  attemptsNewestFirst: MasteryAttempt[],
) {
  const recentAttempts =
    attemptsNewestFirst.slice(
      0,
      MAX_RECURRING_PAGE_ATTEMPTS,
    )

  const pageEvidence = new Map<
    number,
    {
      missCount: number
      attemptIndexes: Set<number>
    }
  >()

  recentAttempts.forEach(
    (attempt, attemptIndex) => {
      attempt.questions
        .filter(
          (question) => !question.correct,
        )
        .forEach((question) => {
          question.sourcePages.forEach(
            (pageNumber) => {
              if (
                !Number.isInteger(pageNumber) ||
                pageNumber < 1
              ) {
                return
              }

              const current =
                pageEvidence.get(pageNumber) ?? {
                  missCount: 0,
                  attemptIndexes:
                    new Set<number>(),
                }

              current.missCount += 1
              current.attemptIndexes.add(
                attemptIndex,
              )

              pageEvidence.set(
                pageNumber,
                current,
              )
            },
          )
        })
    },
  )

  return Array.from(
    pageEvidence.entries(),
  )
    .map(
      ([pageNumber, evidence]) => ({
        pageNumber,
        missCount: evidence.missCount,
        attemptCount:
          evidence.attemptIndexes.size,
      }),
    )
    .filter(
      (item) => item.attemptCount >= 2,
    )
    .sort(
      (first, second) =>
        second.attemptCount -
          first.attemptCount ||
        second.missCount -
          first.missCount ||
        first.pageNumber -
          second.pageNumber,
    )
    .slice(0, 3)
}

export function analyzeDocumentMastery(
  attemptsNewestFirst: MasteryAttempt[],
): DocumentMasterySummary | null {
  if (attemptsNewestFirst.length === 0) {
    return null
  }

  const normalizedAttempts =
    attemptsNewestFirst.map(
      (attempt) => ({
        ...attempt,
        percentage:
          clampPercentage(attempt.percentage),
      }),
    )

  const latestPercent =
    normalizedAttempts[0].percentage

  const priorBaselinePercent = average(
    normalizedAttempts
      .slice(1, 4)
      .map(
        (attempt) => attempt.percentage,
      ),
  )

  const scoreDelta =
    priorBaselinePercent === null
      ? null
      : latestPercent -
        priorBaselinePercent

  const typeSummaries = QUESTION_TYPES
    .map((questionType) =>
      buildTypeSummary(
        normalizedAttempts,
        questionType,
      ),
    )
    .filter(
      (
        summary,
      ): summary is MasteryTypeSummary =>
        summary !== null,
    )

  const sustainedMastery = Boolean(
    typeSummaries.length > 0 &&
      normalizedAttempts.length >= 2 &&
      typeSummaries.every(
        (summary) =>
          summary.sustainedMastery,
      ),
  )

  let status: MasteryStatus =
    'needs_work'

  if (sustainedMastery) {
    status = 'mastered'
  } else if (
    latestPercent >= 70 ||
    (scoreDelta !== null && scoreDelta >= 5) ||
    typeSummaries.some(
      (summary) =>
        summary.status === 'improving' ||
        summary.status === 'mastered',
    )
  ) {
    status = 'improving'
  }

  return {
    status,
    attemptCount:
      normalizedAttempts.length,
    latestPercent,
    priorBaselinePercent,
    scoreDelta,
    recentTrend:
      normalizedAttempts
        .slice(0, MAX_TREND_ATTEMPTS)
        .map((attempt) => ({
          createdAt: attempt.createdAt,
          percentage: attempt.percentage,
        })),
    typeSummaries,
    recurringWeakPages:
      buildRecurringWeakPages(
        normalizedAttempts,
      ),
    sustainedMastery,
  }
}

export function getMasteryStatusLabel(
  status: MasteryStatus,
) {
  if (status === 'mastered') {
    return 'Mastered'
  }

  if (status === 'improving') {
    return 'Improving'
  }

  return 'Needs Work'
}
