import type { QuizHistoryPage, QuizHistoryRow } from './quizHistory'
import type { QuizHistoryCursor } from './quizHistoryPagination'

type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>

async function requireSuccess(response: Response) {
  if (!response.ok) {
    let message = 'Quiz history is temporarily unavailable.'
    try {
      const body = await response.json()
      if (typeof body.detail === 'string') message = body.detail
    } catch {
      // A gateway error may not contain JSON.
    }
    throw new Error(message)
  }
}

export function createQuizHistoryApi(request: AuthenticatedFetch) {
  return {
    async save(payload: Record<string, unknown>) {
      const response = await request('/api/quiz-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await requireSuccess(response)
    },
    async page(limit: number, cursor?: QuizHistoryCursor): Promise<QuizHistoryPage> {
      const params = new URLSearchParams({ limit: String(limit) })
      if (cursor) {
        params.set('cursor_created_at', cursor.createdAt)
        params.set('cursor_id', cursor.id)
      }
      const response = await request(`/api/quiz-history?${params}`)
      await requireSuccess(response)
      return response.json()
    },
    async document(sourceFilename: string, documentSha256: string | null, limit: number): Promise<QuizHistoryRow[]> {
      const params = new URLSearchParams({ source_filename: sourceFilename, limit: String(limit) })
      if (documentSha256) params.set('document_sha256', documentSha256)
      const response = await request(`/api/quiz-history/document?${params}`)
      await requireSuccess(response)
      return response.json()
    },
    async delete(id: string) {
      const response = await request(`/api/quiz-history/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await requireSuccess(response)
    },
  }
}
