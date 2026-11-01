'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLocalAnswerReview, normalizeReview } = require('../src/local-answer-review.cjs')
const { applyDuplicates, reviewQuizDistinctness } = require('../src/local-quiz-distinctness.cjs')
const source = 'The nucleus stores most of the cell DNA and helps control cell activities.'
const answer = 'stores most dna and protects it and controls cell activities'
const question = { question_type: 'short_answer', question: 'What are the main functions of the nucleus?', correct_answer: 'stores most of the cell DNA and helps control cell activities', source_pages: [1] }
const valid = { confidence: 0.95, reason: 'Both required functions are expressed.', uncertain: false, contradiction: false,
  concepts: [
    { concept: 'Stores DNA', status: 'matched', source_quote: 'stores most of the cell DNA', answer_quote: 'stores most dna' },
    { concept: 'Controls cell activities', status: 'matched', source_quote: 'helps control cell activities', answer_quote: 'controls cell activities' },
  ] }
test('grade derives full, partial, contradictory and uncertain outcomes from validated concept evidence', () => {
  assert.equal(normalizeReview(valid, 0, source, answer).verdict, 'correct')
  const partial = structuredClone(valid)
  partial.concepts[1].status = 'missing'; partial.concepts[1].answer_quote = ''
  assert.equal(normalizeReview(partial, 0, source, 'stores most dna').credit, 0.5)
  // Reproduces real pinned-Qwen response: one evidenced concept matched,
  // one evidenced concept missing and 0.75 model confidence.
  partial.confidence = 0.75
  assert.equal(normalizeReview(partial, 0, source, 'stores most dna').verdict, 'partial')
  partial.confidence = 0.69
  assert.equal(normalizeReview(partial, 0, source, 'stores most dna').verdict, 'uncertain')
  assert.equal(normalizeReview({ ...valid, confidence: 0.75 }, 0, source, answer).verdict, 'uncertain')
  assert.equal(normalizeReview({ ...valid, contradiction: true, confidence: 0.75 }, 0, source, answer).verdict, 'uncertain')
  assert.equal(normalizeReview({ ...valid, contradiction: true }, 0, source, answer).verdict, 'incorrect')
  assert.equal(normalizeReview({ ...valid, confidence: 0.5 }, 0, source, answer).verdict, 'uncertain')
  const fabricated = structuredClone(valid); fabricated.concepts[0].source_quote = 'The nucleus makes all proteins'
  assert.equal(normalizeReview(fabricated, 0, source, answer).verdict, 'uncertain')
  const fabricatedStudent = structuredClone(valid); fabricatedStudent.concepts[0].answer_quote = 'I never wrote this'
  assert.equal(normalizeReview(fabricatedStudent, 0, source, answer).verdict, 'uncertain')
})
test('review uses only supplied local provider, bounds malformed output and never reviews a stale quiz', async () => {
  let calls = 0
  const service = createLocalAnswerReview({ provider: { async generate(request) {
    calls++; assert.equal(request.generationProfile, 'answer-review-v1')
    assert.ok(request.messages[1].content.includes(source))
    return { text: JSON.stringify(valid), finishReason: 'stop' }
  } } })
  const request = { cases: [{ question_index: 0, question: question.question, correct_answer: question.correct_answer, student_answer: answer }] }
  const context = { quiz: { questions: [question] }, pages: [{ pageNumber: 1, text: source }] }
  assert.equal((await service.review(request, context)).decisions[0].verdict, 'correct')
  assert.equal(calls, 1)
  assert.equal((await service.review(request, {})).decisions[0].verdict, 'uncertain')
  assert.equal(calls, 1)
  await assert.rejects(service.review({ cases: [...request.cases, ...request.cases] }, context), { code: 'invalid_request' })
})
test('semantic duplicate review removes reversed facts with shared evidence and preserves other concepts', async () => {
  const quiz = { questions: [
    { ...question, question: 'What does the nucleus store?', correct_answer: 'DNA' },
    { ...question, question: 'Which cell structure stores DNA?', correct_answer: 'nucleus' },
    { ...question, question: 'What does the nucleus control?', correct_answer: 'cell activities' },
  ] }
  const pairs = [{ keep: 0, remove: 1, fact: 'The nucleus stores DNA', source_quote: 'nucleus stores most of the cell DNA' }]
  assert.equal(applyDuplicates(quiz, [{ pageNumber: 1, text: source }], pairs).length, 2)
  assert.throws(() => applyDuplicates(quiz, [], pairs))
  const result = await reviewQuizDistinctness({ quiz, pages: [], provider: { generate() { throw new Error('Unavailable') } } })
  assert.equal(result.questions.length, 3)
  assert.equal(result.generation.distinctness, 'unavailable')
})
