'use strict'

const assert = require('node:assert/strict')

function percentile(values, p) {
  assert.ok(Array.isArray(values) && values.length > 0)
  assert.ok(Number.isFinite(p) && p >= 0 && p <= 1)
  const sorted = values.slice().sort((a, b) => a - b)
  assert.ok(sorted.every(value => Number.isFinite(value) && value >= 0))
  return sorted[Math.ceil((sorted.length - 1) * p)]
}

function summarizeRuns(runs) {
  assert.ok(Array.isArray(runs) && runs.length > 0)
  const times = runs.filter(run =>
    run.outcome === 'pass' && Number.isFinite(run.elapsedSeconds) &&
    run.elapsedSeconds > 0).map(run => run.elapsedSeconds)
  const passed = runs.filter(run => run.outcome === 'pass').length
  const failures = runs.length - passed
  return Object.freeze({
    attempts: runs.length,
    passed,
    failures,
    strictSourceFactPassRate: passed / runs.length,
    medianSeconds: times.length ? percentile(times, 0.5) : null,
    p90Seconds: times.length ? percentile(times, 0.9) : null,
    maximumSeconds: times.length ? Math.max(...times) : null,
    minimumSeconds: times.length ? Math.min(...times) : null,
  })
}

const ACCELERATION = new Set(['cpu', 'gpu'])
function validateBenchmarkReport(report) {
  assert.ok(report && report.schema === 1 && report.syntheticOnly === true)
  assert.ok(ACCELERATION.has(report.expectedAcceleration))
  assert.ok(['win32'].includes(report.platform), 'Only Windows runner evidence is comparable')
  assert.ok(report.hardware && Number.isInteger(report.hardware.logicalCpuCount) &&
    report.hardware.logicalCpuCount > 0)
  assert.ok(typeof report.modelId === 'string' && report.modelId.length > 0)
  assert.ok(Array.isArray(report.runs) && report.runs.length > 0)
  for (const run of report.runs) {
    assert.ok(['selected_pages', 'french'].includes(run.fixture))
    assert.ok(Number.isInteger(run.iteration) && run.iteration > 0)
    assert.ok(['pass', 'failed'].includes(run.outcome))
    if (run.outcome === 'pass') {
      assert.equal(run.inferenceAcceleration, report.expectedAcceleration,
        'Reject CPU fallback masquerading as GPU benchmark evidence')
    }
    assert.ok(Number.isFinite(run.elapsedSeconds) && run.elapsedSeconds >= 0)
    for (const metric of ['runtimeStartupSeconds', 'inferenceElapsedSeconds',
      'prefillSeconds', 'decodeSeconds', 'decodeTokensPerSecond']) {
      if (run[metric] !== undefined && run[metric] !== null) {
        assert.ok(Number.isFinite(run[metric]) && run[metric] >= 0,
          'Reject malformed or unsafe numeric benchmark timing')
      }
    }
    if (run.selectedContextTokens !== undefined && run.selectedContextTokens !== null) {
      assert.ok([8192, 12288].includes(run.selectedContextTokens),
        'Reject unknown context configuration')
    }
    for (const metric of ['promptTokens', 'completionTokens']) {
      if (run[metric] !== undefined) {
        assert.ok(Number.isSafeInteger(run[metric]) && run[metric] >= 0,
          'Reject malformed token counters')
      }
    }
    if (run.outcome === 'pass') {
      assert.equal(run.questionCount, 5)
      assert.equal(run.distinctFacts, 5)
      assert.equal(run.exactDuplicateQuestions, 0)
    }
  }
  return report
}

function aggregateBenchmarkReports(reports) {
  assert.ok(Array.isArray(reports) && reports.length > 0)
  reports.forEach(validateBenchmarkReport)
  const first = reports[0]
  // The performance difference is not a controlled before/after unless the
  // hardware, model, fixtures AND runtime build are equivalent.
  const hardwareSignature = report => JSON.stringify({
    platform: report.platform, architecture: report.architecture,
    logicalCpuCount: report.hardware.logicalCpuCount,
    modelId: report.modelId, runtimeRevision: report.runtimeRevision,
    totalMemoryBytes: report.hardware.totalMemoryBytes ?? null,
    gpuDevice: report.hardware.gpuDevice ?? null,
  })
  const matchedEnvironment = reports.every(report =>
    hardwareSignature(report) === hardwareSignature(first))
  const perAcceleration = {}
  for (const acceleration of ['cpu', 'gpu']) {
    const runs = reports.filter(report => report.expectedAcceleration === acceleration)
      .flatMap(report => report.runs)
    if (runs.length) perAcceleration[acceleration] = summarizeRuns(runs)
  }
  const allRuns = reports.flatMap(report => report.runs)
  return Object.freeze({
    schema: 1,
    reportCount: reports.length,
    matchedEnvironment,
    allRuns: summarizeRuns(allRuns),
    byAcceleration: perAcceleration,
    // GPU vs CPU on different machines is descriptive, not a speedup claim.
    gpuVsCpuControlled: Boolean(perAcceleration.cpu && perAcceleration.gpu && matchedEnvironment),
  })
}

module.exports = Object.freeze({
  percentile, summarizeRuns, validateBenchmarkReport, aggregateBenchmarkReports,
})
