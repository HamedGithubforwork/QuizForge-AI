'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { safeDiagnostic } = require('../scripts/verify-local-biology-practice.cjs')

test('weak-area diagnostics include only allowlisted operational event codes', () => {
  assert.deepEqual(safeDiagnostic('runtime_failed', {
    stage: 'startup', reason: 'startup_failed',
    pdfText: 'PRIVATE USER NOTE', modelPath: 'C:/private/model.gguf',
    operationId: '1234',
  }), { event: 'runtime_failed', stage: 'startup', reason: 'startup_failed' })
  assert.equal(safeDiagnostic('private_study_content', { text: 'PRIVATE' }), null)
})

test('rejects paths, unexpected values, and arbitrary metadata from diagnostic fields', () => {
  assert.deepEqual(safeDiagnostic('operation_failed', {
    kind: 'quiz', reason: 'C:/Users/secret.txt',
    stage: '<think>private</think>',
    acceleration: 'gpu',
    data: { content: 'PRIVATE' },
  }), { event: 'operation_failed', kind: 'quiz', acceleration: 'gpu' })
  assert.equal(safeDiagnostic('runtime_started', null)?.event, 'runtime_started')
})
