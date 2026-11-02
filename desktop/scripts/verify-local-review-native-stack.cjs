'use strict'

// Exercise the exact production desktop path: generate a quiz, retain its
// source context, and review a student's answer through the SAME stack.
// This complements standalone Qwen semantic grading acceptance.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
const fixture = require('../test/fixtures/biology-study-notes.json')

async function main() {
  const runtimeDirectory = path.resolve(process.argv[2])
  const modelDirectory = path.resolve(process.argv[3])
  const output = path.resolve(process.argv[4])
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-review-stack-'))
  const report = { outcome: 'pending', generationCount: 0, reviewed: false, verdict: null,
    errorCode: null, stage: 'initializing', diagnostics: [] }
  let stack
  try {
    // The Local AI preview must not fall back to online grading or API calls.
    globalThis.fetch = async () => { throw new Error('No cloud request is permitted') }
    stack = createWindowsLocalAiStack({
      userDataDirectory: directory,
      modelDirectory,
      runtimeDirectory,
      onDiagnostic(event, fields) {
        // Store only fixed operational codes, not study content, account
        // identifiers, model outputs, or paths.
        if (['operation_started', 'operation_completed', 'operation_failed',
          'runtime_failed', 'answer_review_failed'].includes(event)) {
          report.diagnostics.push({
            event,
            ...(typeof fields?.kind === 'string' ? { kind: fields.kind } : {}),
            ...(typeof fields?.reason === 'string' ? { reason: fields.reason } : {}),
          })
        }
      },
    })
    report.stage = 'generating_quiz'
    const quiz = await stack.generateQuiz({
      pages: fixture.pages,
      questionCount: 5,
      difficulty: 'easy',
      questionType: 'short_answer',
    })
    report.generationCount = quiz.questions.length
    report.stage = 'quiz_generated'
    const index = quiz.questions.findIndex(q => q.question_type === 'short_answer')
    assert.ok(index >= 0, 'Generation must provide a short-answer question')
    const question = quiz.questions[index]
    report.stage = 'grading_answer'
    const result = await stack.reviewLocalAnswers({ cases: [{
      question_index: index, question: question.question,
      correct_answer: question.correct_answer, student_answer: 's',
    }] })
    assert.equal(result.decisions.length, 1)
    assert.equal(result.decisions[0].question_index, index)
    assert.equal(result.decisions[0].engine, 'local')
    report.reviewed = true
    report.stage = 'review_completed'
    report.verdict = result.decisions[0].verdict
    report.stage = 'asserting_grade'
    assert.equal(result.decisions[0].verdict, 'incorrect',
      'Qwen must grade an irrelevant one-letter answer incorrect after local quiz generation')
    report.outcome = 'pass'
    report.stage = 'complete'
    console.log('PASS real Windows quiz-to-local-answer-review lifecycle')
  } catch (error) {
    report.outcome = 'fail'
    report.errorCode = typeof error?.code === 'string' ? error.code : 'unclassified'
    console.error('Local grading test failed at:', report.stage,
      'quizCount:', report.generationCount, 'verdict:', report.verdict,
      'errorCode:', report.errorCode)
    throw error
  } finally {
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
    await stack?.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error('Windows local review stack acceptance failed:', error?.code || error?.message || 'unknown')
  process.exitCode = 1
})
