'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const runtimeDirectory = path.resolve(process.argv[2])
  const modelDirectory = path.resolve(process.argv[3])
  const stack = createWindowsLocalAiStack({
    userDataDirectory: path.dirname(modelDirectory),
    modelDirectory,
    runtimeDirectory,
  })
  try {
    const status = await stack.quizStatus()
    assert.equal(status.available, true, 'Pinned runtime/model must be generation-ready on acceptance runner')
    assert.equal(status.modelId, 'qwen3-4b-q4-k-m')
    assert.equal(status.constraints.questionCount, 5)
    assert.equal(status.constraints.questionType, 'multiple_choice')

    const quiz = await stack.generateQuiz({
      pages: [
        {
          pageNumber: 1,
          text: [
            'Ottawa is the capital city of Canada.',
            'At standard sea-level pressure, pure water boils at 100 degrees Celsius.',
            'Chlorophyll absorbs light energy used in photosynthesis.',
          ].join(' '),
        },
        {
          pageNumber: 2,
          text: [
            'Mitochondria produce much of a cell\'s ATP through cellular respiration.',
            'In DNA, adenine pairs with thymine.',
          ].join(' '),
        },
      ],
      questionCount: 5,
      difficulty: 'medium',
      questionType: 'multiple_choice',
    })

    assert.equal(typeof quiz.title, 'string')
    assert.ok(quiz.title.trim())
    assert.equal(quiz.questions.length, 5)
    for (const question of quiz.questions) {
      assert.equal(question.question_type, 'multiple_choice')
      assert.equal(question.choices.length, 4)
      assert.ok(question.correct_index >= 0 && question.correct_index < 4)
      assert.equal(question.correct_answer, question.choices[question.correct_index])
      assert.ok(question.source_pages.length >= 1)
      assert.ok(question.source_pages.every(page => page === 1 || page === 2))
      assert.equal(question.grading.grading_mode, 'none')
    }
    console.log('PASS: real Windows Local AI stack generated and validated five-question MCQ quiz')
  } finally {
    await stack.dispose()
  }
}

main().catch(error => {
  console.error('Local quiz integration validation failed:', error?.code || error?.name || 'unknown')
  process.exitCode = 1
})
