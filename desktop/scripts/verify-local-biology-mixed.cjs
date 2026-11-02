'use strict'

// Fixed, non-private sample PDF extracted by the application's PDF.js engine.
// Never accept arbitrary user documents here: this runner records model output.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createLocalRuntime } = require('../src/local-runtime.cjs')
const { CANDIDATE, createLocalModelStore } = require('../src/local-model-store.cjs')
const { createWindowsLocalAiProvider } = require('../src/windows-local-ai-provider.cjs')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')
const fixture = require('../test/fixtures/biology-study-notes.json')

async function main() {
  const modelStore = createLocalModelStore({ directory: path.resolve(process.argv[3]) })
  const runtime = createLocalRuntime({ directory: path.resolve(process.argv[2]), modelStore })
  const provider = createWindowsLocalAiProvider({ runtime, modelStore, modelId: CANDIDATE.id })
  const report = { pdfSha256: fixture.pdfSha256, characterCount: fixture.characterCount, settings: { questionCount: 15, difficulty: 'hard', questionType: 'mixed' }, attempts: [], validation: [], rejected: [] }
  const service = createLocalQuizService({
    provider: { async generate(request, options) {
      const result = await provider.generate(request, options)
      report.attempts.push({ profile: request.generationProfile, schema: request.jsonSchema, ...result })
      return result
    } },
    onRejectedQuestion(issue) { report.rejected.push(issue) },
    onValidationIssue(issue) { report.validation.push(issue); console.log('SAMPLE VALIDATION:', issue.attempt, issue.reason) },
  })
  try {
    assert.equal(fixture.characterCount, 5726)
    assert.equal(fixture.pages.length, 3)
    const quiz = await service.generate({ pages: fixture.pages, questionCount: 15, difficulty: 'hard', questionType: 'mixed' })
    assert.ok(quiz.questions.length >= 1 && quiz.questions.length <= 15)
    for (const question of quiz.questions) {
      if (question.question_type === 'multiple_choice') assert.equal(new Set(question.choices.map(choice => choice.trim().toLocaleLowerCase())).size, 4)
      if (question.question_type !== 'short_answer') assert.equal(question.correct_answer, question.choices[question.correct_index])
      assert.ok(question.source_pages.every(page => [1, 2, 3].includes(page)))
    }
    report.quiz = quiz
    report.outcome = 'pass'
    console.log('PASS: three-page biology PDF generates a validated hard mixed quiz with up to fifteen questions')
  } catch (error) {
    report.outcome = error.code || error.name
    throw error
  } finally {
    await fs.writeFile(path.resolve(process.argv[4]), JSON.stringify(report, null, 2) + '\n')
    await runtime.shutdown()
  }
}

main().catch(error => { console.error('Biology sample failed:', error.code || error.message); process.exitCode = 1 })
