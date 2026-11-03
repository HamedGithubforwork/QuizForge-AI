'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  EXPERIMENT_FIXTURES, EXPERIMENT_PLANS, buildPrompt,
  buildPairPrompt, inspectCandidate, runAdaptiveFixture, frenchContext,
} = require('../scripts/benchmark-small-qwen-adaptive.cjs')
const fr = EXPERIMENT_FIXTURES.find(f => f.id === 'french')
const biology = EXPERIMENT_FIXTURES.find(f => f.id === 'biology_french')
const plans = EXPERIMENT_PLANS.french
const cases = [
  ['En quelle année la station Boréale a-t-elle ouvert ?', '2037'],
  ['Qui est la directrice de la station Boréale ?', 'Léa Morel'],
  ['Combien de capteurs possède la station Boréale ?', 'sept'],
  ['Que mesure le capteur vert ?', 'la pression'],
  ['Que mesure le capteur orange ?', 'l’humidité'],
]
function candidate(index, ambiguous = false) {
  const plan = plans[index]
  const [question, answer] = cases[index]
  return { question: ambiguous ? 'Qui est sa directrice ?' : question,
    choices: [answer, 'autre A', 'autre B', 'autre C'],
    correct_index: 0, explanation: plan.quote +
      (ambiguous ? ' La station Boréale a pour directrice Léa Morel.' : ''),
    source_pages: [plan.page], source_fact: plan.quote }
}
test('1.7B French pronoun resolution only uses earlier untrusted page context', () => {
  assert.equal(frenchContext(fr, plans[0]), '')
  assert.equal(frenchContext(fr, plans[1]), plans[0].quote)
  assert.ok(frenchContext(fr, plans[2]).includes('Sa directrice est Léa Morel.'))
  const prompt = buildPrompt(fr, plans[1], 'multiple_choice')
  assert.match(prompt.messages[0].content, /QUESTION ELLE-MÊME/)
  assert.match(prompt.messages[1].content, /CONTEXTE PRÉCÉDENT/)
  assert.match(prompt.messages[1].content, /La station Boréale a ouvert en 2037/)
  assert.ok(prompt.messages[1].content.endsWith(plans[1].quote))
  assert.doesNotMatch(prompt.messages[0].content, /Léa Morel|2037/)
  const retry = buildPrompt(fr, plans[1], 'multiple_choice', 'ambiguous_french_question')
  assert.deepEqual(retry.messages[1], prompt.messages[1])
})
test('French paired requests include read-only context but only cite their own facts', () => {
  const pair = buildPairPrompt(fr, plans[1], plans[2], 'multiple_choice')
  assert.match(pair.messages[1].content, /FACT 1, PAGE 1:/)
  assert.match(pair.messages[1].content, /FACT 2, PAGE 1:/)
  assert.match(pair.messages[1].content, /CONTEXTE PRÉCÉDENT NON CITABLE/)
  assert.match(pair.messages[0].content, /Chaque QUESTION doit nommer le sujet/)
})
test('a vague French question fails even if the explanation supplies the missing context', () => {
  const bad = inspectCandidate(candidate(1, true), plans[1], fr, 'multiple_choice')
  assert.equal(bad.reason, 'ambiguous_french_question')
  const good = inspectCandidate(candidate(1), plans[1], fr, 'multiple_choice')
  assert.equal(good.reason, null)
})
test('five independent French questions still pass the original strict oracle', () => {
  for (let i = 0; i < 5; i++) {
    const checked = inspectCandidate(candidate(i), plans[i], fr, 'multiple_choice')
    assert.equal(checked.reason, null, 'French source fact ' + i)
  }
})
test('biology French question and short answer both need explicit source-subject cues', () => {
  const plan = EXPERIMENT_PLANS.biology_french[0]
  const yes = { question: 'Que produisent les mitochondries ?', correct_answer: 'ATP',
    explanation: 'Les mitochondries produisent de l’ATP.',
    source_fact: plan.quote, source_pages: [plan.page] }
  const good = inspectCandidate(yes, plan, biology, 'short_answer')
  assert.equal(good.reason, null)
  const vague = inspectCandidate({ ...yes, question: 'Que produisent-elles ?' },
    plan, biology, 'short_answer')
  assert.equal(vague.reason, 'ambiguous_french_question')
})
test('French single-fact path retries only the ambiguous item; other valid facts survive', async () => {
  let calls = 0
  const provider = {
    async withSession(callback) {
      return callback({ async generate(prompt) {
        calls++
        const index = plans.findIndex(p => prompt.messages[1].content.endsWith(p.quote))
        assert.ok(index >= 0)
        const raw = candidate(index, index === 1 && calls === 2)
        return { text: JSON.stringify(raw), finishReason: 'stop',
          usage: { outputTokens: 20 } }
      } })
    },
  }
  const run = await runAdaptiveFixture(provider, fr, plans, 'multiple_choice')
  assert.equal(calls, 6)
  assert.equal(run.retryCount, 1)
  assert.equal(run.sourceSupportedQuestions, 5)
  assert.equal(run.independentOracleMatches, 5)
  assert.equal(run.fullFiveQuestionPass, true)
  assert.equal(run.perFactOutcomes.filter(x => x.status === 'ambiguous_french_question').length, 1)
})
