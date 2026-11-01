'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

async function main() {
  if (!process.argv[2]) throw new Error('Pass the completed quality acceptance report')
  const report = JSON.parse(await fs.readFile(path.resolve(process.argv[2]), 'utf8'))
  const runs = report.runs
  assert.equal(report.syntheticOnly, true)
  assert.ok(Array.isArray(runs), 'Quality evidence must contain case results')
  const quizzes = runs.filter(row => row.outcome === 'quiz')
  const abstentions = runs.filter(row => row.outcome === 'insufficient_source')
  assert.equal(quizzes.length, 6, 'Require all six quiz generations before evaluating performance')
  assert.equal(abstentions.length, 1, 'Require the insufficient-source abstention case')
  assert.equal(runs.length, 7, 'Require the complete quality suite')
  assert.equal(report.summary?.generatedRuns, 6)
  assert.equal(report.summary?.abstentions, 1)

  const times = quizzes.map(row => row.elapsedSeconds)
  assert.ok(times.every(time => Number.isFinite(time) && time > 0),
    'Each generated quiz must have a positive measured duration')
  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const maximum = Math.max(...times)
  assert.equal(report.summary.medianQuizSeconds, median)
  assert.equal(report.summary.maxQuizSeconds, maximum)

  const peakWorkingSetBytes = Math.max(0, ...runs.map(row => row.peakWorkingSetBytes || 0))
  const peakCpuSeconds = Math.max(0, ...runs.map(row => row.peakCpuSeconds || 0))
  const metricsCaptured = peakWorkingSetBytes > 0 && peakCpuSeconds > 0 &&
    runs.some(row => row.metricSampleCount > 0)
  const latencyPass = median <= 150 && maximum <= 210

  console.log(JSON.stringify({
    medianQuizSeconds: median,
    maxQuizSeconds: maximum,
    maxPeakWorkingSetBytes: peakWorkingSetBytes,
    maxPeakCpuSeconds: peakCpuSeconds,
    latencyScreen: latencyPass ? 'pass' : 'fail',
    processMetricsScreen: metricsCaptured ? 'pass' : 'fail',
  }))
  assert.equal(metricsCaptured, true, 'Hosted Windows acceptance did not capture llama-server memory and CPU metrics')
  assert.equal(latencyPass, true, 'Windows acceptance exceeded the conservative development latency screen')
  console.log('PASS: complete quality report meets Windows CPU performance and process metrics screens')
}

main().catch(error => {
  console.error('Local AI performance acceptance failed:', error?.message || error?.code || 'unknown')
  process.exitCode = 1
})
