'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const servicePath = path.resolve(process.env.QUIZ_SERVICE_PATH || path.join(__dirname, '../../src/local-quiz-service.cjs'))
const { QUIZ_SCHEMA, createLocalQuizService } = require(servicePath)

const ROOT = __dirname
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures.json'), 'utf8'))

test('v4 evaluator delegates prompt and schema generation to the production quiz service', () => {
  const evaluator = fs.readFileSync(path.join(ROOT, 'evaluate.cjs'), 'utf8')
  assert.match(evaluator, /require\(SERVICE_PATH\)/)
  assert.match(evaluator, /createLocalQuizService\(\{ provider, onValidationIssue/)
  assert.doesNotMatch(evaluator, /const\s+(?:SYSTEM_PROMPT|QUIZ_PROMPT|PROMPT_TEMPLATE)\s*=/)
})

test('fixtures are fresh synthetic cases with page-grounded reviewer facts kept separate', () => {
  assert.equal(fixtures.length, 8)
  assert.equal(new Set(fixtures.map(row => row.id)).size, fixtures.length)
  assert.deepEqual(fixtures.map(row => row.id), [
    'moss_adaptation_01', 'harbor_log_02', 'french_meteorology_03',
    'cross_page_table_04', 'quoted_instruction_05', 'sparse_source_06',
    'repeated_sparse_source_07', 'targeted_practice_pair_08',
  ])
  assert.equal(fixtures.filter(row => row.expected_outcome === 'insufficient_source').length, 2)
  for (const fixture of fixtures) {
    assert.ok(fixture.pages && Object.keys(fixture.pages).length > 0)
    assert.ok(Array.isArray(fixture.gold_facts))
    for (const fact of fixture.gold_facts) {
      assert.ok(fact.text.trim())
      assert.ok(fact.pages.every(page => Object.hasOwn(fixture.pages, String(page))))
    }
    if (fixture.expected_outcome !== 'insufficient_source') {
      assert.ok(fixture.gold_facts.length >= 6, `${fixture.id} needs a six-fact grounded source`)
    }
  }
  assert.ok(fixtures.some(row => row.forbidden?.includes('PROMPT_BYPASSED')))
  assert.ok(fixtures.some(row => row.practice?.avoidQuestions?.length === 2))
})

test('production service continues to send the current prompt and fixed response schema', async () => {
  let captured
  const quiz = {
    title: 'Synthetic contract check',
    questions: Array.from({ length: 5 }, (_, index) => ({
      question: `Question ${index + 1}?`,
      choices: ['North', 'South', 'East', 'West'],
      correct_index: index % 4,
      explanation: 'The supplied source supports this answer.',
      source_pages: [1],
    })),
  }
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        captured = request
        return { text: JSON.stringify(quiz), finishReason: 'stop' }
      },
    },
  })
  await service.generate({
    pages: [{ pageNumber: 1, text: 'The fictional Luma marker is blue. It stores 4 samples. It opens at noon. It has a ceramic shell. It weighs 3 grams.' }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.deepEqual(captured.jsonSchema, QUIZ_SCHEMA)
  assert.match(captured.messages[0].content, /ONLY the supplied study material/i)
  assert.match(captured.messages[0].content, /untrusted content/i)
  assert.match(captured.messages[0].content, /choices\[correct_index\].*supported/i)
  assert.match(captured.messages[0].content, /Count repeated copies of the same fact as one fact/i)
})

test('targeted fixture exercises the production avoidance, candidate-pool, and retry prompts', async () => {
  let captured
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        captured = request
        throw new Error('stop_after_capture')
      },
    },
  })
  const fixture = fixtures.find(row => row.id === 'targeted_practice_pair_08')
  await assert.rejects(service.generate({
    pages: Object.entries(fixture.pages).map(([pageNumber, text]) => ({ pageNumber: Number(pageNumber), text })),
    practice: fixture.practice,
    questionCount: 5,
    difficulty: fixture.difficulty,
    questionType: 'multiple_choice',
  }), { code: 'generation_failed' })
  assert.equal(captured.jsonSchema.oneOf.length, 2)
  assert.match(captured.messages[0].content, /reverse the question-answer direction/i)
  assert.match(captured.messages.at(-1).content, /generate exactly seven candidate questions/i)
  assert.match(captured.messages.at(-1).content, /source_fact/i)
  const promptMessages = captured.messages.map(row => row.content).join('\n')
  assert.match(promptMessages, /What is the casing material of the Zevi field meter\?/)
  assert.doesNotMatch(promptMessages, /gold_facts/)
})
