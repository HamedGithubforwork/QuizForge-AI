'use strict'

// Synthetic measurements only: never write source notes, prompts, question text,
// or local filesystem paths into the published comparison artifact.
const fs = require('node:fs/promises')
const path = require('node:path')
const { BENCHMARK_MODELS } = require('../src/local-benchmark-models.cjs')

function median(values) {
  if (!values.length) return null
  const a = [...values].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 1000) / 1000
}

function summarizeModel(model, report) {
  if (!report || report.syntheticOnly !== true || report.modelId !== model.id ||
    report.expectedAcceleration !== 'cpu' || !Array.isArray(report.runs) || !report.runs.length) {
    return { modelId: model.id, modelBytes: model.bytes, status: 'not_measured' }
  }
  const runs = report.runs
  const passed = runs.filter(run => run.outcome === 'pass' && run.questionCount === 5 &&
    run.distinctFacts === 5 && run.exactDuplicateQuestions === 0 &&
    run.inferenceAcceleration === 'cpu')
  const failures = {}
  for (const run of runs) {
    if (!passed.includes(run)) {
      const code = typeof run.failureCode === 'string' && /^[a-z_]{1,64}$/.test(run.failureCode)
        ? run.failureCode : 'validation_failed'
      failures[code] = (failures[code] ?? 0) + 1
    }
  }
  return {
    modelId: model.id, modelBytes: model.bytes, status: 'measured',
    attempts: runs.length, passed: passed.length, failed: runs.length - passed.length,
    medianAllSeconds: median(runs.map(r => r.elapsedSeconds).filter(x => Number.isFinite(x) && x >= 0)),
    medianPassSeconds: median(passed.map(r => r.elapsedSeconds).filter(x => Number.isFinite(x) && x >= 0)),
    medianDecodeTokensPerSecond: median(runs.map(r => r.decodeTokensPerSecond).filter(x => Number.isFinite(x) && x > 0)),
    failures,
    hardware: {
      logicalCpuCount: report.hardware?.logicalCpuCount ?? null,
      totalMemoryBytes: report.hardware?.totalMemoryBytes ?? null,
    },
  }
}

async function main() {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: node summarize-local-model-comparison.cjs <report-directory>')
  const summaries = []
  for (const model of Object.values(BENCHMARK_MODELS)) {
    let report = null
    try { report = JSON.parse(await fs.readFile(path.join(directory, model.id + '.json'), 'utf8')) }
    catch (e) { if (!['ENOENT', 'EISDIR'].includes(e.code)) throw e }
    summaries.push(summarizeModel(model, report))
  }
  // Do not claim a winner based on mismatched host resources, absent data,
  // poor source coverage, or sample sizes smaller than two real quiz attempts.
  const fullyMeasured = summaries.every(x => x.status === 'measured' &&
    x.attempts >= 2 && x.failed === 0 && Number.isFinite(x.medianPassSeconds))
  const cpus = new Set(summaries.map(x => JSON.stringify(x.hardware)))
  const comparable = fullyMeasured && cpus.size === 1
  const comparison = {
    schema: 1, syntheticOnly: true, runtimeRevision: 'b11317',
    caveat: 'Single Windows hosted runner, synthetic fixed passages. These are provisional results, not user-hardware or PDF-import proof.',
    comparable, models: summaries,
    fastestValidModel: comparable
      ? [...summaries].sort((a, b) => a.medianPassSeconds - b.medianPassSeconds)[0].modelId
      : null,
  }
  await fs.writeFile(path.join(directory, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
  console.log('MODEL COMPARISON ' + JSON.stringify(comparison))
  if (summaries.some(x => x.status !== 'measured')) process.exitCode = 1
}

if (require.main === module) main().catch(error => {
  console.error('Comparison aggregation failed: ' + (error?.code ?? error?.message ?? 'unknown'))
  process.exitCode = 1
})
module.exports = { median, summarizeModel }
