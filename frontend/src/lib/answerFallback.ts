import type {
  AnswerReviewCase as ApiAnswerReviewCase,
  AnswerReviewDecision as ApiAnswerReviewDecision,
} from '../types/api.generated.ts'
import {
  normalizeShortAnswer,
  type ShortAnswerGrade,
  type ShortAnswerGradingSpec,
} from './shortAnswerGrader.ts'

export type AiAnswerReviewQuestion = {
  question: string
  correct_answer: string
  accepted_answers: string[]
  explanation: string
  grading?: ShortAnswerGradingSpec
}

export type AiAnswerReviewDecision = Omit<ApiAnswerReviewDecision, 'verdict'> & {
  verdict: 'correct' | 'partial' | 'incorrect' | 'uncertain'
  engine?: 'local' | 'cloud'
  credit?: number | null
  concepts?: Array<{ concept: string; status: 'matched' | 'missing' | 'contradicted'; source_quote: string; answer_quote: string }>
}

export type AiAnswerReviewCase =
  ApiAnswerReviewCase

function meaningfulTokens(
  value: string,
) {
  return new Set(
    normalizeShortAnswer(value)
      .split(' ')
      .filter(
        (token) => token.length >= 4,
      ),
  )
}

function hasRubricTokenOverlap(
  question: AiAnswerReviewQuestion,
  answer: string,
) {
  const grading = question.grading

  if (!grading) {
    return false
  }

  const answerTokens =
    meaningfulTokens(answer)

  if (answerTokens.size === 0) {
    return false
  }

  const rubricTokens = meaningfulTokens(
    [
      question.correct_answer,
      ...question.accepted_answers,
      ...grading.answer_groups.flat(),
    ].join(' '),
  )

  return Array.from(
    answerTokens,
  ).some(
    (token) =>
      rubricTokens.has(token),
  )
}

export function buildAiAnswerReviewKey(
  question: AiAnswerReviewQuestion,
  answer: string,
) {
  const grading = question.grading

  const rubricSignature = grading
    ? JSON.stringify({
        grading_version:
          grading.grading_version,
        grading_mode:
          grading.grading_mode,
        answer_groups:
          grading.answer_groups.map(
            (group) =>
              group.map(
                normalizeShortAnswer,
              ),
          ),
        required_group_count:
          grading.required_group_count,
      })
    : ''

  return [
    normalizeShortAnswer(question.question),
    normalizeShortAnswer(
      question.correct_answer,
    ),
    rubricSignature,
    normalizeShortAnswer(answer),
  ].join('\u241f')
}

export function shouldRequestAiAnswerReview(
  question: AiAnswerReviewQuestion,
  answer: string,
  deterministicGrade: ShortAnswerGrade,
  localReview = false,
) {
  const grading = question.grading
  if (localReview) {
    const exact = [question.correct_answer, ...question.accepted_answers]
      .some(value => normalizeShortAnswer(value) === normalizeShortAnswer(answer))
    return Boolean(answer.trim()) && !exact && !(grading?.grading_mode === 'numeric' && deterministicGrade.correct)
  }

  if (
    deterministicGrade.correct ||
    !grading ||
    grading.grading_version < 2 ||
    grading.grading_mode !== 'concepts'
  ) {
    return false
  }

  const normalized =
    normalizeShortAnswer(answer)

  if (!normalized) {
    return false
  }

  return (
    deterministicGrade.borderline ||
    deterministicGrade.matchedGroups > 0 ||
    hasRubricTokenOverlap(
      question,
      answer,
    )
  )
}

export function buildAiAnswerReviewCase(
  questionIndex: number,
  question: AiAnswerReviewQuestion,
  answer: string,
  localReview = false,
): AiAnswerReviewCase | null {
  const grading = question.grading

  if (
    !localReview && (!grading ||
    grading.grading_version < 2 ||
    grading.grading_mode !== 'concepts')
  ) {
    return null
  }

  return {
    question_index: questionIndex,
    question: question.question,
    correct_answer:
      question.correct_answer,
    accepted_answers:
      question.accepted_answers,
    answer_groups:
      grading?.answer_groups ?? [],
    required_group_count:
      Math.max(1, grading?.required_group_count ?? 1),
    student_answer: answer,
    explanation: question.explanation,
  }
}
