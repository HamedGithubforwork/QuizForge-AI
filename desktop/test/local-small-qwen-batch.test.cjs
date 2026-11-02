'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  EXPERIMENT_FIXTURES, EXPERIMENT_PLANS, MODES, buildPairPrompt,
  runBatchedFixture,
} = require('../scripts/benchmark-small-qwen-adaptive.cjs')

const selected = EXPERIMENT_FIXTURES.find(f => f.id === 'selected_pages')
const plans = EXPERIMENT_PLANS.selected_pages
const cases = [
  ['What material is the Aster casing?', 'cobalt', 'Aster casing material is cobalt.'],
  ['What is the Aster capacity?', '17', 'Aster capacity is 17 samples.'],
  ['What is the Aster sampling interval?', 'five', 'Aster sampling interval is five hours.'],
  ['What is the Boreal casing material?', 'glass', 'Boreal casing material is glass.'],
  ['What is the Boreal capacity?', '23', 'Boreal capacity is 23 samples.'],
]
function response(index) {
  const [question, answer, explanation] = cases[index]
  return {
    question,
    choices: [answer, 'unrelated', 'another option', 'something else'],
    correct_index: 0,
    explanation,
    source_pages: [plans[index].page],
    source_fact: plans[index].quote,
  }
}
function fakeProvider(createResponse) {
  let calls = 0
  return {
    get calls() { return calls },
    async withSession(callback) {
      return callback({
        async generate(request) {
          calls++
          const value = createResponse(request, calls)
          return typeof value === 'string'
            ? { text: value, finishReason: 'stop', usage: { outputTokens: 7 } }
            : value
        },
      })
    },
  }
}
function indices(request) {
  return plans.flatMap((plan, index) =>
    request.messages[1].content.includes(plan.quote) ? [index] : [])
}

test('1.7B batch request has two independently cited questions and distinct MCQ/short schemas', () => {
  const english = buildPairPrompt(selected, plans[0], plans[1], 'multiple_choice')
  assert.equal(english.jsonSchema.properties.questions.minItems, 2)
  assert.equal(english.jsonSchema.properties.questions.maxItems, 2)
  assert.ok(english.jsonSchema.properties.questions.items.properties.choices)
  assert.match(english.messages[0].content, /two|TWO/)
  assert.match(english.messages[1].content, /FACT 1, PAGE 2:/)
  assert.match(english.messages[1].content, /FACT 2, PAGE 2:/)
  const french = EXPERIMENT_FIXTURES.find(f => f.id === 'biology_french')
  const frenchPlans = EXPERIMENT_PLANS.biology_french
  const short = buildPairPrompt(french, frenchPlans[0], frenchPlans[1], 'short_answer')
  assert.match(short.messages[0].content, /en français/)
  assert.ok(short.jsonSchema.properties.questions.items.properties.correct_answer)
  assert.equal(short.jsonSchema.properties.questions.items.properties.choices, undefined)
  assert.equal(MODES.filter(mode => mode.type === 'short_answer').length, 2)
})
test('valid paired responses need three calls instead of five and retain five distinct facts', async () => {
  const provider = fakeProvider(request => {
    const found = indices(request)
    const raw = found.length === 2
      ? { questions: found.map(response) }
      : response(found[0])
    return JSON.stringify(raw)
  })
  const report = await runBatchedFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(provider.calls, 3)
  assert.equal(report.batchCalls, 2)
  assert.equal(report.batchAcceptedQuestions, 4)
  assert.equal(report.inferenceCalls, 3)
  assert.equal(report.retryCount, 0)
  assert.equal(report.sourceSupportedQuestions, 5)
  assert.equal(report.uniqueSourceFacts, 5)
  assert.equal(report.fullFiveQuestionPass, true)
})
test('one bad candidate triggers only its own single-question retry', async () => {
  const provider = fakeProvider(request => {
    const found = indices(request)
    if (found.length === 2) {
      const questions = found.map(response)
      if (found[0] === 0) questions[1].choices[1] = questions[1].choices[0]
      return JSON.stringify({ questions })
    }
    return JSON.stringify(response(found[0]))
  })
  const report = await runBatchedFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(provider.calls, 4)
  assert.equal(report.batchCalls, 2)
  assert.equal(report.batchAcceptedQuestions, 3)
  assert.equal(report.retryCount, 1)
  assert.equal(report.sourceSupportedQuestions, 5)
  assert.equal(report.fullFiveQuestionPass, true)
  assert.deepEqual(
    report.perFactOutcomes.filter(row => row.factIndex === 2).map(row => row.status),
    ['duplicate_choices', 'accepted'],
  )
})
test('bad batches and singles are bounded, do not count unsupported questions', async () => {
  const provider = fakeProvider(() => '{invalid')
  const report = await runBatchedFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(provider.calls, 8) // two batches, four targeted retries, two fifth-fact attempts
  assert.equal(report.retryCount, 5)
  assert.equal(report.batchAcceptedQuestions, 0)
  assert.equal(report.sourceSupportedQuestions, 0)
  assert.equal(report.fullFiveQuestionPass, false)
  assert.equal(report.perFactOutcomes.every(row => row.status === 'invalid_json'), true)
})
test('repeated facts are rejected before assembling a five-question pass', async () => {
  const provider = fakeProvider(request => {
    const found = indices(request)
    if (found.length === 2) {
      const questions = found.map(response)
      if (found[0] === 0) questions[1] = response(0)
      return JSON.stringify({ questions })
    }
    return JSON.stringify(response(found[0]))
  })
  const report = await runBatchedFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(report.fullFiveQuestionPass, true)
  assert.equal(report.sourceSupportedQuestions, 5)
  assert.equal(report.uniqueSourceFacts, 5)
  assert.equal(report.retryCount, 1)
  assert.equal(report.perFactOutcomes.some(row => row.status === 'duplicate_question_or_fact' ||
    row.status === 'semantic_oracle_mismatch' ||
    row.status === 'unsupported_quote_or_answer'), true)
})
