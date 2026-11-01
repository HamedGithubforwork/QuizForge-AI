import type { AiAnswerReviewCase, AiAnswerReviewDecision } from './answerFallback.ts'
import type { DesktopBridge } from './desktop.ts'

export async function reviewAnswersLocally(
  bridge: Pick<DesktopBridge, 'reviewLocalAnswers'> | undefined,
  cases: AiAnswerReviewCase[],
): Promise<AiAnswerReviewDecision[]> {
  const fallback = (question_index: number, code = 'review_unavailable'): AiAnswerReviewDecision => {
    const details: Record<string, string> = {
      busy: 'The local model is busy with another operation.',
      account_unavailable: 'Your desktop sign-in is no longer active. Sign in again before reviewing answers.',
      review_context_missing: 'The original local quiz source is no longer available for grading. Generate a new local quiz to restore the review context.',
      cancelled: 'Local AI review was cancelled.',
      timed_out: 'The local model took too long to review this answer.',
      model_missing: 'The local model is not installed or ready.',
      invalid_model: 'The local model failed validation.',
      runtime_invalid: 'The local AI runtime failed validation.',
      runtime_unavailable: 'The local AI runtime could not start or complete the review.',
      invalid_request: 'The desktop app could not validate this review request.',
      invalid_response: 'The local model returned an invalid review response.',
      bridge_missing: 'This desktop build does not expose Local AI grading.',
      missing_decision: 'The local model did not return a decision for this answer.',
      desktop_connection_failed: 'The desktop connection refused this review request. Try again after reopening the quiz screen.',
    }
    return {
      question_index, verdict: 'uncertain', confidence: 0, engine: 'local', credit: null, concepts: [],
      reason: `${details[code] ?? 'Local AI review is unavailable.'} You can retry the review or compare against the source; no cloud review was requested.`,
    }
  }
  if (!bridge?.reviewLocalAnswers) return cases.map(c => fallback(c.question_index, 'bridge_missing'))
  try {
    const result = await bridge.reviewLocalAnswers({ cases: cases.map(c => ({
      question_index: c.question_index, question: c.question, correct_answer: c.correct_answer,
      student_answer: c.student_answer,
    })) })
    if (!result?.ok) return cases.map(c => fallback(c.question_index, result?.error))
    return cases.map(c => {
      const matches = Array.isArray(result.decisions)
        ? result.decisions.filter(d => d.question_index === c.question_index) : []
      return matches.length === 1 ? matches[0] : fallback(c.question_index, 'missing_decision')
    })
  } catch { return cases.map(c => fallback(c.question_index, 'desktop_connection_failed')) }
}
