import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewAnswersLocally } from './localAnswerReview.ts'
import { buildAttemptReviewCases, isAttemptQuestionCorrect } from './quizAttempt.ts'
import { buildAiAnswerReviewKey } from './answerFallback.ts'
import { gradeShortAnswer } from './shortAnswerGrader.ts'
import type { QuizQuestion } from '../types/quiz.ts'
const q: QuizQuestion = { question_type: 'short_answer', question: 'What does the nucleus do?',
  correct_answer: 'stores most DNA and controls cell activities', accepted_answers: ['stores most DNA and controls cell activities'],
  explanation: 'DNA storage and cell control.', choices: [], correct_index: -1, source_pages: [1],
  grading: { grading_version: 2, grading_mode: 'exact', answer_groups: [], required_group_count: 0,
    numeric_value: 0, numeric_tolerance: 0, numeric_unit: '' } }
const quiz = { title: 'Biology', questions: [q] }
test('both nucleus paraphrases receive local review instead of a final exact-match rejection', () => {
  for (const answer of ['stores most dna and protects it and controls cell activities', 'It controls cell activities and stores the DNA']) {
    const cases = buildAttemptReviewCases(quiz, { 0: answer }, [0], true)
    assert.equal(cases.length, 1)
    assert.equal(buildAttemptReviewCases(quiz, { 0: answer }, [0], false).length, 0)
    const key = buildAiAnswerReviewKey(q, answer)
    assert.equal(isAttemptQuestionCorrect(q, answer, { [key]: { question_index: 0, verdict: 'correct', confidence: 0.95, reason: 'Both concepts', engine: 'local' } }), true)
  }
  assert.equal(buildAttemptReviewCases(quiz, { 0: q.correct_answer }, [0], true).length, 0)
})
test('local missing runtime and errors produce review-needed without any network request', async () => {
  const original = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('No network permitted') }
  try {
    const cases = buildAttemptReviewCases(quiz, { 0: 'stores DNA' }, [0], true)
    for (const bridge of [undefined, { reviewLocalAnswers: async () => { throw new Error('Offline') } }]) {
      const decisions = await reviewAnswersLocally(bridge, cases)
      assert.equal(decisions[0].verdict, 'uncertain')
    }
    assert.equal(networkCalls, 0)
  } finally { globalThis.fetch = original }
})
test('exact grading preserves negative numeric signs and legacy grading rejects negation', () => {
  assert.equal(gradeShortAnswer({ ...q, correct_answer: '-2', accepted_answers: ['-2'] }, '2').correct, false)
  assert.equal(gradeShortAnswer({ correct_answer: 'nucleus', accepted_answers: ['nucleus'] }, 'not nucleus').correct, false)
})
