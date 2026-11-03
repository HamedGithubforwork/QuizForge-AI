'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')

const facts = [
  { page: 2, source: 'Aster casing material is cobalt.', answer: 'cobalt', question: 'What is Aster casing material?' },
  { page: 2, source: 'Aster capacity is 17 samples.', answer: '17 samples', question: 'What is Aster capacity?' },
  { page: 2, source: 'Aster sampling interval is five hours.', answer: 'five hours', question: 'What is Aster sampling interval?' },
  { page: 4, source: 'Boreal casing material is glass.', answer: 'glass', question: 'What is Boreal casing material?' },
  { page: 4, source: 'Boreal capacity is 23 samples.', answer: '23 samples', question: 'What is Boreal capacity?' },
  { page: 4, source: 'Boreal sampling interval is seven hours.', answer: 'seven hours', question: 'What is Boreal sampling interval?' },
]
const pages = [2, 4].map(pageNumber => ({
  pageNumber,
  text: facts.filter(fact => fact.page === pageNumber).map(fact => fact.source).join(' '),
}))
// The speculative early recovery now requires real fact headroom.
// Preserve its original behavior tests with ten independently quoted facts;
// the six-fact routing regression lives in local-quiz-service.test.cjs.
const amplePages = [2, 4].map(pageNumber => ({
  pageNumber,
  text: [
    ...facts.filter(fact => fact.page === pageNumber).map(fact => fact.source),
    ...(pageNumber === 2
      ? ['Aster battery type is lithium.', 'Aster lens shape is circular.']
      : ['Boreal battery type is nickel.', 'Boreal lens shape is square.']),
  ].join(' '),
}))
const candidates = facts.map(fact => ({
  question: fact.question,
  choices: [fact.answer, 'unrelated one', 'unrelated two', 'unrelated three'],
  correct_index: 0,
  explanation: fact.source,
  source_fact: fact.source,
  source_pages: [fact.page],
}))
const request = {
  pages, questionCount: 5, difficulty: 'medium',
  questionType: 'multiple_choice',
  practice: { focusPages: [2], avoidQuestions: [
    'Which material was previously asked about?',
    'Which capacity was previously asked about?',
  ] },
}

test('rich targeted practice tries the already-strict recovery without two wasted abstentions', async () => {
  let calls = 0
  const service = createLocalQuizService({
    provider: { async generate(prompt) {
      calls++
      assert.equal(prompt.generationProfile, 'quiz-mcq-v1')
      assert.equal(prompt.jsonSchema.properties.questions.minItems, 5)
      assert.equal(prompt.jsonSchema.properties.questions.items.required.includes('source_fact'), true)
      return { finishReason: 'stop', text: JSON.stringify({
        title: 'Grounded practice', questions: candidates.slice(0, 5),
      }) }
    } },
  })
  const quiz = await service.generate({ ...request, pages: amplePages })
  assert.equal(calls, 1)
  assert.equal(quiz.questions.length, 5)
  assert.equal(new Set(quiz.questions.map(q => q.question)).size, 5)
  assert.ok(quiz.questions.every(q => !Object.hasOwn(q, 'source_fact')))
})

test('invalid early recovery preserves established targeted generation fallback', async () => {
  let calls = 0
  const issues = []
  const service = createLocalQuizService({
    onValidationIssue(issue) { issues.push(issue) },
    provider: { async generate(prompt) {
      calls++
      if (calls === 1) {
        assert.equal(prompt.generationProfile, 'quiz-mcq-v1')
        return { finishReason: 'stop', text: JSON.stringify({
          title: 'Insufficient source material', questions: [],
        }) }
      }
      assert.equal(prompt.generationProfile, 'quiz-mcq-targeted-primary-v1')
      return { finishReason: 'stop', text: JSON.stringify({
        title: 'Grounded backup pool', questions: candidates,
      }) }
    } },
  })
  const quiz = await service.generate({ ...request, pages: amplePages })
  assert.equal(calls, 2)
  assert.equal(quiz.questions.length, 5)
  assert.ok(issues.some(issue => issue.attempt === 'fast_recovery' &&
    issue.reason === 'insufficient_source'))
})

test('six-fact weak-area practice goes to strict recovery after one model abstention', async () => {
  let calls = 0
  const issues = []
  const service = createLocalQuizService({
    onValidationIssue(issue) { issues.push(issue) },
    provider: { async generate(prompt) {
      calls++
      if (calls === 1) {
        assert.equal(prompt.generationProfile, 'quiz-mcq-targeted-primary-v1')
        return { finishReason: 'stop', text: JSON.stringify({
          title: 'Insufficient source material', questions: [],
        }) }
      }
      assert.equal(calls, 2, 'skip a redundant strict-targeted retry')
      assert.equal(prompt.generationProfile, 'quiz-mcq-v1')
      assert.ok(prompt.messages.some(message =>
        message.content.includes('SOURCE-VERIFIED FACT CANDIDATES')))
      return { finishReason: 'stop', text: JSON.stringify({
        title: 'Source-verified follow-up', questions: candidates.slice(0, 5),
      }) }
    } },
  })
  const quiz = await service.generate(request)
  assert.equal(calls, 2)
  assert.equal(quiz.questions.length, 5)
  assert.deepEqual(issues.map(issue => [issue.attempt, issue.reason]), [
    ['primary', 'insufficient_source'],
  ])
  assert.ok(quiz.questions.every(question =>
    !Object.hasOwn(question, 'source_fact') &&
    !request.practice.avoidQuestions.includes(question.question)))
})

test('one-page targeted practice keeps its existing candidate-pool path', async () => {
  const onePage = {
    pageNumber: 2,
    text: facts.map(fact => fact.source).join(' '),
  }
  const onePageCandidates = candidates.map(candidate => ({
    ...candidate, source_pages: [2],
  }))
  let calls = 0
  const service = createLocalQuizService({
    provider: { async generate(prompt) {
      calls++
      assert.equal(prompt.generationProfile, 'quiz-mcq-targeted-primary-v1')
      return { finishReason: 'stop', text: JSON.stringify({
        title: 'Grounded candidate pool', questions: onePageCandidates,
      }) }
    } },
  })
  const quiz = await service.generate({ ...request, pages: [onePage],
    practice: { avoidQuestions: request.practice.avoidQuestions } })
  assert.equal(calls, 1)
  assert.equal(quiz.questions.length, 5)
})
