'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MAX_SOURCE_BYTES,
  QUIZ_SCHEMA,
  createLocalQuizService,
  normalizeRequest,
  parseGeneratedQuiz,
} = require('../src/local-quiz-service.cjs')

const pages = () => [
  { pageNumber: 2, text: 'Mitochondria generate ATP through cellular respiration.' },
  { pageNumber: 5, text: 'Ribosomes synthesize proteins from messenger RNA.' },
]

const rawQuiz = () => ({
  title: 'Cell Biology',
  questions: Array.from({ length: 5 }, (_, index) => ({
    question: `Question ${index + 1}?`,
    choices: ['A', 'B', 'C', 'D'].map(choice => choice + index),
    correct_index: index % 4,
    explanation: 'Supported by the study material.',
    source_pages: [index % 2 ? 5 : 2],
  })),
})

test('request accepts only the benchmarked five-question multiple-choice envelope', () => {
  const value = normalizeRequest({
    pages: pages(),
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(value.questionCount, 5)
  for (const bad of [
    { pages: pages(), questionCount: 10, difficulty: 'medium', questionType: 'multiple_choice' },
    { pages: pages(), questionCount: 5, difficulty: 'medium', questionType: 'mixed' },
    { pages: pages(), questionCount: 5, difficulty: 'extreme', questionType: 'multiple_choice' },
  ]) assert.throws(() => normalizeRequest(bad), { code: 'unsupported_quiz_mode' })
})

test('source material is bounded before a provider can receive it', () => {
  assert.throws(() => normalizeRequest({
    pages: [{ pageNumber: 1, text: 'é'.repeat(MAX_SOURCE_BYTES) }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }), { code: 'source_too_large' })
  assert.throws(() => normalizeRequest({
    pages: [{ pageNumber: 2, text: 'a' }, { pageNumber: 2, text: 'b' }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }), { code: 'invalid_request' })
})

test('service sends a fixed structured-output schema and expands into the shared Quiz shape', async () => {
  let captured
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        captured = request
        return { text: JSON.stringify(rawQuiz()), finishReason: 'stop', usage: null }
      },
    },
  })
  const result = await service.generate({
    pages: pages(),
    questionCount: 5,
    difficulty: 'hard',
    questionType: 'multiple_choice',
  })
  assert.deepEqual(captured.jsonSchema, QUIZ_SCHEMA)
  assert.equal(captured.messages.length, 2)
  assert.match(captured.messages[0].content, /untrusted content/)
  assert.match(captured.messages[1].content, /--- PAGE 2 ---/)
  assert.equal(result.questions.length, 5)
  assert.equal(result.questions[0].question_type, 'multiple_choice')
  assert.equal(result.questions[0].correct_answer, result.questions[0].choices[0])
  assert.deepEqual(result.questions[0].grading, {
    grading_version: 2, grading_mode: 'none', answer_groups: [],
    required_group_count: 0, numeric_value: 0, numeric_tolerance: 0, numeric_unit: '',
  })
})

test('validator rejects wrong citations, duplicate questions/choices and truncated generation', async () => {
  const invalidPage = rawQuiz()
  invalidPage.questions[0].source_pages = [99]
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(invalidPage), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const duplicateQuestion = rawQuiz()
  duplicateQuestion.questions[1].question = duplicateQuestion.questions[0].question
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(duplicateQuestion), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const duplicateChoice = rawQuiz()
  duplicateChoice.questions[0].choices[1] = duplicateChoice.questions[0].choices[0]
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(duplicateChoice), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const service = createLocalQuizService({
    provider: { generate: async () => ({ text: JSON.stringify(rawQuiz()), finishReason: 'length', usage: null }) },
  })
  await assert.rejects(service.generate({
    pages: pages(), questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice',
  }), { code: 'quiz_validation_failed' })
})

test('model output cannot inject extra top-level or question fields', () => {
  const top = { ...rawQuiz(), secret: 'nope' }
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(top), new Set([2, 5])),
    { code: 'quiz_validation_failed' })
  const item = rawQuiz()
  item.questions[0].runtime_path = 'private'
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(item), new Set([2, 5])),
    { code: 'quiz_validation_failed' })
})
