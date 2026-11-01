'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')
const { createLocalAiDebugReport } = require('../src/local-ai-debug-report.cjs')
const facts = Array.from({ length: 15 }, (_, i) => `Specimen ${i + 1} has code CODE${i + 1}.`)
const pages = [{ pageNumber: 1, text: facts.join(' ') }]
function draft(evidence) {
  return { title: 'Specimens', questions: facts.map((fact, i) => {
    const type = ['multiple_choice', 'true_false', 'short_answer'][i % 3]
    const answer = type === 'true_false' ? 'True' : `CODE${i + 1}`
    return { question_type: type, question: `Item ${i + 1}: ${type === 'true_false' ? fact : 'What is the specimen code?'}`,
      choices: type === 'short_answer' ? [] : type === 'true_false' ? ['True', 'False'] : [answer, 'WrongA', 'WrongB', 'WrongC'],
      correct_index: type === 'short_answer' ? -1 : 0, correct_answer: answer, accepted_answers: [answer],
      explanation: fact, source_pages: [1], ...(evidence ? { source_fact: fact } : {}) }
  }) }
}
test('15 hard mixed retains grounded retry questions and reports rejected item and citation', async () => {
  const rejected = [], requests = []
  const service = createLocalQuizService({ onRejectedQuestion: x => rejected.push(x), provider: { async generate(request) {
    requests.push(request)
    const data = draft(requests.length > 1)
    data.questions[2].correct_answer = 'UNSUPPORTED'
    data.questions[2].accepted_answers = ['UNSUPPORTED']
    return { text: JSON.stringify(data), finishReason: 'stop' }
  } } })
  const result = await service.generate({ pages, questionCount: 15, difficulty: 'hard', questionType: 'mixed' })
  assert.equal(requests.length, 2)
  assert.equal(result.questions.length, 14)
  assert.ok(!JSON.stringify(result).includes('UNSUPPORTED'))
  assert.equal(rejected[0].questionNumber, 3)
  assert.deepEqual(rejected[0].sourcePages, [1])
  assert.equal(rejected[0].answer, 'UNSUPPORTED')
  assert.equal(rejected[0].sources[0].excerpt, pages[0].text)
  assert.equal(requests[1].jsonSchema.oneOf[0].properties.questions.items.required.includes('source_fact'), true)
})
test('recovery never returns a quiz if every retry quote is fabricated', async () => {
  let calls = 0
  const service = createLocalQuizService({ provider: { async generate() {
    const data = draft(++calls > 1)
    if (calls === 1) data.questions[2].correct_answer = 'UNSUPPORTED'
    else data.questions.forEach(q => { q.source_fact = 'Invented evidence.' })
    return { text: JSON.stringify(data), finishReason: 'stop' }
  } } })
  await assert.rejects(service.generate({ pages, questionCount: 15, difficulty: 'hard', questionType: 'mixed' }), { code: 'insufficient_source' })
})
test('detailed content requires opt-in, records one quiz, and clears explicitly', () => {
  const buffer = createLocalAiDebugReport()
  buffer.begin({}); buffer.record({ answer: 'private' }); assert.equal(buffer.report(), null)
  buffer.arm(); buffer.begin({ questionCount: 15 }); buffer.record({ answer: 'private' }); buffer.finish()
  buffer.begin({}); buffer.record({ answer: 'another' })
  assert.match(buffer.report(), /private/); assert.doesNotMatch(buffer.report(), /another/)
  buffer.clear(); assert.equal(buffer.report(), null)
})
