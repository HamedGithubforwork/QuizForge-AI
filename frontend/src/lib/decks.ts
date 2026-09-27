import type {
  CardCreate,
  DeckCreate,
  DeckDetail,
} from '../types/api.generated'
import type {
  QuizResult,
  UploadResult,
} from '../types/quiz'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

export function buildDeckCards(
  quiz: QuizResult,
  documentResult: UploadResult,
): CardCreate[] {
  return quiz.questions.map(
    (question) => ({
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
    }),
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

export async function createStudyDeck(
  payload: DeckCreate,
  fetcher: ApiFetch,
): Promise<DeckDetail> {
  const response = await fetcher(
    '/api/decks',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
  )

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
        : 'Could not save this study deck.'

    throw new Error(detail)
  }

  return data as DeckDetail
}
