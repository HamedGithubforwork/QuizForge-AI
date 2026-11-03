'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EXPERIMENT_FIXTURES, EXPERIMENT_PLANS } =
  require('../scripts/benchmark-small-qwen-adaptive.cjs')
const {
  PROMPT_SCHEMA, extractVerifiedFact, questionPrompt, classifyException,
  decodeQuestion, sourceTypedDistractors, validateQuestionOnly,
  runAnswerFirstFixture, initialPromptVariant, retryPromptVariant,
  sourceRelationshipCue,
} = require('../scripts/benchmark-qwen-answer-first.cjs')
const fixture = id => EXPERIMENT_FIXTURES.find(x => x.id === id)
const english = fixture('selected_pages'), fr = fixture('french')
const plan = EXPERIMENT_PLANS.selected_pages[0]
const fact = extractVerifiedFact(plan, english)

test('answer-first generation is only question text; answer, page and quote are code-owned', () => {
  assert.deepEqual(PROMPT_SCHEMA.required, ['question'])
  assert.equal(PROMPT_SCHEMA.properties.answer, undefined)
  const p = questionPrompt(english, fact)
  assert.match(p.messages[1].content, /Aster casing material is \[BLANK\]/)
  assert.doesNotMatch(p.messages[1].content, /cobalt/)
  assert.doesNotMatch(p.messages[0].content, /cobalt/)
  assert.deepEqual(p.jsonSchema.required, ['question'])
  assert.equal(p.maxTokens, 170)
  const raw = questionPrompt(english, fact, { retry: true, output: 'no_schema' })
  assert.equal(raw.jsonSchema, undefined)
  assert.match(raw.messages[0].content, /question text ONLY/)
})
test('conservative source grammar extracts answer without consulting oracle answer aliases', () => {
  const expected = {
    selected_pages: ['cobalt', '17 samples', 'five hours', 'glass', '23 samples'],
    french: ['2037', 'Léa Morel', 'sept capteurs', 'la pression', 'l’humidité'],
    biology: ['ATP', 'proteins', "most of a eukaryotic cell's DNA",
      'chemical energy', 'movement of substances into and out of the cell'],
    biology_french: ["de l'ATP", 'des protéines', "la majeure partie de l'ADN de la cellule",
      'énergie chimique', 'les échanges de substances avec le milieu extérieur'],
  }
  for (const [id, answers] of Object.entries(expected)) {
    const data = fixture(id)
    for (const [i, plan] of EXPERIMENT_PLANS[id].entries()) {
      const extracted = extractVerifiedFact(plan, data)
      assert.ok(extracted, id + ':' + i)
      assert.equal(extracted.answer, answers[i], id + ':' + i)
      assert.ok(extracted.quote.includes(extracted.answer))
    }
  }
  assert.equal(extractVerifiedFact({ page: 2, quote: 'Fake material is lead.' },
    english), null)
})
test('strict oracle checks user-visible question WITHOUT explanation text', () => {
  const yes = validateQuestionOnly('What is Aster casing material?', english,
    fact, 'short_answer')
  assert.equal(yes.reason, undefined)
  assert.equal(yes.question.correct_answer, 'cobalt')
  assert.equal(yes.question.source_fact, plan.quote)
  assert.deepEqual(yes.question.source_pages, [2])
  assert.equal(validateQuestionOnly('What is its answer?', english,
    fact, 'short_answer').reason, 'semantic_or_subject_mismatch')
  assert.equal(validateQuestionOnly('What is Aster cobalt?', english,
    fact, 'short_answer').reason, 'answer_leaked_in_question')
  assert.equal(validateQuestionOnly('Quelle est la matière Aster ?', english,
    fact, 'short_answer').reason, 'wrong_language')
})
test('French antecedent belongs to prompt context, never source quotation or answer key', () => {
  const director = extractVerifiedFact(EXPERIMENT_PLANS.french[1], fr)
  const prompt = questionPrompt(fr, director)
  assert.match(prompt.messages[1].content, /CONTEXTE PRÉCÉDENT NON CITABLE/)
  assert.match(prompt.messages[1].content, /La station Boréale a ouvert en 2037/)
  assert.match(prompt.messages[1].content, /Sa directrice est \[BLANK\]/)
  assert.doesNotMatch(prompt.messages[1].content, /Léa Morel/)
  assert.match(prompt.messages[0].content, /sujet/)
  const v = validateQuestionOnly('Qui est la directrice de la station Boréale ?',
    fr, director, 'short_answer')
  assert.equal(v.reason, undefined)
  assert.equal(validateQuestionOnly('Qui est sa directrice ?', fr, director,
    'short_answer').reason, 'semantic_or_subject_mismatch')
})
test('distractors must be type-compatible and sourced; abstain when fewer than 3', () => {
  assert.deepEqual(sourceTypedDistractors(english, fact), [])
  assert.equal(validateQuestionOnly('What is Aster casing material?', english,
    fact, 'multiple_choice').reason, 'insufficient_comparable_distractors')
})
test('five same-type source facts allow four answer choices with no model-created distractors', () => {
  const materials = fixture('materials')
  const plans = EXPERIMENT_PLANS.materials
  assert.equal(plans.length, 5)
  const seen = new Set()
  for (const [i, p] of plans.entries()) {
    const f = extractVerifiedFact(p, materials)
    assert.ok(f && f.type === 'material')
    const values = sourceTypedDistractors(materials, f)
    assert.equal(values.length, 3)
    assert.equal(values.some(x => x === f.answer), false)
    const name = p.quote.split(' ')[0]
    const result = validateQuestionOnly('What is the ' + name + ' casing material?',
      materials, f, 'multiple_choice', seen)
    assert.equal(result.reason, undefined)
    assert.equal(new Set(result.question.choices).size, 4)
    assert.equal(result.question.choices[result.question.correct_index], f.answer)
    seen.add('fact:' + result.factId)
    seen.add('question:' + result.wording)
  }
})
test('masked answer never appears in model-facing prompts across all fixtures', () => {
  for (const [id, plans] of Object.entries(EXPERIMENT_PLANS)) {
    const data = fixture(id)
    if (!data) continue
    for (const plan of plans) {
      const verified = extractVerifiedFact(plan, data)
      assert.ok(verified)
      for (const output of ['schema', 'no_schema']) {
        for (const retry of [false, true]) {
          const prompt = questionPrompt(data, verified, { retry, output })
          const body = prompt.messages.map(x => x.content).join('\n')
          assert.ok(body.includes('[BLANK]'), id)
          assert.ok(!body.includes(verified.answer), id + ' leaked answer')
          assert.ok(!body.includes(plan.quote), id + ' leaked full quote')
        }
      }
    }
  }
})
test('wording rejections retain JSON schema with a targeted retry instruction', async () => {
  const materials = fixture('materials')
  let calls = 0
  const provider = { async withSession(fn) {
    return fn({ async generate(prompt) {
      calls++
      if (calls === 1) {
        assert.ok(Object.hasOwn(prompt, 'jsonSchema'))
        return { text: JSON.stringify({ question: 'What is Mira cobalt?' }),
          finishReason: 'stop' }
      }
      if (calls === 2) {
        assert.ok(Object.hasOwn(prompt, 'jsonSchema'))
        assert.match(prompt.messages[0].content, /revealed the answer/)
        return { text: JSON.stringify({ question: 'What is the Mira casing material?' }),
          finishReason: 'stop' }
      }
      return { text: JSON.stringify({ question: 'What is the unknown thing?' }),
        finishReason: 'stop' }
    } })
  } }
  const report = await runAnswerFirstFixture(provider, materials,
    EXPERIMENT_PLANS.materials, 'multiple_choice')
  assert.equal(report.perFactOutcomes[0].status, 'answer_leaked_in_question')
  assert.equal(report.perFactOutcomes[1].status, 'accepted')
  assert.equal(report.sourceSupportedQuestions, 1)
})
test('hybrid strategy selects by source grammar and switches only on semantic failure', () => {
  const materials = fixture('materials'), biology = fixture('biology')
  const station = extractVerifiedFact(EXPERIMENT_PLANS.french[1], fr)
  const membrane = extractVerifiedFact(EXPERIMENT_PLANS.biology[4], biology)
  assert.equal(initialPromptVariant(fact), 'visible')
  assert.equal(initialPromptVariant(station), 'visible')
  assert.equal(initialPromptVariant(membrane), 'masked')
  assert.equal(retryPromptVariant('visible', 'answer_leaked_in_question'), 'masked')
  assert.equal(retryPromptVariant('masked', 'semantic_or_subject_mismatch'), 'visible')
  assert.equal(retryPromptVariant('visible', 'invalid_json'), 'visible')
  assert.equal(retryPromptVariant('visible', 'semantic_or_subject_mismatch', 'visible'),
    'visible')
  const cue = sourceRelationshipCue(fr, station)
  assert.match(cue.subject, /station Boréale/)
  assert.match(cue.relation, /directrice est/)
  assert.doesNotMatch(cue.relation, /Léa Morel/)
  const visible = questionPrompt(materials,
    extractVerifiedFact(EXPERIMENT_PLANS.materials[0], materials),
    { variant: 'visible' })
  const masked = questionPrompt(materials,
    extractVerifiedFact(EXPERIMENT_PLANS.materials[0], materials),
    { variant: 'masked' })
  assert.match(visible.messages[1].content, /VERIFIED ANSWER: cobalt/)
  assert.match(masked.messages[1].content, /\[BLANK\]/)
  assert.doesNotMatch(masked.messages[1].content, /cobalt/)
})
test('hybrid runtime preserves source-owned citations and records prompt variant', async () => {
  const materials = fixture('materials')
  const responses = ['What is Mira cobalt?', 'What is the Mira casing material?']
  let calls = 0
  const provider = { async withSession(fn) {
    return fn({ async generate(prompt) {
      const n = calls++
      if (n === 0) assert.match(prompt.messages[1].content, /VERIFIED ANSWER: cobalt/)
      if (n === 1) assert.doesNotMatch(prompt.messages[1].content, /VERIFIED ANSWER: cobalt/)
      return { text: JSON.stringify({ question: responses[n] ??
        'What is the unknown thing?' }), finishReason: 'stop' }
    } })
  } }
  const result = await runAnswerFirstFixture(provider, materials,
    EXPERIMENT_PLANS.materials, 'multiple_choice', { trial: 2 })
  assert.equal(result.promptStrategy, 'hybrid')
  assert.equal(result.trial, 2)
  assert.equal(result.perFactOutcomes[0].variant, 'visible')
  assert.equal(result.perFactOutcomes[0].status, 'answer_leaked_in_question')
  assert.equal(result.perFactOutcomes[1].variant, 'masked')
  assert.equal(result.perFactOutcomes[1].status, 'accepted')
  assert.equal(result.sourceSupportedQuestions, 1)
  assert.equal(result.independentOracleMatches, 1)
  assert.equal(result.fullFiveQuestionPass, false)
})
test('mixed-subject extraction uses source grammar without oracle aliases', () => {
  const mixed = fixture('cross_domain')
  const plans = EXPERIMENT_PLANS.cross_domain
  const verbs = ['preserves', 'publishes', 'archives', 'reviews', 'records']
  const lemmas = ['preserve', 'publish', 'archive', 'review', 'record']
  const subjects = ['museum', 'council', 'library', 'agency', 'court']
  const answers = ['historical letters', 'annual reports', 'donated manuscripts',
    'permit applications', 'hearing dates']
  assert.equal(plans.length, 5)
  for (const [i, plan] of plans.entries()) {
    const extracted = extractVerifiedFact(plan, mixed)
    assert.equal(extracted?.type, 'source_action')
    assert.equal(extracted.answer, answers[i])
    const cue = sourceRelationshipCue(mixed, extracted)
    assert.match(cue.subject, new RegExp(subjects[i]))
    assert.equal(cue.relation, verbs[i])
    const prompt = questionPrompt(mixed, extracted, { variant: 'masked' })
    assert.match(prompt.messages[1].content, /SOURCE SUBJECT:/)
    assert.match(prompt.messages[1].content, /SOURCE RELATION:/)
    assert.ok(!prompt.messages[1].content.includes(answers[i]))
    const question = 'What does the ' + subjects[i] + ' ' + lemmas[i] + '?'
    assert.equal(validateQuestionOnly(question, mixed, extracted,
      'short_answer').reason, undefined)
    assert.equal(validateQuestionOnly('What is the unknown answer?',
      mixed, extracted, 'short_answer').reason, 'semantic_or_subject_mismatch')
  }
  assert.equal(extractVerifiedFact({
    page: 1, quote: 'The archivist contemplated possibilities.',
  }, mixed), null)
})
test('source frames preserve output direction and qualifiers for other subjects', () => {
  const biology = fixture('biology')
  const expected = [
    ['Mitochondria', 'produce', 'during cellular respiration'],
    ['Ribosomes', 'assemble', 'from amino acids'],
    ['The nucleus', 'stores', ''],
    ['Chloroplasts', 'convert light energy into', 'during photosynthesis'],
    ['The cell membrane', 'controls', ''],
  ]
  for (const [i, plan] of EXPERIMENT_PLANS.biology.entries()) {
    const f = extractVerifiedFact(plan, biology)
    const cue = sourceRelationshipCue(biology, f)
    assert.equal(cue.subject, expected[i][0])
    assert.equal(cue.relation, expected[i][1])
    assert.equal(cue.qualifier, expected[i][2])
  }
  const french = fixture('biology_french')
  const f = extractVerifiedFact(EXPERIMENT_PLANS.biology_french[3], french)
  const cue = sourceRelationshipCue(french, f)
  assert.equal(cue.subject, 'Les chloroplastes')
  assert.match(cue.relation, /transforment l'énergie lumineuse en/)
  assert.equal(cue.qualifier, 'par photosynthèse')
  const prompt = questionPrompt(french, f, { variant: 'masked' })
  assert.match(prompt.messages[1].content, /SUJET SOURCE : Les chloroplastes/)
  assert.doesNotMatch(prompt.messages[1].content, /énergie chimique/)
})
test('no-schema fallback never blindly parses prose as trusted quiz', () => {
  assert.deepEqual(decodeQuestion({ text: 'What is Aster capacity?', finishReason: 'stop' },
    'no_schema'), { question: 'What is Aster capacity?' })
  assert.equal(decodeQuestion({ text: 'An explanation about capacity.',
    finishReason: 'stop' }, 'no_schema').reason, 'non_question_response')
  assert.equal(decodeQuestion({ text: '{broken', finishReason: 'stop' },
    'schema').reason, 'invalid_json')
  assert.equal(decodeQuestion({ text: '{"question":"Why?"}', finishReason: 'length' },
    'schema').reason, 'truncated_or_missing')
})
test('safe failures report types without raw model text, error messages or paths', () => {
  assert.equal(classifyException(Object.assign(new Error('private stack'), {
    name: 'TypeError' })), 'type_exception')
  assert.equal(classifyException({ code: 'invalid_request', message: 'secret' }),
    'invalid_request')
  assert.equal(classifyException({ code: 'ERR_ASSERTION', name: 'AssertionError',
    message: 'secret' }), 'assertion_exception')
})
test('rejected model response falls back to plain question and preserves verified answer', async () => {
  let calls = 0
  const provider = {
    async withSession(fn) { return fn({ async generate(prompt) {
      calls++
      return {
        text: Object.hasOwn(prompt, 'jsonSchema') ? '{bad' :
          'What is Aster casing material?',
        finishReason: 'stop', usage: { outputTokens: 8 },
      }
    } }) },
  }
  // Other facts are deliberately failed; only the first fact can be accepted.
  const p = EXPERIMENT_PLANS.selected_pages
  const local = { async withSession(fn) { return fn({
    async generate(prompt) {
      if (prompt.messages[1].content.includes('Aster casing material is [BLANK].')) {
        return provider.withSession(async a => a.generate(prompt))
      }
      return { text: '{bad', finishReason: 'stop' }
    },
  }) } }
  const report = await runAnswerFirstFixture(local, english, p, 'short_answer',
    { strategy: 'masked' })
  assert.equal(calls, 2)
  assert.equal(report.inferenceCalls, 10)
  assert.equal(report.sourceSupportedQuestions, 1)
  assert.equal(report.incompleteCount, 4)
  assert.equal(report.suggestFourB, true)
  assert.equal(report.perFactOutcomes[0].status, 'invalid_json')
  assert.equal(report.perFactOutcomes[1].protocol, 'no_schema')
  assert.equal(report.perFactOutcomes[1].status, 'accepted')
})
test('no valid output cannot loop endlessly and never fabricates missing questions', async () => {
  let calls = 0
  const provider = {
    async withSession(fn) { return fn({ async generate() {
      calls++
      throw Object.assign(new Error('sensitive details'), { code: 'runtime_unavailable' })
    } }) },
  }
  const result = await runAnswerFirstFixture(provider, fr, EXPERIMENT_PLANS.french,
    'short_answer')
  assert.equal(calls, 10)
  assert.equal(result.retries, 5)
  assert.equal(result.sourceSupportedQuestions, 0)
  assert.equal(result.fullFiveQuestionPass, false)
  assert.equal(result.suggestFourB, true)
  assert.ok(result.perFactOutcomes.every(x => x.stage === 'provider_generate' &&
    x.status === 'runtime_unavailable'))
})
