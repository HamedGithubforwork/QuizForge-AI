'use strict'

// Print only aggregate synthetic benchmark evidence; no raw generated text.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { aggregateBenchmarkReports } = require('../src/local-benchmark-metrics.cjs')

async function main() {
  const files = process.argv.slice(2)
  assert.ok(files.length > 0, 'Usage: node summarize-local-benchmarks.cjs <report.json> [additional-report.json ...]')
  const reports = await Promise.all(files.map(async file =>
    JSON.parse(await fs.readFile(file, 'utf8'))))
  const result = aggregateBenchmarkReports(reports)
  console.log(JSON.stringify(result, null, 2))
  if (!result.matchedEnvironment) {
    console.log('NOTE: Hardware/model/runtime differ. This is descriptive, not a controlled speedup comparison.')
  }
  // Correctness remains mandatory even when the median improves.
  assert.equal(result.allRuns.failures, 0,
    'One or more real-model runs failed strict fact validation')
}
main().catch(error => {
  console.error('Benchmark summary failed:', error?.message || 'unknown')
  process.exitCode = 1
})
