'use strict'

// CI-only, same-runner comparison of the two pinned Local AI generator versions.
// Synthetic facts only; never persist model replies, study text, or answer text.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { createLocalRuntime, createWarmLocalRuntime, boundedCpuThreads } =
  require('../src/local-runtime.cjs')
const { createLocalModelStore, CANDIDATE } =
  require('../src/local-model-store.cjs')
const { createWindowsLocalAiProvider } =
  require('../src/windows-local-ai-provider.cjs')
const { createLocalQuizService: optimizedGenerator } =
  require('../src/local-quiz-service.cjs')

const BASELINE_SHA = 'fa78f5944381aa5cc6edbfa3c7f43e8211e226c0'
const OPTIMIZED_SHA = '95b984a99b6d8289e6940b39e1c8b10d6d414a24'
const PAGES = Object.freeze([
  Object.freeze({
    pageNumber: 2,
    text: 'Aster casing material is cobalt. Aster capacity is 17 samples. Aster sampling interval is five hours.',
  }),
  Object.freeze({
    pageNumber: 4,
    text: 'Boreal casing material is glass. Boreal capacity is 23 samples. Boreal sampling interval is seven hours.',
  }),
])
const PRIOR_QUESTIONS = Object.freeze([
  'What is the Aster casing material?',
  'What is the Aster capacity?',
])
const ORDER = Object.freeze(['baseline', 'optimized', 'optimized', 'baseline'])
const norm = value => String(value).normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim()
const FACTS = [
  { id: 'aster_material', page: 2, routes: [
    [['aster', 'casing'], ['cobalt']],
    [['cobalt', 'casing'], ['aster']],
  ] },
  { id: 'aster_capacity', page: 2, routes: [
    [['aster', 'capacity'], ['17', '17 samples', 'seventeen']],
    [['17', 'capacity'], ['aster']],
  ] },
  { id: 'aster_interval', page: 2, routes: [
    [['aster', 'interval'], ['5', '5 hours', 'five', 'five hours']],
    [['five', 'interval'], ['aster']],
    [['5', 'interval'], ['aster']],
  ] },
  { id: 'boreal_material', page: 4, routes: [
    [['boreal', 'casing'], ['glass']],
    [['glass', 'casing'], ['boreal']],
  ] },
  { id: 'boreal_capacity', page: 4, routes: [
    [['boreal', 'capacity'], ['23', '23 samples', 'twenty three']],
    [['23', 'capacity'], ['boreal']],
  ] },
  { id: 'boreal_interval', page: 4, routes: [
    [['boreal', 'interval'], ['7', '7 hours', 'seven', 'seven hours']],
    [['seven', 'interval'], ['boreal']],
    [['7', 'interval'], ['boreal']],
  ] },
]

function validateQuiz(quiz) {
  assert.equal(quiz?.questions?.length, 5, 'Need five source-grounded questions')
  const usedFacts = new Set()
  const usedQuestions = new Set()
  for (const question of quiz.questions) {
    assert.equal(question.choices.length, 4)
    assert.equal(new Set(question.choices.map(norm)).size, 4)
    assert.equal(question.correct_answer, question.choices[question.correct_index])
    assert.ok(question.source_pages.every(page => page === 2 || page === 4))
    const wording = norm(question.question)
    assert.ok(!PRIOR_QUESTIONS.some(prior => norm(prior) === wording))
    assert.ok(!usedQuestions.has(wording))
    usedQuestions.add(wording)
    const context = norm(question.question + ' ' + question.explanation)
    const answer = norm(question.correct_answer)
    const matching = FACTS.filter(fact =>
      !usedFacts.has(fact.id) &&
      question.source_pages.includes(fact.page) &&
      fact.routes.some(([tokens, answers]) =>
        tokens.every(token => context.includes(norm(token))) &&
        answers.some(candidate => {
          const accepted = norm(candidate)
          return answer === accepted ||
            answer.startsWith(accepted + ' ') ||
            answer.endsWith(' ' + accepted)
        })))
    assert.equal(matching.length, 1,
      'Each question must test exactly one distinct source-supported fact')
    usedFacts.add(matching[0].id)
  }
  assert.equal(usedFacts.size, 5)
  return usedFacts.size
}

const seconds = value => Number((value / 1000).toFixed(3))
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(((sorted[0] + sorted[sorted.length - 1]) / 2).toFixed(3))
}
const safeCode = value => typeof value === 'string' && /^[a-z_]{1,60}$/.test(value)
  ? value : 'unknown'

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows-only model comparison')
  const [runtimeArg, modelArg, baselineFileArg, outputArg] = process.argv.slice(2)
  if (![runtimeArg, modelArg, baselineFileArg, outputArg].every(Boolean)) {
    throw new Error('Usage: compare-local-recovery RUNTIME MODEL BASELINE_FILE REPORT')
  }
  const output = path.resolve(outputArg)
  const baselineGenerator = require(path.resolve(baselineFileArg)).createLocalQuizService
  assert.equal(typeof baselineGenerator, 'function')
  const report = {
    schema: 1,
    syntheticOnly: true,
    comparedCommits: { baseline: BASELINE_SHA, optimized: OPTIMIZED_SHA },
    host: { platform: process.platform, arch: process.arch,
      logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
    modelId: CANDIDATE.id,
    order: ORDER,
    runs: [],
  }
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')

  const modelStore = createLocalModelStore({ directory: path.resolve(modelArg) })
  const runtime = createWarmLocalRuntime(createLocalRuntime({
    directory: path.resolve(runtimeArg),
    modelStore,
    accelerationMode: () => 'cpu',
    cpuThreadCount: () => boundedCpuThreads(),
    contextTokens: () => 12288,
  }), { idleMs: 180000, maxSessionMs: 30 * 60 * 1000 })
  const realProvider = createWindowsLocalAiProvider({
    runtime, modelStore, modelId: CANDIDATE.id,
  })

  try {
    // Exclude one-time model startup from all four timed trials.
    await runtime.withSession(async () => {})
    for (const [index, variant] of ORDER.entries()) {
      const attempts = []
      const issues = []
      const provider = {
        async generate(request, options) {
          const started = performance.now()
          const profile = typeof request.generationProfile === 'string' &&
            /^[a-z0-9_-]{1,64}$/.test(request.generationProfile)
            ? request.generationProfile : 'other'
          try {
            const result = await realProvider.generate(request, options)
            attempts.push({ profile, seconds: seconds(performance.now() - started),
              result: result.finishReason === 'stop' ? 'stop' : 'other' })
            return result
          } catch (error) {
            attempts.push({ profile, seconds: seconds(performance.now() - started),
              result: safeCode(error?.code) })
            throw error
          }
        },
      }
      const service = (variant === 'baseline' ? baselineGenerator : optimizedGenerator)({
        provider,
        onValidationIssue(issue) {
          issues.push({ attempt: safeCode(issue?.attempt), reason: safeCode(issue?.reason) })
        },
      })
      const started = performance.now()
      const row = { index: index + 1, variant, outcome: 'running', seconds: null,
        validatedFacts: 0, providerCalls: attempts, validationIssues: issues }
      report.runs.push(row)
      try {
        const quiz = await service.generate({
          pages: PAGES, questionCount: 5, difficulty: 'medium',
          questionType: 'multiple_choice',
          practice: { avoidQuestions: PRIOR_QUESTIONS },
        }, { signal: AbortSignal.timeout(360000) })
        row.validatedFacts = validateQuiz(quiz)
        row.outcome = 'pass'
      } catch (error) {
        row.outcome = safeCode(error?.code || error?.name)
      } finally {
        row.seconds = seconds(performance.now() - started)
        await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
        console.log('ABBA case', row.index, variant, row.outcome,
          row.seconds + 's', 'modelCalls=' + attempts.length)
      }
    }
    report.summary = Object.fromEntries(['baseline', 'optimized'].map(variant => {
      const rows = report.runs.filter(row => row.variant === variant)
      const passed = rows.filter(row => row.outcome === 'pass')
      return [variant, { passed: passed.length, total: rows.length,
        medianSeconds: passed.length === rows.length
          ? median(passed.map(row => row.seconds)) : null,
        maxSeconds: passed.length === rows.length
          ? Math.max(...passed.map(row => row.seconds)) : null,
        providerCalls: rows.reduce((sum, row) => sum + row.providerCalls.length, 0),
      }]
    }))
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log('ABBA SUMMARY:', JSON.stringify(report.summary))
    assert.ok(report.runs.every(row => row.outcome === 'pass'),
      'A/B comparison failed a source-grounding, uniqueness or runtime check')
  } finally {
    await runtime.shutdown()
  }
}

main().catch(error => {
  console.error('Controlled Windows A/B comparison failed:', safeCode(error?.code))
  process.exitCode = 1
})
