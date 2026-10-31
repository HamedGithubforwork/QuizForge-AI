'use strict'

// Inject a known malformed synthetic draft, then require the pinned real model
// to repair it. This exercises recovery even when normal generation happens to pass.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createLocalRuntime } = require('../src/local-runtime.cjs')
const { CANDIDATE, createLocalModelStore } = require('../src/local-model-store.cjs')
const { createWindowsLocalAiProvider } = require('../src/windows-local-ai-provider.cjs')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')

async function main() {
  const modelStore = createLocalModelStore({ directory: path.resolve(process.argv[3]) })
  const runtime = createLocalRuntime({ directory: path.resolve(process.argv[2]), modelStore })
  const provider = createWindowsLocalAiProvider({ runtime, modelStore, modelId: CANDIDATE.id })
  const facts = [
    ['What do mitochondria generate?', 'ATP', 'Mitochondria generate ATP through cellular respiration.'],
    ['What do ribosomes synthesize?', 'proteins', 'Ribosomes synthesize proteins from messenger RNA.'],
    ['What molecule carries genetic information?', 'DNA', 'DNA carries genetic information in cells.'],
    ['What pigment absorbs light for photosynthesis?', 'chlorophyll', 'Chlorophyll absorbs light for photosynthesis.'],
    ['What sugar do cells use during respiration?', 'glucose', 'Cells use glucose during respiration.'],
  ]
  const quiz = { title: 'Synthetic biology', questions: facts.map(([question, answer, explanation]) => ({
    question, choices: ['water', answer, 'oxygen', 'nitrogen'], correct_index: 1,
    explanation, source_pages: [1],
  })) }
  // Repeat the correct answer before its selected index, plus a distractor twice.
  quiz.questions[0].choices[0] = ' atp '
  quiz.questions[1].choices[3] = 'OXYGEN'
  let calls = 0
  const service = createLocalQuizService({
    provider: { generate(request, options) {
      calls++
      if (calls === 1) return Promise.resolve({ text: JSON.stringify(quiz), finishReason: 'stop' })
      return provider.generate(request, options)
    } },
  })
  try {
    const result = await service.generate({
      pages: [{ pageNumber: 1, text: facts.map(fact => fact[2]).join(' ') }],
      questionCount: 5, difficulty: 'easy', questionType: 'multiple_choice',
    })
    assert.equal(calls, 2)
    assert.equal(result.questions.length, 5)
    result.questions.forEach((question, index) => {
      assert.equal(question.question, facts[index][0])
      assert.equal(question.correct_answer, facts[index][1])
      assert.equal(new Set(question.choices.map(choice => choice.trim().toLowerCase())).size, 4)
      assert.deepEqual(question.source_pages, [1])
    })
    console.log('PASS: real model repairs repeated distractors while preserving five questions and correct answers')
  } finally {
    await runtime.shutdown()
  }
}

main().catch(error => {
  console.error('Local choice repair failed:', error?.code || error?.name || 'unknown')
  process.exitCode = 1
})
