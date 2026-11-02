'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES } = require('../scripts/inspect-synthetic-quiz.cjs')
const { PLANS } = require('../scripts/benchmark-small-qwen-scaffold.cjs')
const { buildBatchPrompt, runSevenBFixture } =
  require('../scripts/benchmark-deepseek-grounded.cjs')

const cases = {
  selected_pages: [
    ['What is the Aster casing material?', 'cobalt', 'Aster casing material is cobalt.'],
    ['What is the Aster capacity?', '17', 'Aster capacity is 17 samples.'],
    ['What is the Aster sampling interval?', 'five', 'Aster sampling interval is five hours.'],
    ['What is the Boreal casing material?', 'glass', 'Boreal casing material is glass.'],
    ['What is the Boreal capacity?', '23', 'Boreal capacity is 23 samples.'],
  ],
  french: [
    ['En quelle année la station Boréale a-t-elle ouvert ?', '2037', 'La station Boréale a ouvert en 2037.'],
    ['Qui est la directrice de la station Boréale ?', 'Léa Morel', 'La station Boréale a pour directrice Léa Morel.'],
    ['Combien de capteurs possède la station Boréale ?', 'sept', 'La station Boréale possède sept capteurs.'],
    ['Que mesure le capteur vert ?', 'la pression', 'Le capteur vert mesure la pression.'],
    ['Que mesure le capteur orange ?', 'l’humidité', 'Le capteur orange mesure l’humidité.'],
  ],
}
const fixture = id => FIXTURES.find(x => x.id === id)
function response(id, index) {
  const [question, answer, explanation] = cases[id][index]
  return { question, choices: [answer, 'incorrect A', 'incorrect B', 'incorrect C'],
    correct_index: 0, explanation,
    source_pages: [PLANS[id][index].page], source_fact: PLANS[id][index].quote }
}
function fakeProvider(id, transform = (data => data)) {
  let count = 0
  return {
    get calls() { return count },
    async withSession(callback) {
      return callback({ async generate(request) {
        count++
        const selected = PLANS[id].flatMap((p, i) =>
          request.messages[1].content.includes(p.quote) ? [i] : [])
        assert.ok(selected.length === 1 || selected.length === 2)
        const data = selected.length === 2
          ? { questions: selected.map(i => response(id, i)) }
          : response(id, selected[0])
        const changed = transform(data, selected, count, request)
        return { text: typeof changed === 'string' ? changed : JSON.stringify(changed),
          finishReason: 'stop', usage: { outputTokens: 24 } }
      } })
    },
  }
}
test('7B paired French prompt explicitly names both source subjects', () => {
  const fr = fixture('french')
  const prompt = buildBatchPrompt(fr, PLANS.french[0], PLANS.french[1])
  assert.match(prompt.messages[0].content, /station Boréale; ouverture/)
  assert.match(prompt.messages[0].content, /station Boréale; directrice/)
  assert.doesNotMatch(prompt.messages[0].content, /Léa Morel/)
  assert.equal(prompt.jsonSchema.properties.questions.minItems, 2)
  assert.equal(prompt.jsonSchema.properties.questions.maxItems, 2)
  assert.equal(prompt.jsonSchema.properties.questions.items.properties.choices.minItems, 4)
  assert.match(prompt.messages[1].content, /FACT 1 PAGE 1/)
  assert.match(prompt.messages[1].content, /FACT 2 PAGE 1/)
})
test('good 7B English two-fact responses complete five facts in three calls', async () => {
  const provider = fakeProvider('selected_pages')
  const result = await runSevenBFixture(provider, fixture('selected_pages'), PLANS.selected_pages)
  assert.equal(provider.calls, 3)
  assert.equal(result.batchCalls, 2)
  assert.equal(result.batchAcceptedQuestions, 4)
  assert.equal(result.inferenceCalls, 3)
  assert.equal(result.retries, 0)
  assert.equal(result.validatedQuestions, 5)
  assert.equal(result.uniqueSourceFacts, 5)
  assert.equal(result.strictFiveQuestionPass, true)
})
test('French 7B batch succeeds only when five source facts independently match', async () => {
  const provider = fakeProvider('french')
  const result = await runSevenBFixture(provider, fixture('french'), PLANS.french)
  assert.equal(result.strictFiveQuestionPass, true)
  assert.equal(result.independentOracleMatches, 5)
  assert.equal(result.uniqueSourceFacts, 5)
})
test('one bad 7B answer triggers one targeted retry rather than regenerating the pair', async () => {
  const provider = fakeProvider('selected_pages', (data, indices) => {
    if (indices.length === 2 && indices[0] === 0) data.questions[1].choices[0] = 'invented'
    return data
  })
  const result = await runSevenBFixture(provider, fixture('selected_pages'), PLANS.selected_pages)
  assert.equal(provider.calls, 4)
  assert.equal(result.retries, 1)
  assert.equal(result.batchAcceptedQuestions, 3)
  assert.equal(result.strictFiveQuestionPass, true)
  assert.deepEqual(result.perFactOutcomes.filter(x => x.factIndex === 2).map(x => x.status),
    ['unsupported_answer', 'accepted'])
})
test('malformed batch and individual output cannot inflate accepted count or create endless retries', async () => {
  const provider = fakeProvider('selected_pages', () => '{bad')
  const result = await runSevenBFixture(provider, fixture('selected_pages'), PLANS.selected_pages)
  assert.equal(provider.calls, 8)
  assert.equal(result.retries, 5)
  assert.equal(result.validatedQuestions, 0)
  assert.equal(result.strictFiveQuestionPass, false)
  assert.equal(result.perFactOutcomes.every(x => x.status === 'invalid_json'), true)
})
test('swapped batch facts must be rejected and individually repaired using correct pages', async () => {
  const provider = fakeProvider('selected_pages', (data, indices) => {
    if (indices.length === 2 && indices[0] === 0) {
      data.questions.reverse()
    }
    return data
  })
  const result = await runSevenBFixture(provider, fixture('selected_pages'), PLANS.selected_pages)
  assert.equal(provider.calls, 5)
  assert.equal(result.batchAcceptedQuestions, 2)
  assert.equal(result.retries, 2)
  assert.equal(result.strictFiveQuestionPass, true)
  assert.equal(result.uniqueSourceFacts, 5)
})
