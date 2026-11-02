'use strict'

// Exercise the actual Windows desktop pipeline using the fixed, synthetic
// biology fixture. Never collect private PDF excerpts or model responses.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
const fixture = require('../test/fixtures/biology-study-notes.json')

const DIAGNOSTIC_EVENTS = new Set([
  'operation_started', 'operation_completed', 'operation_failed',
  'runtime_launch', 'runtime_started', 'runtime_ready', 'runtime_failed',
  'runtime_stopped', 'generation_completed', 'validation_failed',
  'question_rejected', 'execution_selected',
])
function safeDiagnostic(event, fields) {
  if (!DIAGNOSTIC_EVENTS.has(event)) return null
  const result = { event }
  for (const name of ['kind', 'reason', 'stage', 'acceleration']) {
    const value = fields?.[name]
    if (typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)) result[name] = value
  }
  return result
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const [runtimeArg, modelArg, baselineArg, outputArg] = process.argv.slice(2)
  if (![runtimeArg, modelArg, baselineArg, outputArg].every(Boolean)) {
    throw new Error('Usage: node verify-local-biology-practice.cjs RUNTIME MODEL BASELINE OUTPUT')
  }
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
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-weak-area-'))
  const report = {
    schema: 2, pipeline: 'desktop-windows-stack',
    pdfSha256: fixture.pdfSha256, focusPages,
    avoidQuestionCount: 1, validationReasons: [], diagnostics: [],
    stage: 'initializing', outcome: 'running', errorCode: null,
    questionCount: 0,
  }
  let stack
  try {
    stack = createWindowsLocalAiStack({
      userDataDirectory: profileDir,
      modelDirectory: path.resolve(modelArg),
      runtimeDirectory: path.resolve(runtimeArg),
      onDiagnostic(event, fields) {
        const eventInfo = safeDiagnostic(event, fields)
        if (eventInfo && report.diagnostics.length < 80) {
          report.diagnostics.push(eventInfo)
        }
      },
      onQuizValidationIssue(issue) {
        if (typeof issue?.reason === 'string' && /^[a-z_]{1,64}$/.test(issue.reason)) {
          report.validationReasons.push(issue.reason)
        }
      },
    })
    report.stage = 'checking_model_and_runtime'
    const ready = await stack.quizStatus()
    assert.equal(ready.available, true, 'Verified Windows Local AI stack must be ready')
    report.stage = 'generating_weak_area_quiz'
    // Critical: same app stack, warm session, offload calibration, scoped model
    // lifecycle, and distinctness validation as an actual Windows user.
    const quiz = await stack.generateQuiz({
      pages: fixture.pages,
      questionCount: 5,
      difficulty: 'easy',
      questionType: 'multiple_choice',
      practice: { focusPages, avoidQuestions: [missed.question] },
    })
    report.questionCount = quiz.questions.length
    report.stage = 'validating_output'
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
    report.stage = 'complete'
    // Only this public synthetic fixture may be included in CI evidence.
    report.quiz = quiz
    console.log('PASS: desktop Windows Local AI stack generates distinct grounded weak-area questions')
  } catch (error) {
    report.outcome = 'fail'
    report.errorCode = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)
      ? error.code : (error?.name === 'AssertionError' ? 'acceptance_assertion' : 'unclassified')
    console.error('Real-model weak-area test failed at stage:', report.stage,
      'reason:', report.errorCode)
    throw error
  } finally {
    await fs.writeFile(path.resolve(outputArg), JSON.stringify(report, null, 2) + '\n')
    await stack?.dispose().catch(() => {})
    await fs.rm(profileDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Windows weak-area acceptance failed:', error?.code || error?.message || 'unknown')
    process.exitCode = 1
  })
}
module.exports = { safeDiagnostic }
