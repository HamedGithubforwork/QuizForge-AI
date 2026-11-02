'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES } = require('../scripts/inspect-synthetic-quiz.cjs')
const { PLANS } = require('../scripts/benchmark-small-qwen-scaffold.cjs')
const { buildGroundedPrompt, inspectGroundedQuestion, runGroundedFixture,
  CHECKED_MODEL_IDS } = require('../scripts/benchmark-deepseek-grounded.cjs')

const french = FIXTURES.find(x => x.id === 'french')
const english = FIXTURES.find(x => x.id === 'selected_pages')
const frPlans = PLANS.french, enPlans = PLANS.selected_pages
const examples = {
  french: [
    ['En quelle année la station Boréale a-t-elle ouvert ?', '2037',
      'La station Boréale a ouvert en 2037.'],
    ['Qui est la directrice de la station Boréale ?', 'Léa Morel',
      'La station Boréale a pour directrice Léa Morel.'],
    ['Combien de capteurs possède la station Boréale ?', 'sept',
      'La station Boréale possède sept capteurs.'],
    ['Que mesure le capteur vert ?', 'la pression',
      'Le capteur vert mesure la pression.'],
    ['Que mesure le capteur orange ?', 'l’humidité',
      'Le capteur orange mesure l’humidité.'],
  ],
  selected_pages: [
    ['What is the Aster casing material?', 'cobalt',
      'Aster casing material is cobalt.'],
    ['What is the Aster capacity?', '17',
      'Aster capacity is 17 samples.'],
    ['What is the Aster sampling interval?', 'five',
      'Aster sampling interval is five hours.'],
    ['What is the Boreal casing material?', 'glass',
      'Boreal casing material is glass.'],
    ['What is the Boreal capacity?', '23',
      'Boreal capacity is 23 samples.'],
  ],
}
function response(fixture, index) {
  const [question, answer, explanation] = examples[fixture.id][index]
  const plan = PLANS[fixture.id][index]
  return { question, choices: [answer, 'incorrect A', 'incorrect B', 'incorrect C'],
    correct_index: 0, explanation,
    source_fact: plan.quote, source_pages: [plan.page] }
}
function providerFor(fixture, transform = raw => raw) {
  let calls = 0
  return {
    get calls() { return calls },
    async withSession(callback) {
      return callback({ async generate(request) {
        calls++
        const index = PLANS[fixture.id].findIndex(plan =>
          request.messages[1].content.endsWith(plan.quote))
        assert.ok(index >= 0)
        const raw = transform(response(fixture, index), index, calls, request)
        return { text: typeof raw === 'string' ? raw : JSON.stringify(raw),
          finishReason: 'stop', usage: { outputTokens: 20 } }
      } })
    },
  }
}
test('only the two pinned experimental DeepSeek models are enabled', () => {
  assert.deepEqual(CHECKED_MODEL_IDS, [
    'deepseek-r1-qwen-1p5b-q4-k-m', 'deepseek-r1-qwen-7b-q4-k-m'])
})
test('French prompts identify entity and relationship without leaking a model answer key', () => {
  const original = buildGroundedPrompt(french, frPlans[1])
  const retry = buildGroundedPrompt(french, frPlans[1], {
    retry: true, previousReason: 'oracle_wording_mismatch_candidate',
  })
  const system = original.messages[0].content
  assert.match(system, /station Boréale; directrice/)
  assert.match(system, /nommer explicitement le sujet/)
  assert.doesNotMatch(system, /Léa Morel/)
  assert.equal(original.generationProfile, 'quiz-mcq-v1')
  assert.equal(retry.generationProfile, 'quiz-mcq-retry-v1')
  assert.match(retry.messages[0].content, /oracle_wording_mismatch_candidate/)
  assert.deepEqual(original.messages[1], retry.messages[1])
  assert.equal(original.jsonSchema.properties.choices.minItems, 4)
})
test('English fact-scoped prompt cites only given source without unrelated facts', () => {
  const prompt = buildGroundedPrompt(english, enPlans[0])
  assert.match(prompt.messages[0].content, /ONE unambiguous/)
  assert.match(prompt.messages[0].content, /untrusted/)
  assert.equal(prompt.messages[1].content, 'PAGE 2:\nAster casing material is cobalt.')
})
test('independent oracle accepts correctly attributed French subject facts', () => {
  for (let i = 0; i < frPlans.length; i++) {
    const verdict = inspectGroundedQuestion(response(french, i), french, frPlans[i])
    assert.equal(verdict.reason, null, 'French source fact ' + i)
  }
})
test('vague French pronoun wording stays rejected as candidate, not falsely passed', () => {
  const bad = { ...response(french, 1), question: 'Qui est sa directrice ?',
    explanation: 'Sa directrice est Léa Morel.' }
  assert.equal(inspectGroundedQuestion(bad, french, frPlans[1]).reason,
    'oracle_wording_mismatch_candidate')
})
test('fabricated quotes, unsupported answers, duplicate choices and source pages never pass', () => {
  const correct = response(english, 0)
  assert.equal(inspectGroundedQuestion({ ...correct, source_fact: 'invented text' },
    english, enPlans[0]).reason, 'unsupported_source_quote')
  assert.equal(inspectGroundedQuestion({ ...correct, choices: ['glass', 'x', 'y', 'z'] },
    english, enPlans[0]).reason, 'unsupported_answer')
  assert.equal(inspectGroundedQuestion({ ...correct, choices: ['cobalt', 'COBALT', 'y', 'z'] },
    english, enPlans[0]).reason, 'duplicate_choices')
  assert.equal(inspectGroundedQuestion({ ...correct, source_pages: [4] },
    english, enPlans[0]).reason, 'invalid_shape')
  assert.equal(inspectGroundedQuestion({ ...correct, choices: ['casing', 'a', 'b', 'c'] },
    english, enPlans[0]).reason, 'semantic_oracle_mismatch')
})
test('five correctly grounded French questions require five calls with no retries', async () => {
  const provider = providerFor(french)
  const report = await runGroundedFixture(provider, french, frPlans)
  assert.equal(provider.calls, 5)
  assert.equal(report.strictFiveQuestionPass, true)
  assert.equal(report.independentOracleMatches, 5)
  assert.equal(report.uniqueSourceFacts, 5)
  assert.equal(report.retries, 0)
  assert.equal(report.outputTokens, 100)
})
test('bad 1.5B question retries only its own fact and preserves strict five-fact oracle', async () => {
  const provider = providerFor(english, (raw, index, call) => {
    if (call === 1) raw.choices[1] = raw.choices[0]
    return raw
  })
  const report = await runGroundedFixture(provider, english, enPlans)
  assert.equal(provider.calls, 6)
  assert.equal(report.retries, 1)
  assert.equal(report.strictFiveQuestionPass, true)
  assert.equal(report.perFactOutcomes[0].status, 'duplicate_choices')
  assert.equal(report.perFactOutcomes[1].status, 'accepted')
})
test('malformed model responses cannot loop indefinitely or inflate the pass rate', async () => {
  const provider = providerFor(french, () => '{bad')
  const report = await runGroundedFixture(provider, french, frPlans)
  assert.equal(provider.calls, 10)
  assert.equal(report.retries, 5)
  assert.equal(report.validatedQuestions, 0)
  assert.equal(report.strictFiveQuestionPass, false)
  assert.equal(report.perFactOutcomes.every(x => x.status === 'invalid_json'), true)
})
test('repeated fact cannot be accepted twice under different question wording', () => {
  const used = new Set(['aster_material'])
  const valid = response(english, 0)
  assert.equal(inspectGroundedQuestion(valid, english, enPlans[0], used).reason,
    'duplicate_question_or_fact')
})
