export type WeakAreaQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'

export type WeakAreaQuestionResult = {
  questionType: WeakAreaQuestionType
  question: string
  sourcePages: number[]
  correct: boolean
}

export type WeakAreaAttempt = {
  questions: WeakAreaQuestionResult[]
}

export type WeakAreaResult = {
  questionType: WeakAreaQuestionType
  pages: number[]
  avoidQuestions: string[]
  missedQuestions: number
  baselinePercent: number
  baselineQuestionCount: number
  baselineAttemptCount: number
  baselineReliable: boolean
}

const MAX_RECENT_ATTEMPTS = 3
const MIN_RELIABLE_QUESTIONS = 3

const QUESTION_TYPES: WeakAreaQuestionType[] = [
  'multiple_choice',
  'true_false',
  'short_answer',
]

type TypeEvidence = {
  questionType: WeakAreaQuestionType
  latestCorrect: number
  latestTotal: number
  latestMisses: number
  recentCorrect: number
  recentTotal: number
  recentAttempts: WeakAreaAttempt[]
}

function getQuestionsForType(
  attempt: WeakAreaAttempt,
  questionType: WeakAreaQuestionType,
) {
  return attempt.questions.filter(
    (question) =>
      question.questionType === questionType,
  )
}

function buildTypeEvidence(
  attemptsNewestFirst: WeakAreaAttempt[],
  questionType: WeakAreaQuestionType,
): TypeEvidence | null {
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

  const latestQuestions =
    getQuestionsForType(
      attemptsWithType[0],
      questionType,
    )

  const recentAttempts =
    attemptsWithType.slice(
      0,
      MAX_RECENT_ATTEMPTS,
    )

  const recentQuestions =
    recentAttempts.flatMap(
      (attempt) =>
        getQuestionsForType(
          attempt,
          questionType,
        ),
    )

  const latestCorrect =
    latestQuestions.filter(
      (question) => question.correct,
    ).length
  const recentCorrect =
    recentQuestions.filter(
      (question) => question.correct,
    ).length

  return {
    questionType,
    latestCorrect,
    latestTotal: latestQuestions.length,
    latestMisses:
      latestQuestions.length - latestCorrect,
    recentCorrect,
    recentTotal: recentQuestions.length,
    recentAttempts,
  }
}

function getAccuracy(
  correct: number,
  total: number,
) {
  return total > 0
    ? correct / total
    : 1
}

export function analyzeWeakAreas(
  attemptsNewestFirst: WeakAreaAttempt[],
): WeakAreaResult | null {
  const evidence = QUESTION_TYPES
    .map((questionType) =>
      buildTypeEvidence(
        attemptsNewestFirst,
        questionType,
      ),
    )
    .filter(
      (item): item is TypeEvidence =>
        item !== null &&
        item.latestMisses > 0,
    )

  if (evidence.length === 0) {
    return null
  }

  evidence.sort((first, second) => {
    const latestAccuracyDifference =
      getAccuracy(
        first.latestCorrect,
        first.latestTotal,
      ) -
      getAccuracy(
        second.latestCorrect,
        second.latestTotal,
      )

    if (latestAccuracyDifference !== 0) {
      return latestAccuracyDifference
    }

    if (
      first.latestMisses !==
      second.latestMisses
    ) {
      return (
        second.latestMisses -
        first.latestMisses
      )
    }

    return (
      getAccuracy(
        first.recentCorrect,
        first.recentTotal,
      ) -
      getAccuracy(
        second.recentCorrect,
        second.recentTotal,
      )
    )
  })

  const weakest = evidence[0]
  const recentQuestions =
    weakest.recentAttempts.flatMap(
      (attempt) =>
        getQuestionsForType(
          attempt,
          weakest.questionType,
        ),
    )

  const missedQuestions =
    recentQuestions.filter(
      (question) => !question.correct,
    )

  const pageMisses =
    new Map<number, number>()

  missedQuestions.forEach((question) => {
    question.sourcePages.forEach(
      (pageNumber) => {
        pageMisses.set(
          pageNumber,
          (pageMisses.get(pageNumber) ?? 0) + 1,
        )
      },
    )
  })

  const rankedPageMisses = Array.from(
    pageMisses.entries(),
  ).sort(
    (first, second) =>
      second[1] - first[1] ||
      first[0] - second[0],
  )

  const highestPageMissCount =
    rankedPageMisses[0]?.[1] ?? 0
  const meaningfulPageMisses =
    rankedPageMisses.filter(
      ([, missCount]) =>
        missCount >=
        Math.max(
          1,
          Math.ceil(
            highestPageMissCount * 0.5,
          ),
        ),
    )
  const selectedPageMisses =
    meaningfulPageMisses.length >= 2 ||
    rankedPageMisses.length < 2
      ? meaningfulPageMisses
      : rankedPageMisses.slice(0, 2)

  const baselinePercent =
    weakest.recentTotal > 0
      ? Math.round(
          (
            weakest.recentCorrect /
            weakest.recentTotal
          ) * 100,
        )
      : 0

  return {
    questionType: weakest.questionType,
    pages: selectedPageMisses
      .slice(0, 3)
      .map(([pageNumber]) => pageNumber)
      .sort((first, second) => first - second),
    avoidQuestions: Array.from(
      new Set(
        missedQuestions.map(
          (question) => question.question,
        ),
      ),
    ).slice(0, 20),
    missedQuestions: missedQuestions.length,
    baselinePercent,
    baselineQuestionCount:
      weakest.recentTotal,
    baselineAttemptCount:
      weakest.recentAttempts.length,
    baselineReliable:
      weakest.recentTotal >=
      MIN_RELIABLE_QUESTIONS,
  }
}
