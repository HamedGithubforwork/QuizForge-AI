'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  EXPERIMENT_FIXTURES, EXPERIMENT_PLANS, MODES, buildPrompt,
  inspectCandidate, runAdaptiveFixture, languageMatches,
} = require('../scripts/benchmark-small-qwen-adaptive.cjs')

const get = id => EXPERIMENT_FIXTURES.find(f => f.id === id)
const selected = get('selected_pages')
const plans = EXPERIMENT_PLANS.selected_pages
const cases = [
  ['What material is the Aster casing?', 'cobalt', 'Aster casing material is cobalt.'],
  ['What is the Aster capacity?', '17', 'Aster capacity is 17 samples.'],
  ['What is the Aster sampling interval?', 'five', 'Aster sampling interval is five hours.'],
  ['What is the Boreal casing material?', 'glass', 'Boreal casing material is glass.'],
  ['What is Boreal capacity?', '23', 'Boreal capacity is 23 samples.'],
]
function response(index) {
  const [question, answer, explanation] = cases[index]
  return {
    question,
    choices: [answer, 'unrelated', 'another option', 'something else'],
    correct_index: 0,
    explanation, source_pages: [plans[index].page],
    source_fact: plans[index].quote,
  }
}
test('adaptive prompts preserve exact citations and use explicit French for both quiz types', () => {
  const french = get('biology_french')
  const plan = EXPERIMENT_PLANS.biology_french[0]
  const mcq = buildPrompt(french, plan, 'multiple_choice')
  const retry = buildPrompt(french, plan, 'multiple_choice', 'duplicate_choices')
  const short = buildPrompt(french, plan, 'short_answer')
  assert.match(mcq.messages[0].content, /QUATRE choix différents/)
  assert.match(short.messages[0].content, /correct_answer/)
  assert.ok(mcq.jsonSchema.properties.choices)
  assert.ok(short.jsonSchema.properties.correct_answer)
  assert.equal(short.jsonSchema.properties.choices, undefined)
  assert.equal(mcq.generationProfile, 'quiz-mcq-retry-v1')
  assert.equal(retry.generationProfile, 'quiz-mcq-targeted-retry-v1')
  assert.match(retry.messages[0].content, /duplicate_choices/)
  assert.deepEqual(mcq.messages[1], retry.messages[1])
  assert.equal(languageMatches('What do mitochondria produce?', french), false)
  assert.equal(languageMatches('Que produisent les mitochondries ?', french), true)
  assert.equal(MODES.filter(x => x.questionType === 'short_answer').length, 0)
  assert.equal(MODES.filter(x => x.type === 'short_answer').length, 2)
})
test('source quote and known synthetic oracle cannot be bypassed by correct-looking answer', () => {
  const okay = response(0)
  assert.equal(inspectCandidate(okay, plans[0], selected, 'multiple_choice').reason, null)
  assert.equal(inspectCandidate({ ...okay, choices: ['cobalt', 'cobalt', 'zinc', 'tin'] },
    plans[0], selected, 'multiple_choice').reason, 'duplicate_choices')
  assert.equal(inspectCandidate({ ...okay, source_fact: 'Aster is made of unobtainium' },
    plans[0], selected, 'multiple_choice').reason, 'unsupported_quote_or_answer')
  assert.equal(inspectCandidate({ ...okay, question: 'What color is Boreal?', explanation: 'Boreal is blue.' },
    plans[0], selected, 'multiple_choice').reason, 'semantic_oracle_mismatch')
  assert.equal(inspectCandidate({ ...okay, question: 'What material is Aster made from?',
    explanation: 'Aster is cobalt.' }, plans[0], selected, 'multiple_choice').reason,
    'oracle_wording_mismatch_candidate')
  const used = new Set(['fact:aster_material'])
  assert.equal(inspectCandidate(okay, plans[0], selected, 'multiple_choice', used).reason,
    'duplicate_question_or_fact')
})
test('source-backed short answers are separately verified and unsupported ones rejected', () => {
  const fixture = get('biology')
  const plan = EXPERIMENT_PLANS.biology[0]
  const good = { question: 'What do mitochondria produce?', correct_answer: 'ATP',
    explanation: 'Mitochondria produce ATP during cellular respiration.',
    source_fact: plan.quote, source_pages: [plan.page] }
  assert.equal(inspectCandidate(good, plan, fixture, 'short_answer').reason, null)
  assert.equal(inspectCandidate({ ...good, correct_answer: 'glucose' },
    plan, fixture, 'short_answer').reason, 'unsupported_quote_or_answer')
  assert.equal(inspectCandidate({ ...good, source_pages: [5] },
    plan, fixture, 'short_answer').reason, 'invalid_shape')
})
test('adaptive generation retries invalid choices once, keeps five distinct source facts', async () => {
  let calls = 0
  const provider = {
    async withSession(callback) {
      return callback({ async generate(request) {
        const planIndex = plans.findIndex(p => request.messages[1].content.endsWith(p.quote))
        assert.ok(planIndex >= 0)
        calls++
        const raw = response(planIndex)
        if (calls === 1) raw.choices[1] = raw.choices[0]
        return { text: JSON.stringify(raw), finishReason: 'stop',
          usage: { outputTokens: 25 } }
      } })
    },
  }
  const report = await runAdaptiveFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(calls, 6)
  assert.equal(report.inferenceCalls, 6)
  assert.equal(report.retryCount, 1)
  assert.equal(report.sourceSupportedQuestions, 5)
  assert.equal(report.uniqueSourceFacts, 5)
  assert.equal(report.fullFiveQuestionPass, true)
  assert.equal(report.perFactOutcomes[0].status, 'duplicate_choices')
  assert.equal(report.perFactOutcomes[1].status, 'accepted')
})
test('two bad attempts do not inflate accepted count or loop indefinitely', async () => {
  let calls = 0
  const provider = {
    async withSession(callback) {
      return callback({ async generate() {
        calls++
        return { text: '{bad', finishReason: 'stop' }
      } })
    },
  }
  const report = await runAdaptiveFixture(provider, selected, plans, 'multiple_choice')
  assert.equal(calls, 10)
  assert.equal(report.retryCount, 5)
  assert.equal(report.sourceSupportedQuestions, 0)
  assert.equal(report.fullFiveQuestionPass, false)
  assert.equal(report.perFactOutcomes.every(x => x.status === 'invalid_json'), true)
})
