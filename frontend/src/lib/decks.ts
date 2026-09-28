import type {
  CardBatchCreate,
  CardCreate,
  CardMove,
  CardUpdate,
  DeckCreate,
  DeckDetail,
  DeckDuplicate,
  DeckSummary,
  DeckUpdate,
  ReviewQueue,
  ReviewRequest,
  ReviewResult,
} from '../types/api.generated'
import type {
  QuizResult,
  UploadResult,
} from '../types/quiz'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

function cardFromQuestion(
  question: QuizResult['questions'][number],
  documentResult: UploadResult,
): CardCreate {
  return {
    question_type:
      question.question_type,
    question: question.question,
    answer: {
      correct_index:
        question.correct_index,
      correct_answer:
        question.correct_answer,
      accepted_answers:
        question.accepted_answers,
      grading: question.grading,
    },
    choices: question.choices,
    explanation:
      question.explanation,
    source_filename:
      documentResult.filename,
    document_sha256:
      documentResult.pdf_sha256,
    source_pages:
      question.source_pages,
  }
}

export function buildDeckCards(
  quiz: QuizResult,
  documentResult: UploadResult,
): CardCreate[] {
  return quiz.questions.map(
    (question) =>
      cardFromQuestion(
        question,
        documentResult,
      ),
  )
}

export function buildSelectedDeckCards(
  quiz: QuizResult,
  documentResult: UploadResult,
  selectedIndexes: number[],
): CardCreate[] {
  const unique = [
    ...new Set(
      selectedIndexes,
    ),
  ].sort(
    (left, right) =>
      left - right,
  )

  if (
    unique.length === 0 ||
    unique.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index >=
          quiz.questions.length,
    )
  ) {
    throw new Error(
      'Choose at least one valid quiz question.',
    )
  }

  return unique.map(
    (index) =>
      cardFromQuestion(
        quiz.questions[index],
        documentResult,
      ),
  )
}

export function buildDeckCreatePayload(
  name: string,
  quiz: QuizResult,
  documentResult: UploadResult,
): DeckCreate {
  return {
    name: name.trim(),
    cards: buildDeckCards(
      quiz,
      documentResult,
    ),
  }
}

async function requestDeckJson<T>(
  path: string,
  fetcher: ApiFetch,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response =
    await fetcher(path, init)

  let data: unknown = null

  try {
    data = await response.json()
  } catch {
    // A failed response can be empty.
  }

  if (!response.ok) {
    const detail =
      data &&
      typeof data === 'object' &&
      'detail' in data &&
      typeof data.detail === 'string'
        ? data.detail
        : fallbackError

    throw new Error(detail)
  }

  return data as T
}

export async function createStudyDeck(
  payload: DeckCreate,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    '/api/decks',
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not save this study deck.',
  )
}

export async function listStudyDecks(
  fetcher: ApiFetch,
): Promise<DeckSummary[]> {
  return requestDeckJson<DeckSummary[]>(
    '/api/decks',
    fetcher,
    {},
    'Could not load your study decks.',
  )
}

export async function getStudyDeck(
  deckId: string,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}`,
    fetcher,
    {},
    'Could not load this study deck.',
  )
}

export async function getReviewQueue(
  deckId: string,
  fetcher: ApiFetch,
  limit = 20,
): Promise<ReviewQueue> {
  const params =
    new URLSearchParams({
      limit: String(limit),
    })

  return requestDeckJson<ReviewQueue>(
    `/api/decks/${encodeURIComponent(deckId)}/review?${params.toString()}`,
    fetcher,
    {},
    'Could not load this review session.',
  )
}

export async function submitReview(
  deckId: string,
  payload: ReviewRequest,
  fetcher: ApiFetch,
): Promise<ReviewResult> {
  return requestDeckJson<ReviewResult>(
    `/api/decks/${encodeURIComponent(deckId)}/review`,
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(
        payload,
      ),
    },
    'Could not save this review.',
  )
}

export async function addCardsToStudyDeck(
  deckId: string,
  cards: CardCreate[],
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  if (cards.length === 0) {
    throw new Error(
      'Choose at least one question to save.',
    )
  }

  const payload: CardBatchCreate = {
    cards,
  }

  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}/cards`,
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(
        payload,
      ),
    },
    'Could not add these questions to the study deck.',
  )
}

export async function updateStudyDeck(
  deckId: string,
  payload: DeckUpdate,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}`,
    fetcher,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not update this study deck.',
  )
}

export async function deleteStudyDeck(
  deckId: string,
  fetcher: ApiFetch,
): Promise<void> {
  const response =
    await fetcher(
      `/api/decks/${encodeURIComponent(deckId)}`,
      {
        method: 'DELETE',
      },
    )

  if (!response.ok) {
    let detail =
      'Could not delete this study deck.'

    try {
      const data =
        await response.json()

      if (
        data &&
        typeof data === 'object' &&
        'detail' in data &&
        typeof data.detail ===
          'string'
      ) {
        detail = data.detail
      }
    } catch {
      // Keep bounded fallback.
    }

    throw new Error(detail)
  }
}

export async function duplicateStudyDeck(
  deckId: string,
  payload: DeckDuplicate,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}/duplicate`,
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not duplicate this study deck.',
  )
}

export async function moveStudyCard(
  deckId: string,
  cardId: string,
  payload: CardMove,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}/move`,
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not move this study card.',
  )
}

export async function updateStudyCard(
  deckId: string,
  cardId: string,
  payload: CardUpdate,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  return requestDeckJson<DeckDetail>(
    `/api/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}`,
    fetcher,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not update this study card.',
  )
}

export async function deleteStudyCard(
  deckId: string,
  cardId: string,
  fetcher: ApiFetch,
): Promise<void> {
  const response =
    await fetcher(
      `/api/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}`,
      {
        method: 'DELETE',
      },
    )

  if (!response.ok) {
    let detail =
      'Could not delete this study card.'

    try {
      const data =
        await response.json()

      if (
        data &&
        typeof data === 'object' &&
        'detail' in data &&
        typeof data.detail ===
          'string'
      ) {
        detail = data.detail
      }
    } catch {
      // Keep bounded fallback.
    }

    throw new Error(detail)
  }
}

