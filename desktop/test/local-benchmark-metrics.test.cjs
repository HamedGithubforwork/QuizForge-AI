'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  percentile, summarizeRuns, validateBenchmarkReport, aggregateBenchmarkReports,
} = require('../src/local-benchmark-metrics.cjs')

const report = (acceleration = 'cpu', overrides = {}) => ({
  schema: 1, syntheticOnly: true, expectedAcceleration: acceleration,
  platform: 'win32', architecture: 'x64', modelId: 'qwen3-4b-q4-k-m',
  runtimeRevision: 'b11317',
  hardware: { logicalCpuCount: 8, totalMemoryBytes: 16000000000,
    gpuDevice: acceleration === 'gpu' ? 'Vulkan0' : null },
  runs: [1, 2, 3].map(iteration => ({
    fixture: iteration % 2 ? 'selected_pages' : 'french', iteration,
    elapsedSeconds: iteration * 10,
    outcome: 'pass', inferenceAcceleration: acceleration,
    questionCount: 5, distinctFacts: 5, exactDuplicateQuestions: 0,
  })),
  ...overrides,
})

test('computes ordered medians and p90 without dropping slow outliers', () => {
  assert.equal(percentile([100, 20, 80, 50], 0.5), 80)
  assert.equal(percentile([100, 20, 80, 50], 0.9), 100)
  assert.deepEqual(summarizeRuns([
    { outcome: 'pass', elapsedSeconds: 20 },
    { outcome: 'failed', elapsedSeconds: 5 },
    { outcome: 'pass', elapsedSeconds: 60 },
  ]), {
    attempts: 3, passed: 2, failures: 1, strictSourceFactPassRate: 2 / 3,
    medianSeconds: 20, p90Seconds: 60, maximumSeconds: 60, minimumSeconds: 20,
  })
})

test('never accepts CPU inference or unknown inference as a GPU result', () => {
  assert.throws(() => validateBenchmarkReport(report('gpu', {
    runs: [report('gpu').runs[0], { ...report('gpu').runs[1], inferenceAcceleration: 'cpu' }],
  })), /CPU fallback/)
  assert.throws(() => validateBenchmarkReport(report('gpu', {
    runs: [{ ...report('gpu').runs[0], inferenceAcceleration: 'unknown' }],
  })), /CPU fallback/)
})

test('rejects malformed or misleading accuracy and uniqueness reports', () => {
  assert.throws(() => validateBenchmarkReport(report('cpu', {
    runs: [{ ...report().runs[0], distinctFacts: 4 }],
  })))
  assert.throws(() => validateBenchmarkReport(report('cpu', {
    runs: [{ ...report().runs[0], exactDuplicateQuestions: 1 }],
  })))
})

test('aggregates CPU and GPU without claiming cross-machine speedups', () => {
  const cpu = report()
  const gpu = report('gpu')
  const summary = aggregateBenchmarkReports([cpu, gpu])
  assert.equal(summary.reportCount, 2)
  assert.equal(summary.allRuns.attempts, 6)
  assert.equal(summary.matchedEnvironment, false)
  assert.equal(summary.gpuVsCpuControlled, false)
  assert.equal(summary.byAcceleration.cpu.medianSeconds, 20)
  assert.equal(summary.byAcceleration.gpu.medianSeconds, 20)
})

test('different model or hardware prevents controlled comparisons', () => {
  const different = report('cpu', { modelId: 'different' })
  const summary = aggregateBenchmarkReports([report(), different])
  assert.equal(summary.matchedEnvironment, false)
  assert.equal(summary.byAcceleration.cpu.attempts, 6)
})
