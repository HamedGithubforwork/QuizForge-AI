'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { reviewQuizDistinctness } = require('../src/local-quiz-distinctness.cjs')

const pages = [
  { pageNumber: 1, text: 'Cell A contains pigment red.' },
  { pageNumber: 2, text: 'Cell B contains pigment blue.' },
  { pageNumber: 3, text: 'Cell C contains pigment green.' },
]
function question(text, pageNumber) {
  return { question: text, correct_answer: 'pigment', source_pages: [pageNumber] }
}
test('disjoint source pages skip optional semantic duplicate inference', async () => {
  let calls = 0
  const quiz = { title: 'Three facts', questions: [
    question('Which pigment is in cell A?', 1),
    question('Which pigment is in cell B?', 2),
    question('Which pigment is in cell C?', 3),
  ] }
  const result = await reviewQuizDistinctness({
    provider: { async generate() { calls++; throw new Error('unnecessary Qwen call') } },
    quiz, pages,
  })
  assert.equal(calls, 0)
  assert.equal(result.generation.distinctness, 'checked')
  assert.equal(result.generation.duplicateCount, 0)
  assert.equal(result.questions.length, 3)
})

test('overlap reviews only eligible source-page pairs and preserves original indices', async () => {
  let calls = 0
  const quiz = { title: 'Overlap', questions: [
    question('What pigment does cell A contain?', 1),
    question('What pigment does cell B contain?', 2),
    question('Which pigment is found in cell A?', 1),
    question('What pigment does cell C contain?', 3),
  ] }
  const result = await reviewQuizDistinctness({
    provider: { async generate(request) {
      calls++
      const payload = JSON.parse(request.messages[1].content)
      assert.deepEqual(payload.questions.map(q => q.index), [0, 2])
      assert.deepEqual(payload.pages.map(p => p.pageNumber), [1])
      assert.equal(request.generationProfile, 'answer-review-v1')
      return {
        finishReason: 'stop',
        text: JSON.stringify({ duplicates: [{
          keep: 0, remove: 2, fact: 'Cell A pigment',
          source_quote: 'Cell A contains pigment red',
        }] }),
      }
    } },
    quiz, pages,
  })
  assert.equal(calls, 1)
  assert.equal(result.generation.distinctness, 'checked')
  assert.equal(result.generation.duplicateCount, 1)
  assert.deepEqual(result.questions.map(q => q.question), [
    'What pigment does cell A contain?', 'What pigment does cell B contain?',
    'What pigment does cell C contain?',
  ])
})

test('shared topic but no common cited source never triggers AI or deletion', async () => {
  const quiz = { title: 'Same topic', questions: [
    question('What color does cell A contain?', 1),
    question('What color does cell B contain?', 2),
  ] }
  const outcome = await reviewQuizDistinctness({
    provider: { async generate() { throw new Error('not needed') } },
    quiz, pages,
  })
  assert.equal(outcome.generation.duplicateCount, 0)
  assert.equal(outcome.questions.length, 2)
})
