'use strict'

// Runs only against the repository's fixed synthetic biology fixture.
// Reproduces the desktop flow: miss one answer, prioritize its cited pages,
// keep the whole processed PDF available, and avoid repeating that question.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createLocalRuntime } = require('../src/local-runtime.cjs')
const { CANDIDATE, createLocalModelStore } = require('../src/local-model-store.cjs')
const { createWindowsLocalAiProvider } = require('../src/windows-local-ai-provider.cjs')
const { createLocalQuizService } = require('../src/local-quiz-service.cjs')
const fixture = require('../test/fixtures/biology-study-notes.json')

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const [runtimeArg, modelArg, baselineArg, outputArg] = process.argv.slice(2)
  if (![runtimeArg, modelArg, baselineArg, outputArg].every(Boolean)) {
    throw new Error('Usage: node verify-local-biology-practice.cjs RUNTIME MODEL BASELINE OUTPUT')
  }
  // '-' exercises real Qwen practice without depending on an unrelated
  // ordinary-quiz generation run (which can separately fail choice repair).
  // This question is taken verbatim from the fixed biology fixture.
  let missed = { question: 'Which organelle stores most cell DNA?', source_pages: [1] }
  if (baselineArg !== '-') {
    const baseline = JSON.parse(await fs.readFile(path.resolve(baselineArg), 'utf8'))
    assert.equal(baseline.outcome, 'pass')
    assert.equal(baseline.pdfSha256, fixture.pdfSha256)
    assert.equal(baseline.quiz.questions.length, 5)
    missed = baseline.quiz.questions[0]
  }
  const focusPages = [...new Set(missed.source_pages)]
  const sourcePages = fixture.pages.map(page => page.pageNumber)
  assert.ok(focusPages.length > 0 && focusPages.every(page => sourcePages.includes(page)))
  const report = {
    schema: 1,
    pdfSha256: fixture.pdfSha256,
    focusPages,
    avoidQuestions: [missed.question],
    validationIssues: [],
    // CI-only: fixed public synthetic biology notes, no user text.
    recoveryDraft: null,
    evidenceRepairDraft: null,
    outcome: 'running',
  }
  const modelStore = createLocalModelStore({ directory: path.resolve(modelArg) })
  const runtime = createLocalRuntime({ directory: path.resolve(runtimeArg), modelStore })
  const provider = createWindowsLocalAiProvider({ runtime, modelStore, modelId: CANDIDATE.id })
  const service = createLocalQuizService({
    provider,
    onGeneratedResponse(response) {
      if (response.phase === 'weak-area-recovery') {
        report.recoveryDraft = typeof response.text === 'string'
          ? response.text.slice(0, 16000) : null
      } else if (response.phase === 'weak-area-grounding-repair') {
        report.evidenceRepairDraft = typeof response.text === 'string'
          ? response.text.slice(0, 16000) : null
      }
    },
    onValidationIssue(issue) {
      report.validationIssues.push({ attempt: issue.attempt, reason: issue.reason })
      console.log('BIOLOGY PRACTICE VALIDATION:', issue.attempt, issue.reason)
    },
  })
  try {
    const quiz = await service.generate({
      pages: fixture.pages,
      questionCount: 5,
      difficulty: 'easy',
      questionType: 'multiple_choice',
      practice: { focusPages, avoidQuestions: [missed.question] },
    })
    assert.equal(quiz.questions.length, 5)
    const uniqueQuestions = new Set()
    for (const question of quiz.questions) {
      assert.equal(question.choices.length, 4)
      assert.equal(new Set(question.choices.map(value => value.trim().toLowerCase())).size, 4)
      assert.equal(question.correct_answer, question.choices[question.correct_index])
      assert.ok(question.source_pages.length >= 1)
      assert.ok(question.source_pages.every(page => sourcePages.includes(page)))
      const wording = question.question.trim().replace(/\s+/g, ' ').toLowerCase()
      assert.notEqual(wording, missed.question.trim().replace(/\s+/g, ' ').toLowerCase())
      assert.ok(!uniqueQuestions.has(wording), 'Weak-area follow-up must not repeat a question')
      uniqueQuestions.add(wording)
    }
    report.outcome = 'pass'
    report.quiz = quiz
    console.log('PASS: real-model weak-area biology follow-up retains full PDF, avoids missed wording and returns five valid questions')
  } catch (error) {
    report.outcome = error?.code || error?.name || 'failure'
    throw error
  } finally {
    await fs.writeFile(path.resolve(outputArg), JSON.stringify(report, null, 2) + '\n')
    await runtime.shutdown()
  }
}

main().catch(error => {
  console.error('Real-model biology weak-area practice failed:', error?.code || error?.message || 'unknown')
  process.exitCode = 1
})
