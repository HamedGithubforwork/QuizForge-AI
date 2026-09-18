import {
  getCurrentDocumentSha256,
  normalizeDocumentSha256,
  withDocumentIdentityInQuizData,
} from './documentIdentity'
import {
  DOCUMENT_HISTORY_ANALYSIS_LIMIT,
  normalizeHistoryPageSize,
  QUIZ_HISTORY_PAGE_SIZE,
  type QuizHistoryCursor,
} from './quizHistoryPagination'
import { apiFetch } from './api'
import { createQuizHistoryApi } from './quizHistoryApi'

const historyApi = createQuizHistoryApi(apiFetch)

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
  sourceFilename: string | null
  difficulty: string
  questionType: string
  questionCount: number
  score: number
  percentage: number
  quizData: unknown
  selectedAnswers: StoredSelectedAnswers
}

export type QuizHistoryPage = {
  items: QuizHistoryRow[]
  totalCount: number | null
  hasMore: boolean
  nextCursor: QuizHistoryCursor | null
}

type GetQuizHistoryPageInput = {
  cursor?: QuizHistoryCursor
  limit?: number
}

type GetDocumentHistoryInput = {
  sourceFilename: string
  documentSha256?: string | null
  limit?: number
}

export async function saveQuizHistory(
  input: SaveQuizHistoryInput,
) {
  const sourceFilename =
    input.sourceFilename ?? 'Uploaded PDF'

  const documentSha256 =
    getCurrentDocumentSha256(
      sourceFilename,
    )

  const payload = {
    quiz_title: input.quizTitle,
    source_filename: sourceFilename,
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

  await historyApi.save({ ...payload, document_sha256: documentSha256 })
}

export async function getQuizHistoryPage({
  cursor,
  limit = QUIZ_HISTORY_PAGE_SIZE,
}: GetQuizHistoryPageInput = {}): Promise<QuizHistoryPage> {
  return historyApi.page(normalizeHistoryPageSize(limit), cursor)
}

export async function getQuizHistoryForDocument({
  sourceFilename,
  documentSha256,
  limit = DOCUMENT_HISTORY_ANALYSIS_LIMIT,
}: GetDocumentHistoryInput) {
  return historyApi.document(
    sourceFilename,
    normalizeDocumentSha256(documentSha256),
    normalizeHistoryPageSize(limit),
  )
}

export async function deleteQuizHistory(id: string) {
  await historyApi.delete(id)
}
