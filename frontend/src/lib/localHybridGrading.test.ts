import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAttemptReviewCases } from './quizAttempt.ts'
import { localDeterministicAnswerReview } from './answerFallback.ts'
import { gradeShortAnswer } from './shortAnswerGrader.ts'
import type { QuizQuestion } from '../types/quiz.ts'

const grading = (answers: string[][]) => ({
  grading_version: 2, grading_mode: 'concepts' as const,
  answer_groups: answers, required_group_count: 1,
  numeric_value: 0, numeric_tolerance: 0, numeric_unit: '',
})
const question = (prompt: string, correct: string, aliases: string[] = []): QuizQuestion => ({
  question_type: 'short_answer', question: prompt,
  correct_answer: correct, accepted_answers: [correct, ...aliases],
  choices: [], correct_index: -1, explanation: correct, source_pages: [1],
  grading: grading([[correct, ...aliases]]),
})
function check(q: QuizQuestion, answer: string) {
  const grade = gradeShortAnswer(q, answer)
  const auto = localDeterministicAnswerReview(q, answer, grade, 0)
  const reviews = buildAttemptReviewCases({ title: 'Biology', questions: [q] }, { 0: answer }, [0], true)
  return { grade, auto, reviews }
}

test('local first stage accepts verified concept aliases and minor typo without Qwen', () => {
  const q = question('Which process produces ATP?', 'photosynthesis')
  const exact = check(q, 'photosynthesis')
  assert.equal(exact.auto?.verdict, 'correct')
  assert.equal(exact.reviews.length, 0)
  const typo = check(q, 'photosynthesi')
  assert.equal(typo.grade.correct, true)
  assert.equal(typo.auto?.verdict, 'correct')
  assert.equal(typo.reviews.length, 0)
})

test('descriptive one-letter nonsense is incorrect immediately but a one-letter scientific answer is not silently rejected', () => {
  const membrane = question('What is the main function of the cell membrane?',
    'Controls what enters and leaves the cell. It is selectively permeable.')
  const oneLetter = check(membrane, 's')
  assert.equal(oneLetter.auto?.verdict, 'incorrect')
  assert.equal(oneLetter.auto?.credit, 0)
  assert.equal(oneLetter.reviews.length, 0)
  const symbol = question('What is the chemical symbol?', 'O')
  const different = check(symbol, 's')
  assert.equal(different.auto, null)
  assert.equal(different.reviews.length, 1)
})

test('meaningful membrane paraphrase still goes to on-device Qwen', () => {
  const q = question('What is the main function of the cell membrane?',
    'Controls what enters and leaves the cell. It is selectively permeable.')
  const result = check(q, 'acts as a barrier that regulates what goes in and out')
  assert.equal(result.auto, null)
  assert.equal(result.reviews.length, 1)
})

test('partial nucleus answer or extra potentially contradictory claims cannot bypass semantic review', () => {
  const q = question('What does the nucleus do?',
    'Stores most of the cell DNA and controls cell activities.')
  for (const answer of ['stores DNA', 'stores most dna and protects it and controls cell activities',
    'Stores most of the cell DNA and controls cell activities but also destroys all DNA']) {
    const result = check(q, answer)
    assert.equal(result.auto, null)
    assert.equal(result.reviews.length, 1)
  }
})

test('verified numeric/exact list equivalents retain fast local credit', () => {
  const q = question('Which inputs are required?', 'Carbon dioxide, water, light')
  q.grading = { ...grading([]), grading_mode: 'exact', answer_groups: [] }
  const matched = check(q, 'water, CO2, sunlight')
  assert.equal(matched.grade.correct, true)
  assert.equal(matched.auto?.verdict, 'correct')
  assert.equal(matched.reviews.length, 0)
  assert.equal(check(q, 'water, CO2, moonlight').reviews.length, 1)
})

test('cloud mode retains its own selection policy and never auto-uses local rules', () => {
  const q = question('What is the main function of the cell membrane?',
    'Controls what enters and leaves the cell. It is selectively permeable.')
  const quiz = { title: 'Science', questions: [q] }
  assert.equal(buildAttemptReviewCases(quiz, { 0: 's' }, [0], false).length, 0)
  assert.equal(buildAttemptReviewCases(quiz, { 0: 's' }, [0], true).length, 0)
})
