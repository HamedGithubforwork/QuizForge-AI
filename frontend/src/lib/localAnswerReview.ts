import type { AiAnswerReviewCase, AiAnswerReviewDecision } from './answerFallback.ts'
import type { DesktopBridge } from './desktop.ts'

export async function reviewAnswersLocally(
  bridge: Pick<DesktopBridge, 'reviewLocalAnswers'> | undefined,
  cases: AiAnswerReviewCase[],
): Promise<AiAnswerReviewDecision[]> {
  const fallback = (question_index: number): AiAnswerReviewDecision => ({
    question_index, verdict: 'uncertain', confidence: 0, engine: 'local', credit: null, concepts: [],
    reason: 'Local AI review is unavailable. Review this answer against the source; no cloud review was requested.',
  })
  try {
    const result = await bridge?.reviewLocalAnswers?.({ cases: cases.map(c => ({
      question_index: c.question_index, question: c.question, correct_answer: c.correct_answer,
      student_answer: c.student_answer,
    })) })
    return cases.map(c => {
      const matches = result?.ok ? result.decisions.filter(d => d.question_index === c.question_index) : []
      return matches.length === 1 ? matches[0] : fallback(c.question_index)
    })
  } catch { return cases.map(c => fallback(c.question_index)) }
}
