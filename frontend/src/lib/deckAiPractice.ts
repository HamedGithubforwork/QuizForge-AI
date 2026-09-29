import type {
  CardCreate,
  CardRow,
  DeckDetail,
} from '../types/api.generated'
import type {
  QuestionMode,
  QuestionType,
  QuizResult,
} from '../types/quiz'
import {
  weakCardLapseRate,
  weakStudyCards,
} from './studyModes.ts'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

export const DECK_AI_PRACTICE_QUESTION_COUNT =
  5

export type WeakDeckAiFocus = {
  documentSha256: string
  sourceFilename: string
  sourcePages: number[]
  weakQuestions: string[]
  weakCardCount: number
  questionMode: QuestionMode
  focusQuestionTypes: QuestionType[]
  difficulty: 'easy' | 'medium'
}

type FocusGroup = {
  documentSha256: string
  sourceFilename: string
  cards: CardRow[]
}

function validDocumentHash(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/.test(value)
  )
}

function groupWeakCards(
  cards: CardRow[],
): FocusGroup[] {
  const groups =
    new Map<string, FocusGroup>()

  for (const card of cards) {
    if (
      !validDocumentHash(
        card.document_sha256,
      )
    ) {
      continue
    }

    const existing =
      groups.get(
        card.document_sha256,
      )

    if (existing) {
      existing.cards.push(card)
      continue
    }

    groups.set(
      card.document_sha256,
      {
        documentSha256:
          card.document_sha256,
        sourceFilename:
          card.source_filename ??
          'Study source',
        cards: [card],
      },
    )
  }

  return [
    ...groups.values(),
  ]
}

function groupScore(
  group: FocusGroup,
) {
  return {
    count: group.cards.length,
    lapseRate:
      group.cards.reduce(
        (total, card) =>
          total +
          weakCardLapseRate(
            card,
          ),
        0,
      ),
    lapses:
      group.cards.reduce(
        (total, card) =>
          total +
          card.lapse_count,
        0,
      ),
    difficulty:
      group.cards.reduce(
        (total, card) =>
          total +
          (
            card.difficulty ??
            0
          ),
        0,
      ),
  }
}

function compareGroups(
  left: FocusGroup,
  right: FocusGroup,
) {
  const a = groupScore(left)
  const b = groupScore(right)

  return (
    b.count - a.count ||
    b.lapseRate -
      a.lapseRate ||
    b.lapses - a.lapses ||
    b.difficulty -
      a.difficulty ||
    left.documentSha256
      .localeCompare(
        right.documentSha256,
      )
  )
}

function focusQuestionTypes(
  cards: CardRow[],
) {
  const counts:
    Record<QuestionType, number> = {
      multiple_choice: 0,
      true_false: 0,
      short_answer: 0,
    }

  for (const card of cards) {
    counts[
      card.question_type
    ] += 1
  }

  return (
    Object.entries(counts) as [
      QuestionType,
      number,
    ][]
  )
    .filter(
      ([, count]) =>
        count > 0,
    )
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        left[0].localeCompare(
          right[0],
        ),
    )
}

function practiceDifficulty(
  cards: CardRow[],
): 'easy' | 'medium' {
  const totalLapses =
    cards.reduce(
      (total, card) =>
        total +
        card.lapse_count,
      0,
    )
  const maximumLapseRate =
    Math.max(
      0,
      ...cards.map(
        weakCardLapseRate,
      ),
    )

  return (
    totalLapses >= 3 ||
    maximumLapseRate >= 0.5
  )
    ? 'easy'
    : 'medium'
}

export function buildWeakDeckAiFocus(
  deck: DeckDetail,
): WeakDeckAiFocus | null {
  const weak =
    weakStudyCards(
      deck.cards,
    )
  const groups =
    groupWeakCards(weak)
      .sort(compareGroups)
  const selected =
    groups[0]

  if (!selected) {
    return null
  }

  const types =
    focusQuestionTypes(
      selected.cards,
    )
  const topCount =
    types[0]?.[1] ?? 0
  const secondCount =
    types[1]?.[1] ?? 0

  const questionMode:
    QuestionMode =
      types.length > 1 &&
      topCount === secondCount
        ? 'mixed'
        : (
            types[0]?.[0] ??
            'mixed'
          )

  const pages = [
    ...new Set(
      selected.cards.flatMap(
        (card) =>
          card.source_pages ??
          [],
      ),
    ),
  ].sort(
    (left, right) =>
      left - right,
  )

  const questions = [
    ...new Set(
      selected.cards
        .map(
          (card) =>
            card.question
              .trim(),
        )
        .filter(Boolean),
    ),
  ].slice(0, 10)

  return {
    documentSha256:
      selected.documentSha256,
    sourceFilename:
      selected.sourceFilename,
    sourcePages: pages,
    weakQuestions:
      questions,
    weakCardCount:
      selected.cards.length,
    questionMode,
    focusQuestionTypes:
      types.map(
        ([type]) => type,
      ),
    difficulty:
      practiceDifficulty(
        selected.cards,
      ),
  }
}

export async function generateWeakDeckPracticeQuiz(
  focus: WeakDeckAiFocus,
  fetcher: ApiFetch,
): Promise<QuizResult> {
  const formData =
    new FormData()

  formData.append(
    'document_sha256',
    focus.documentSha256,
  )
  formData.append(
    'question_count',
    String(
      DECK_AI_PRACTICE_QUESTION_COUNT,
    ),
  )
  formData.append(
    'difficulty',
    focus.difficulty,
  )
  formData.append(
    'question_type',
    focus.questionMode,
  )

  if (
    focus.sourcePages.length >
    0
  ) {
    formData.append(
      'focus_pages',
      focus.sourcePages.join(
        ',',
      ),
    )
  }

  if (
    focus.focusQuestionTypes
      .length > 0
  ) {
    formData.append(
      'focus_question_types',
      focus.focusQuestionTypes.join(
        ',',
      ),
    )
  }

  formData.append(
    'avoid_questions',
    JSON.stringify(
      focus.weakQuestions,
    ),
  )

  const response =
    await fetcher(
      '/api/quizzes/generate',
      {
        method: 'POST',
        body: formData,
      },
    )

  let data: unknown = null

  try {
    data =
      await response.json()
  } catch {
    // Empty gateway errors use the bounded fallback below.
  }

  if (!response.ok) {
    const detail =
      data &&
      typeof data === 'object' &&
      'detail' in data &&
      typeof data.detail ===
        'string'
        ? data.detail
        : 'Could not generate AI practice cards.'

    throw new Error(detail)
  }

  return data as QuizResult
}

export function practiceCardsFromQuiz(
  quiz: QuizResult,
  focus: WeakDeckAiFocus,
): CardCreate[] {
  return quiz.questions.map(
    (question) => ({
      question_type:
        question.question_type,
      question:
        question.question,
      answer: {
        correct_index:
          question.correct_index,
        correct_answer:
          question.correct_answer,
        accepted_answers:
          question.accepted_answers,
        grading:
          question.grading,
      },
      choices:
        question.choices,
      explanation:
        question.explanation,
      source_filename:
        focus.sourceFilename,
      document_sha256:
        focus.documentSha256,
      source_pages:
        question.source_pages,
      tags: [
        'ai-practice',
      ],
    }),
  )
}
