'use strict'

// Repeated allowlisted, SHA-verified GGUF measurement on a trusted Windows machine.
// No user notes, questions, raw responses, paths or account data enter reports.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
const { FIXTURES, validateSemanticQuiz } = require('./verify-local-product-acceptance.cjs')
const { summarizeRuns } = require('../src/local-benchmark-metrics.cjs')
const { getBenchmarkModel } = require('../src/local-benchmark-models.cjs')
const { CANDIDATE } = require('../src/local-model-store.cjs')

const round = value => Math.round(value * 1000) / 1000
const cleanQuestion = value => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const selectedFixtures = ['selected_pages', 'french'].map(id => {
  const fixture = FIXTURES.find(item => item.id === id)
  assert.ok(fixture, 'Missing pinned benchmark fixture: ' + id)
  return fixture
})

async function main() {
  assert.equal(process.platform, 'win32', 'Benchmark requires Windows')
  assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
    'Usage: node benchmark-local-generation.cjs <runtime-dir> <model-dir> <report.json> [cpu|gpu] [repeats 1-5] [allowlisted-model-id]')
  const runtimeDirectory = path.resolve(process.argv[2])
  const modelDirectory = path.resolve(process.argv[3])
  const output = path.resolve(process.argv[4])
  const expectedAcceleration = process.argv[5] ?? 'cpu'
  const repeats = Number(process.argv[6] ?? 3)
  const benchmarkModel = getBenchmarkModel(process.argv[7] ?? CANDIDATE.id)
  assert.ok(['cpu', 'gpu'].includes(expectedAcceleration))
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 5)

  // Isolate calibration state from the user's real desktop profile.
  const tempProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-benchmark-'))
  let stack = null
  let selectedExecution = null
  let runtimeStartupMs = null
  let inferenceEvents = []
  let validationReason = null
  const report = {
    schema: 1, syntheticOnly: true, expectedAcceleration,
    platform: process.platform, architecture: process.arch,
    runtimeRevision: 'b11317', modelId: benchmarkModel.id, fixtureIds: selectedFixtures.map(x => x.id),
    repeatsPerFixture: repeats, hardware: null, runs: [],
  }
  async function save() {
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }
  try {
    stack = createWindowsLocalAiStack({
      userDataDirectory: tempProfile, modelDirectory, runtimeDirectory,
      ...(benchmarkModel.id === CANDIDATE.id ? {} : { benchmarkModelId: benchmarkModel.id }),
      onDiagnostic(event, fields) {
        if (event === 'execution_selected') {
          selectedExecution = {
            acceleration: fields?.acceleration,
            layers: fields?.layers,
            selectedCpuThreads: fields?.selectedCpuThreads,
            selectedContextTokens: fields?.selectedContextTokens,
          }
        }
        if (event === 'runtime_ready') {
          runtimeStartupMs = Number.isFinite(fields?.startupMs) && fields.startupMs >= 0
            ? fields.startupMs : null
        }
        if (event === 'inference_completed') {
          inferenceEvents.push({
            acceleration: fields?.acceleration,
            elapsedMs: fields?.elapsedMs,
            prefillMs: fields?.prefillMs,
            decodeMs: fields?.decodeMs,
            promptTokens: fields?.promptTokens,
            completionTokens: fields?.completionTokens,
          })
        }
      },
      onQuizValidationIssue(issue) {
        if (typeof issue?.reason === 'string' && /^[a-z_]{1,64}$/.test(issue.reason)) {
          validationReason = issue.reason
        }
      },
    })
    const managerStatus = await stack.load()
    const ready = await stack.quizStatus()
    assert.equal(ready.available, true, 'Verified model and runtime must be ready')
    const hardware = managerStatus.capability?.hardware ?? {}
    assert.equal(ready.modelId, benchmarkModel.id, 'Requested benchmark model differs from loaded model')
    report.modelId = ready.modelId
    report.hardware = {
      logicalCpuCount: hardware.logicalCpuCount,
      totalMemoryBytes: hardware.totalMemoryBytes ?? null,
      gpuDevice: hardware.gpuAccelerationUsable ? hardware.gpuDevice : null,
      gpuAccelerationUsable: hardware.gpuAccelerationUsable === true,
    }
    assert.ok(Number.isSafeInteger(report.hardware.logicalCpuCount) &&
      report.hardware.logicalCpuCount > 0)
    if (expectedAcceleration === 'gpu') {
      assert.equal(report.hardware.gpuAccelerationUsable, true,
        'No verified Vulkan GPU available; cannot report GPU performance')
    } else {
      assert.equal(managerStatus.capability.acceleration, 'cpu',
        'CPU-only benchmark requires CPU-selected hardware; do not relabel GPU runs')
    }
    await save()
    for (let iteration = 1; iteration <= repeats; iteration++) {
      for (const fixture of selectedFixtures) {
        selectedExecution = null
        runtimeStartupMs = null
        inferenceEvents = []
        validationReason = null
        const started = performance.now()
        let quiz = null
        let failureCode = null
        try {
          quiz = await stack.generateQuiz({
            pages: fixture.selectedPages,
            questionCount: 5, difficulty: fixture.difficulty,
            questionType: 'multiple_choice',
          })
          // This strict shared acceptance oracle verifies five separate factual
          // relationships, cited pages, and supported correct answers.
          validateSemanticQuiz(quiz, fixture)
        } catch (error) {
          const known = typeof error?.code === 'string' &&
            /^[a-z_]{1,64}$/.test(error.code) ? error.code : null
          failureCode = known ?? 'source_fact_validation_failed'
        }
        const observedModes = [...new Set(inferenceEvents.map(x => x.acceleration))]
        const inferenceAcceleration =
          observedModes.length === 1 ? observedModes[0] :
          observedModes.length === 0 ? 'none' : 'mixed'
        if (quiz && failureCode === null && inferenceAcceleration !== expectedAcceleration) {
          failureCode = 'wrong_acceleration'
        }
        const questions = quiz?.questions ?? []
        const normalized = questions.map(item => cleanQuestion(item.question))
        const exactDuplicateQuestions = normalized.length - new Set(normalized).size
        const successful = failureCode === null && quiz && questions.length === 5 &&
          exactDuplicateQuestions === 0
        // Never invent llama.cpp prefill/decode timings if the runtime omits
        // them. Keep profiling private, aggregate, and numeric-only.
        const elapsedInferenceMs = inferenceEvents.reduce((sum, event) =>
          sum + (Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 ? event.elapsedMs : 0), 0)
        const hasPrefill = inferenceEvents.length > 0 &&
          inferenceEvents.every(event => Number.isFinite(event.prefillMs) && event.prefillMs >= 0)
        const hasDecode = inferenceEvents.length > 0 &&
          inferenceEvents.every(event => Number.isFinite(event.decodeMs) && event.decodeMs >= 0)
        const prefillMs = hasPrefill ? inferenceEvents.reduce((sum, event) => sum + event.prefillMs, 0) : null
        const decodeMs = hasDecode ? inferenceEvents.reduce((sum, event) => sum + event.decodeMs, 0) : null
        const outputTokens = inferenceEvents.reduce((sum, event) =>
          sum + (Number.isSafeInteger(event.completionTokens) &&
            event.completionTokens >= 0 ? event.completionTokens : 0), 0)
        const run = {
          fixture: fixture.id, iteration,
          // First result includes cold startup; later runs reflect the warm
          // session and calibrated hardware. Keep sequence for analysis.
          ordinal: report.runs.length + 1,
          elapsedSeconds: round((performance.now() - started) / 1000),
          outcome: successful ? 'pass' : 'failed',
          inferenceAcceleration,
          selectedCpuThreads: Number.isSafeInteger(selectedExecution?.selectedCpuThreads)
            ? selectedExecution.selectedCpuThreads : null,
          selectedGpuLayers: Number.isSafeInteger(selectedExecution?.layers)
            ? selectedExecution.layers : null,
          selectedContextTokens: [8192, 12288].includes(selectedExecution?.selectedContextTokens)
            ? selectedExecution.selectedContextTokens : null,
          runtimeStartupSeconds: runtimeStartupMs === null ? null : round(runtimeStartupMs / 1000),
          inferenceElapsedSeconds: round(elapsedInferenceMs / 1000),
          prefillSeconds: prefillMs === null ? null : round(prefillMs / 1000),
          decodeSeconds: decodeMs === null ? null : round(decodeMs / 1000),
          decodeTokensPerSecond: decodeMs > 0 ? round(outputTokens * 1000 / decodeMs) : null,
          inferenceCalls: inferenceEvents.length,
          promptTokens: inferenceEvents.reduce((sum, event) =>
            sum + (Number.isSafeInteger(event.promptTokens) && event.promptTokens >= 0
              ? event.promptTokens : 0), 0),
          completionTokens: outputTokens,
          questionCount: questions.length,
          distinctFacts: successful ? 5 : 0,
          exactDuplicateQuestions,
          ...(successful ? {} : { failureCode: failureCode ?? validationReason ?? 'validation_failed' }),
        }
        report.runs.push(run)
        await save()
        console.log('BENCHMARK ' + fixture.id + ' run=' + iteration +
          ' mode=' + inferenceAcceleration + ' result=' + run.outcome +
          ' seconds=' + run.elapsedSeconds)
      }
    }
    report.summary = summarizeRuns(report.runs)
    await save()
    console.log('BENCHMARK SUMMARY ' + JSON.stringify(report.summary))
    assert.equal(report.summary.failures, 0,
      'At least one benchmark quiz failed source-fact or acceleration validation')
  } finally {
    await stack?.dispose().catch(() => {})
    await fs.rm(tempProfile, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Local benchmark failed:', error?.code || error?.message || 'unknown')
    process.exitCode = 1
  })
}

module.exports = { selectedFixtures }
