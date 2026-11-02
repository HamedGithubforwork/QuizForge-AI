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
  engine?: 'local' | 'cloud' | 'manual'
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

/**
 * Local-only fast decisions. Reuse the website's verified deterministic
 * grader for exact/numeric answers and compact typo-tolerant concept aliases.
 * Leave meaningful paraphrases and answers with extra claims to on-device
 * Qwen. Do not apply this policy to the website/cloud review path.
 */
export function localDeterministicAnswerReview(
  question: AiAnswerReviewQuestion,
  answer: string,
  grade: ShortAnswerGrade,
  questionIndex: number,
): AiAnswerReviewDecision | null {
  const normalized = normalizeShortAnswer(answer)
  if (!normalized) return null
  const accepted = [question.correct_answer, ...question.accepted_answers]
    .map(normalizeShortAnswer).filter(Boolean)
  const exact = accepted.includes(normalized)
  // 'concepts' uses the same validated answer groups as the website.
  // A compact fuzzy match is safe only when the whole response has the
  // same number of tokens as a recognized alias. Longer responses might
  // append a contradictory claim; send those to the semantic reviewer.
  const compactConceptMatch = question.grading?.grading_mode === 'concepts' &&
    grade.correct && !grade.borderline &&
    question.grading.answer_groups.some(group => group.some(alias =>
      normalizeShortAnswer(alias).split(' ').length === normalized.split(' ').length))
  const trustedDeterministic = grade.correct && !grade.borderline &&
    (exact || ['numeric', 'exact'].includes(question.grading?.grading_mode ?? '') ||
      compactConceptMatch)
  if (trustedDeterministic) return {
    question_index: questionIndex, verdict: 'correct', credit: 1, confidence: 1,
    engine: 'local', concepts: [],
    reason: 'Your answer matches a supported answer using the local deterministic grading rules.',
  }
  // Only a descriptive question with a long expected answer can safely
  // reject a lone unrelated character without invoking the language model.
  // Do not reject symbols in concise factual, numeric or unit questions.
  const descriptive = /\b(?:function|purpose|role|describe|explain|why|how does|what does)\b/i
    .test(question.question)
  const unsupportedLetter = /^[a-z]$/.test(normalized) &&
    descriptive && normalizeShortAnswer(question.correct_answer).split(' ').length >= 3 &&
    !accepted.includes(normalized) && !grade.correct
  if (unsupportedLetter) return {
    question_index: questionIndex, verdict: 'incorrect', credit: 0, confidence: 1,
    engine: 'local', concepts: [],
    reason: 'A single unrelated letter does not answer this descriptive question.',
  }
  return null
}

export function shouldRequestAiAnswerReview(
  question: AiAnswerReviewQuestion,
  answer: string,
  deterministicGrade: ShortAnswerGrade,
  localReview = false,
) {
  const grading = question.grading
  if (localReview) {
    // Local AI is the second stage, not the default grader. Do not call Qwen
    // for clear deterministic matches or clearly uninformative one-letter
    // replies. Meaningful paraphrases and extra claims still reach Qwen.
    return Boolean(answer.trim()) &&
      !localDeterministicAnswerReview(question, answer, deterministicGrade, 0)
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
