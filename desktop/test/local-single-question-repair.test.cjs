'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')

const facts = Array.from({ length: 7 }, (_, index) => ({
  statement: `Specimen ${index + 1} uses code Code0${index + 1}.`,
  answer: `Code0${index + 1}`,
}))
const pages = [{ pageNumber: 2, text: facts.map(fact => fact.statement).join(' ') }]
const practice = { focusPages: [2], avoidQuestions: [] }
function question(index, type = 'short_answer') {
  const fact = facts[index]
  const choices = type === 'multiple_choice'
    ? [fact.answer, 'Other', 'Unknown', 'Absent']
    : type === 'true_false' ? ['True', 'False'] : []
  const answer = type === 'true_false' ? 'True' : fact.answer
  return {
    question_type: type,
    question: `What does the source say about specimen ${index + 1}?`,
    choices, correct_index: type === 'short_answer' ? -1 : 0,
    correct_answer: answer, accepted_answers: [answer],
    explanation: fact.statement, source_pages: [2], source_fact: fact.statement,
  }
}
const reply = questions => ({ finishReason: 'stop',
  text: JSON.stringify({ title: 'Specimen quiz', questions }) })
const request = questionType => ({
  pages, practice, questionCount: 5, difficulty: 'medium', questionType,
})

test('replaces one unsupported short answer without regenerating four verified questions', async () => {
  const original = Array.from({ length: 5 }, (_, index) => question(index))
  original[2].source_fact = 'Fabricated fact absent from the study material.'
  const observed = []
  const issue = []
  const service = createLocalQuizService({
    onValidationIssue: value => issue.push(value),
    provider: {
      async generate(value) {
        observed.push(value)
        return observed.length === 1 ? reply(original) : reply([question(5)])
      },
    },
  })
  const quiz = await service.generate(request('short_answer'))
  assert.equal(observed.length, 2)
  assert.equal(observed[1].jsonSchema.properties.questions.minItems, 1)
  assert.equal(observed[1].jsonSchema.properties.questions.maxItems, 1)
  assert.equal(observed[1].maxTokens, 850)
  assert.match(observed[1].messages.at(-1).content, /Do NOT regenerate them/)
  assert.equal(quiz.questions.length, 5)
  assert.deepEqual(quiz.questions.map(item => item.correct_answer),
    ['Code01', 'Code02', 'Code06', 'Code04', 'Code05'])
  assert.ok(quiz.questions.every(item => !Object.hasOwn(item, 'source_fact')))
  assert.ok(issue.some(value => value.attempt === 'single_question_repair' &&
    value.reason === 'repaired'))
})

test('mixed mode repair targets the missing question type and preserves coverage', async () => {
  const original = [
    question(0, 'multiple_choice'), question(1, 'true_false'),
    question(2, 'short_answer'), question(3, 'true_false'),
    question(4, 'multiple_choice'),
  ]
  original[2].source_fact = 'Not present in PDF.'
  const calls = []
  const service = createLocalQuizService({ provider: {
    async generate(value) {
      calls.push(value)
      return calls.length === 1 ? reply(original) : reply([question(5, 'short_answer')])
    },
  } })
  const result = await service.generate(request('mixed'))
  assert.equal(calls.length, 2)
  assert.match(calls[1].messages[0].content, /Every question must have question_type "short_answer"/)
  assert.deepEqual(new Set(result.questions.map(item => item.question_type)),
    new Set(['multiple_choice', 'true_false', 'short_answer']))
  assert.equal(result.questions[2].correct_answer, 'Code06')
})

test('invented or duplicate-source replacement is rejected without a third full model call', async () => {
  for (const replacement of [
    { ...question(5), source_fact: 'Unsupported invented evidence.' },
    { ...question(5), source_fact: facts[0].statement, correct_answer: facts[0].answer,
      accepted_answers: [facts[0].answer] },
  ]) {
    const original = Array.from({ length: 5 }, (_, index) => question(index))
    original[3].source_fact = 'Invented primary evidence.'
    let calls = 0
    const service = createLocalQuizService({ provider: {
      async generate() { return ++calls === 1 ? reply(original) : reply([replacement]) },
    } })
    await assert.rejects(service.generate(request('short_answer')),
      { code: 'quiz_validation_failed' })
    assert.equal(calls, 2)
  }
})

test('two bad original items use the established full-retry path, not single-item repair', async () => {
  const original = Array.from({ length: 5 }, (_, index) => question(index))
  original[2].source_fact = 'Unsupported fact 1.'
  original[3].source_fact = 'Unsupported fact 2.'
  const calls = []
  const service = createLocalQuizService({ provider: {
    async generate(value) {
      calls.push(value)
      return reply(calls.length === 1 ? original : original.map((_, i) => question(i)))
    },
  } })
  const result = await service.generate(request('short_answer'))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].jsonSchema.oneOf[0].properties.questions.maxItems, 5)
  assert.equal(result.questions.length, 5)
})

test('ordinary five-question responses without source quotes do not enter repair path', async () => {
  const original = Array.from({ length: 5 }, (_, index) => {
    const { source_fact, ...item } = question(index)
    return item
  })
  original[1].correct_answer = 'No such answer'
  const calls = []
  const service = createLocalQuizService({ provider: {
    async generate(value) {
      calls.push(value)
      return reply(calls.length === 1 ? original : original.map((_, i) => {
        const { source_fact, ...item } = question(i)
        return item
      }))
    },
  } })
  const result = await service.generate({
    pages, questionCount: 5, difficulty: 'medium', questionType: 'short_answer',
  })
  assert.equal(calls.length, 2)
  assert.equal(result.questions.length, 5)
  assert.equal(calls[1].jsonSchema.oneOf[0].properties.questions.maxItems, 5)
})
