'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { FIXTURES, inspectQuiz, inspectModelResponse } = require('../scripts/inspect-synthetic-quiz.cjs')
const { PLANS, choosePrompt, validateSingle } = require('../scripts/benchmark-small-qwen-scaffold.cjs')

const fixture = FIXTURES.find(f => f.id === 'selected_pages')
const source = PLANS.selected_pages[0]
const valid = {
  question: 'What is the Aster casing material?',
  choices: ['cobalt', 'glass', 'ceramic', 'silver'],
  correct_index: 0,
  explanation: 'Aster casing material is cobalt.',
  source_pages: [2],
  source_fact: 'Aster casing material is cobalt.',
}

test('synthetic diagnostics distinguish oracle wording checks from factual mistakes', () => {
  const aliasParaphrase = {
    ...valid, question: 'What is Aster made of?', explanation: 'Aster is made from cobalt.',
    correct_answer: 'cobalt',
  }
  const result = inspectQuiz({ questions: [aliasParaphrase] }, fixture)
  assert.equal(result.questions[0].reason, 'oracle_wording_mismatch_candidate')
  assert.equal(result.questions[0].sourceQuoteMatched, true)
  assert.equal(result.questions[0].oracleMatched, false)
  assert.equal(result.strictPass, false)
})

test('repeated synthetic source facts cannot count as distinct questions', () => {
  const question = { ...valid, correct_answer: 'cobalt' }
  const report = inspectQuiz({ questions: [question, question] }, fixture)
  assert.equal(report.questions[0].reason, 'matched')
  assert.equal(report.questions[1].reason, 'duplicate_fact')
  assert.equal(report.distinctOracleFacts, 1)
  assert.equal(report.strictPass, false)
})

test('abstentions, invalid JSON, and wrong answer aliases remain separate failures', () => {
  assert.equal(inspectModelResponse('not json', fixture).status, 'invalid_json')
  assert.equal(inspectModelResponse(JSON.stringify({ title: 'Insufficient source material', questions: [] }), fixture).status, 'abstained')
  const wrong = { ...valid, correct_answer: 'unobtainium' }
  const report = inspectQuiz({ questions: [wrong] }, fixture)
  assert.equal(report.questions[0].reason, 'answer_not_in_fixture_aliases')
})

test('scaffolded one-question output requires four distinct choices and an exact source quote', () => {
  assert.equal(validateSingle(valid, source, fixture).reason, null)
  assert.equal(validateSingle({ ...valid, choices: ['cobalt', 'cobalt', 'ceramic', 'silver'] }, source, fixture).reason, 'duplicate_choices')
  assert.equal(validateSingle({ ...valid, source_pages: [4] }, source, fixture).reason, 'invalid_shape')
  assert.equal(validateSingle({ ...valid, source_fact: 'Aster owns a moon' }, source, fixture).reason, 'unsupported_quote_or_answer')
  assert.equal(validateSingle({ ...valid, correct_index: 1 }, source, fixture).reason, 'unsupported_quote_or_answer')
})

test('benchmark uses two prompt profiles with different pinned seeds and no cloud calls', () => {
  const brief = choosePrompt('concise', 2, source.quote, 'selected_pages')
  const explicit = choosePrompt('explicit', 2, source.quote, 'selected_pages')
  assert.equal(brief.generationProfile, 'quiz-mcq-v1')
  assert.equal(explicit.generationProfile, 'quiz-mcq-retry-v1')
  assert.notEqual(brief.messages[0].content, explicit.messages[0].content)
  assert.ok(brief.messages[1].content.includes(source.quote))
  assert.ok(explicit.messages[1].content.includes(source.quote))
  assert.equal(PLANS.selected_pages.length, 5)
  assert.equal(PLANS.french.length, 5)
})

test('raw DeepSeek drafts use choices and correct_index without normalized correct_answer', () => {
  const raw = {
    title: 'Synthetic quiz',
    questions: [{
      question: 'What is the Aster casing material?',
      choices: ['cobalt', 'glass', 'ceramic', 'silver'],
      correct_index: 0,
      explanation: 'Aster casing material is cobalt.',
      source_pages: [2],
      source_fact: 'Aster casing material is cobalt.',
    }],
  }
  const result = inspectModelResponse(JSON.stringify(raw), fixture)
  assert.equal(result.status, 'has_questions')
  assert.equal(result.oracleMatchedQuestions, 1)
  assert.equal(result.exactQuotedCandidates, 1)
  assert.equal(result.questions[0].reason, 'matched')
})
