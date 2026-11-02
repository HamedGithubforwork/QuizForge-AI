'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { assess, buildRequest, CASES, TREATMENTS } = require('../scripts/diagnose-deepseek-protocol.cjs')

test('three controlled DeepSeek probes change schema and token budget independently', () => {
  assert.deepEqual(TREATMENTS.map(x => [x.withSchema, x.maxTokens]), [
    [true, 800], [true, 1800], [false, 1800],
  ])
  const constrained = buildRequest(CASES[0], TREATMENTS[1])
  const unconstrained = buildRequest(CASES[0], TREATMENTS[2])
  assert.equal(constrained.messages[0].content, unconstrained.messages[0].content)
  assert.equal(constrained.messages[1].content, unconstrained.messages[1].content)
  assert.equal(constrained.generationProfile, unconstrained.generationProfile)
  assert.equal(constrained.maxTokens, unconstrained.maxTokens)
  assert.ok(constrained.jsonSchema)
  assert.equal(unconstrained.jsonSchema, undefined)
  assert.equal(buildRequest(CASES[0], TREATMENTS[0]).maxTokens, 800)
})

test('synthetic protocol scoring requires the precise cited sentence, answer and page', () => {
  for (const input of CASES) {
    const output = { question: 'What does this sentence say?',
      answer: input.answer, source_fact: input.source, source_pages: [input.page] }
    assert.equal(assess(JSON.stringify(output), input), 'grounded')
    assert.equal(assess(JSON.stringify({ ...output, answer: 'not in the source' }), input), 'answer_mismatch')
    assert.equal(assess(JSON.stringify({ ...output, source_pages: [99] }), input), 'wrong_shape')
    assert.equal(assess(JSON.stringify({ ...output, source_fact: 'invented citation' }), input), 'quote_mismatch')
    assert.equal(assess('some unstructured output', input), 'non_json')
    assert.equal(assess('{}', input), 'wrong_shape')
    assert.equal(assess('', input), 'empty')
  }
})
