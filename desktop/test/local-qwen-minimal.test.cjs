'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  EXPERIMENT_FIXTURES, EXPERIMENT_PLANS,
} = require('../scripts/benchmark-small-qwen-adaptive.cjs')
const {
  MINI_SCHEMA, buildMiniPrompt, sourceValue, sourceDistractors,
  verifyMini, runMinimalFixture,
} = require('../scripts/benchmark-qwen-minimal.cjs')

const get = id => EXPERIMENT_FIXTURES.find(x => x.id === id)
const english = get('selected_pages'), french = get('french')
const enPlans = EXPERIMENT_PLANS.selected_pages
const frPlans = EXPERIMENT_PLANS.french
const englishAnswers = ['cobalt', '17', 'five', 'glass', '23']
const englishQuestions = [
  'What is the Aster casing material?',
  'What is the Aster capacity?',
  'What is the Aster sampling interval?',
  'What is the Boreal casing material?',
  'What is the Boreal capacity?',
]
function fakeProvider(make) {
  let calls = 0
  return {
    get calls() { return calls },
    async withSession(fn) {
      return fn({ async generate(prompt) {
        calls++
        const index = enPlans.findIndex(x => prompt.messages[1].content.endsWith(x.quote))
        assert.ok(index >= 0)
        const result = make(index, calls, prompt)
        return { text: typeof result === 'string' ? result : JSON.stringify(result),
          finishReason: 'stop', usage: { outputTokens: 9 } }
      } })
    },
  }
}
test('0.6B asks for only question and answer, no hallucinated choices/citations', () => {
  const p = buildMiniPrompt(french, frPlans[0])
  assert.deepEqual(MINI_SCHEMA.required, ['question', 'answer'])
  assert.equal(MINI_SCHEMA.properties.source_pages, undefined)
  assert.equal(MINI_SCHEMA.properties.choices, undefined)
  assert.match(p.messages[0].content, /Aucune citation ou choix/)
  assert.equal(p.messages[1].content, 'PAGE 1: La station Boréale a ouvert en 2037.')
  const retry = buildMiniPrompt(french, frPlans[0], 'unsupported_answer')
  assert.match(retry.messages[0].content, /unsupported_answer/)
  assert.ok(retry.maxTokens < 550)
})
test('source-derived distractors are extracted from notes, not model-generated', () => {
  assert.equal(sourceValue('Aster casing material is cobalt.'), 'cobalt')
  assert.equal(sourceValue('La station Boréale a ouvert en 2037.'), '2037')
  assert.equal(sourceValue('Le capteur vert mesure la pression.'), 'la pression')
  const values = sourceDistractors(english, enPlans[0], 'cobalt')
  assert.equal(values.length, 3)
  assert.ok(values.includes('17 samples'))
  assert.ok(values.includes('five hours'))
  assert.equal(values.some(x => x.toLowerCase() === 'cobalt'), false)
})
test('a correct model answer is assembled with verified source, page, and unique options', () => {
  const v = verifyMini({ question: englishQuestions[0], answer: englishAnswers[0] },
    english, enPlans[0], 'multiple_choice')
  assert.equal(v.reason, null)
  assert.equal(v.question.source_fact, enPlans[0].quote)
  assert.deepEqual(v.question.source_pages, [2])
  assert.equal(v.question.choices[v.question.correct_index], 'cobalt')
  assert.equal(new Set(v.question.choices).size, 4)
  const short = verifyMini({ question: englishQuestions[0], answer: 'cobalt' },
    english, enPlans[0], 'short_answer')
  assert.equal(short.reason, null)
  assert.equal(short.question.choices, undefined)
  assert.equal(short.question.correct_answer, 'cobalt')
})
test('vague questions cannot be rescued by copying the whole source into explanation', () => {
  assert.equal(verifyMini({ question: 'What is the answer?', answer: 'cobalt' },
    english, enPlans[0], 'multiple_choice').reason, 'ambiguous_question')
  assert.equal(verifyMini({ question: 'What is the Aster capacity?', answer: 'cobalt' },
    english, enPlans[0], 'multiple_choice').reason, 'ambiguous_question')
})
test('fabricated answers, repeated facts and wrong-language outputs are rejected', () => {
  assert.equal(verifyMini({ question: englishQuestions[0], answer: 'titanium' },
    english, enPlans[0], 'multiple_choice').reason, 'unsupported_answer')
  assert.equal(verifyMini({ question: englishQuestions[0], answer: 'cobalt' },
    english, enPlans[0], 'multiple_choice', new Set(['fact:aster_material'])).reason,
  'duplicate_fact_or_question')
  assert.equal(verifyMini({ question: 'Quelle est la matière du boîtier Aster ?', answer: 'cobalt' },
    english, enPlans[0], 'multiple_choice').reason, 'wrong_language')
})
test('five supported simple answers create five distinct source-backed MCQs', async () => {
  const provider = fakeProvider(index => ({
    question: englishQuestions[index], answer: englishAnswers[index],
  }))
  const run = await runMinimalFixture(provider, english, enPlans, 'multiple_choice')
  assert.equal(provider.calls, 5)
  assert.equal(run.inferenceCalls, 5)
  assert.equal(run.retries, 0)
  assert.equal(run.sourceSupportedQuestions, 5)
  assert.equal(run.independentOracleMatches, 5)
  assert.equal(run.uniqueSourceFacts, 5)
  assert.equal(run.fullFiveQuestionPass, true)
  assert.equal(run.suggestLargerModel, false)
})
test('bad answer is retried once without discarding valid questions', async () => {
  const provider = fakeProvider((index, call) => ({
    question: englishQuestions[index],
    answer: call === 1 ? 'fabricated' : englishAnswers[index],
  }))
  const run = await runMinimalFixture(provider, english, enPlans, 'multiple_choice')
  assert.equal(provider.calls, 6)
  assert.equal(run.retries, 1)
  assert.equal(run.fullFiveQuestionPass, true)
  assert.equal(run.perFactOutcomes[0].status, 'unsupported_answer')
  assert.equal(run.perFactOutcomes[1].status, 'accepted')
})
test('unsupported responses yield an honest partial count with bounded attempts', async () => {
  const provider = fakeProvider(() => '{not-json')
  const run = await runMinimalFixture(provider, english, enPlans, 'multiple_choice')
  assert.equal(provider.calls, 10)
  assert.equal(run.retries, 5)
  assert.equal(run.sourceSupportedQuestions, 0)
  assert.equal(run.partialQuestionCount, 0)
  assert.equal(run.suggestLargerModel, true)
  assert.equal(run.fullFiveQuestionPass, false)
  assert.ok(run.perFactOutcomes.every(o => o.status === 'invalid_json'))
})
test('wrong answers cannot be rescued by sourcing invented distractors', () => {
  const invalid = { question: 'What is the Aster casing material?', answer: 'Aster' }
  const result = verifyMini(invalid, english, enPlans[0], 'multiple_choice')
  assert.notEqual(result.reason, null)
})
