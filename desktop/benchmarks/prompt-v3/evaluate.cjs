'use strict'

// Calls the real local quiz service; prompts and schemas are never copied here.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = __dirname
const REPO = path.resolve(ROOT, '../../..')
const SERVICE_PATH = path.resolve(process.env.QUIZ_SERVICE_PATH || path.join(REPO, 'desktop/src/local-quiz-service.cjs'))
const { createLocalQuizService } = require(SERVICE_PATH)
const CANDIDATES = JSON.parse(fs.readFileSync(path.join(ROOT, 'candidates.json'), 'utf8'))
const FIXTURES = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures.json'), 'utf8'))
const PORT = 8089
const TIMEOUT_MS = 600000
const PROFILE = Object.freeze({
  'quiz-mcq-v1': { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, seed: 42, chat_template_kwargs: { enable_thinking: false } },
  'quiz-mcq-retry-v1': { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, seed: 137, chat_template_kwargs: { enable_thinking: false } },
})

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256')
    const input = fs.createReadStream(file)
    input.on('error', reject)
    input.on('data', chunk => digest.update(chunk))
    input.on('end', () => resolve(digest.digest('hex')))
  })
}

function argsFrom(argv) {
  const values = {}
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw new Error('invalid_arguments')
    values[argv[i].slice(2)] = argv[i + 1]
  }
  if (!values.candidate || !values.runtime || !values.model || !values.output) throw new Error('missing_arguments')
  return values
}

async function waitForServer(server) {
  const end = Date.now() + 120000
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error('runtime_startup_failed')
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('runtime_startup_timeout')
}

function sampleMetrics(pid) {
  if (process.platform !== 'win32') return null
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '{0},{1}' -f $p.PeakWorkingSet64,$p.CPU }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  const match = result.stdout?.trim().match(/^(\d+),([\d.]+)$/)
  return match ? { workingSetBytes: Number(match[1]), cpuSeconds: Number(match[2]) } : null
}

async function main() {
  const args = argsFrom(process.argv)
  const candidate = CANDIDATES.candidates.find(row => row.id === args.candidate)
  if (!candidate) throw new Error('unknown_candidate')
  const modelPath = path.resolve(args.model)
  const outputPath = path.resolve(args.output)
  if (fs.existsSync(outputPath)) throw new Error('refusing_to_overwrite_evidence')
  const modelDigest = await sha256File(modelPath)
  if (modelDigest !== candidate.sha256 || fs.statSync(modelPath).size !== candidate.bytes) throw new Error('model_integrity_failure')

  const fixturePath = path.join(ROOT, 'fixtures.json')
  const report = {
    schema: 1,
    suite: 'prompt-v3',
    candidate: candidate.id,
    model: { repository: candidate.repository, revision: candidate.revision, filename: candidate.filename, sha256: modelDigest, bytes: fs.statSync(modelPath).size, license: candidate.license, quantization: candidate.quantization },
    runtime: { tag: CANDIDATES.runtime.tag, revision: CANDIDATES.runtime.revision, sha256: CANDIDATES.runtime.archive_sha256, threads: 2, context: 4096, gpuLayers: 0 },
    prompt_source: SERVICE_PATH,
    prompt_source_sha256: sha256(fs.readFileSync(SERVICE_PATH)),
    fixture_sha256: sha256(fs.readFileSync(fixturePath)),
    created_at: new Date().toISOString(),
    semantic_review: 'pending_luna_high_or_human_review',
    paid_model_calls: 0,
    generated_cases: [],
  }
  const save = () => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    const tmp = outputPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { flag: 'w' })
    fs.renameSync(tmp, outputPath)
  }
  save()

  const server = spawn(path.resolve(args.runtime), [
    '-m', modelPath, '--host', '127.0.0.1', '--port', String(PORT), '-c', '4096', '-t', '2', '-ngl', '0', '-np', '1', '--no-webui',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  const metricSamples = []
  let metricTimer
  try {
    await waitForServer(server)
    metricTimer = setInterval(() => {
      const sample = sampleMetrics(server.pid)
      if (sample) metricSamples.push(sample)
    }, 1000)

    for (const fixture of FIXTURES) {
      const requests = []
      const provider = {
        async generate(request, { signal } = {}) {
          const profile = PROFILE[request.generationProfile] || PROFILE['quiz-mcq-v1']
          const payload = {
            model: 'local-benchmark', stream: false, messages: request.messages,
            max_tokens: request.maxTokens, json_schema: request.jsonSchema, ...profile,
          }
          const started = performance.now()
          const promptDigest = sha256(JSON.stringify({ messages: request.messages, jsonSchema: request.jsonSchema, generationProfile: request.generationProfile }))
          try {
            const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload), signal: signal || AbortSignal.timeout(TIMEOUT_MS),
            })
            if (!response.ok) throw new Error('local_runtime_http_error')
            const data = await response.json()
            const choice = data.choices?.[0]
            if (!choice || typeof choice.message?.content !== 'string') throw new Error('local_runtime_invalid_response')
            requests.push({ prompt_sha256: promptDigest, generationProfile: request.generationProfile, elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)), finish_reason: choice.finish_reason, usage: data.usage || null })
            return { text: choice.message.content, finishReason: choice.finish_reason, usage: null }
          } catch (error) {
            requests.push({ prompt_sha256: promptDigest, generationProfile: request.generationProfile, elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)), transport_error: error.name || 'Error' })
            throw error
          }
        },
      }
      const validationIssues = []
      const service = createLocalQuizService({ provider, onValidationIssue: issue => validationIssues.push(issue) })
      const request = {
        pages: Object.entries(fixture.pages).map(([pageNumber, text]) => ({ pageNumber: Number(pageNumber), text })),
        questionCount: 5,
        difficulty: fixture.difficulty,
        questionType: 'multiple_choice',
        ...(fixture.practice ? { practice: fixture.practice } : {}),
      }
      const started = performance.now()
      let outcome
      let errorCode = null
      try {
        outcome = await service.generate(request)
      } catch (error) {
        errorCode = error.code || 'generation_failed'
      }
      const row = {
        fixture: fixture.id,
        expected_outcome: fixture.expected_outcome || 'quiz',
        actual_outcome: outcome ? 'quiz' : errorCode === 'insufficient_source' ? 'insufficient_source' : 'error',
        error_code: errorCode,
        elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
        requests,
        validation_issues: validationIssues,
        gold_facts: fixture.gold_facts,
        forbidden_markers: fixture.forbidden || [],
        quiz: outcome || null,
      }
      row.expected_outcome_pass = row.actual_outcome === row.expected_outcome
      report.generated_cases.push(row)
      save()
      console.log(JSON.stringify({ candidate: candidate.id, fixture: fixture.id, outcome: row.actual_outcome, elapsed_seconds: row.elapsed_seconds, provider_calls: requests.length }))
    }
  } finally {
    clearInterval(metricTimer)
    try { server.kill() } catch {}
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10000))])
  }
  report.server_peak_working_set_bytes = metricSamples.length ? Math.max(...metricSamples.map(row => row.workingSetBytes)) : null
  report.server_peak_cpu_seconds = metricSamples.length ? Math.max(...metricSamples.map(row => row.cpuSeconds)) : null
  report.metric_samples = metricSamples.length
  report.completed_cases = report.generated_cases.length
  const quizTimes = report.generated_cases.filter(row => row.expected_outcome === 'quiz' && row.actual_outcome === 'quiz').map(row => row.elapsed_seconds).sort((a, b) => a - b)
  const middle = Math.floor(quizTimes.length / 2)
  const median = quizTimes.length ? (quizTimes.length % 2 ? quizTimes[middle] : Number(((quizTimes[middle - 1] + quizTimes[middle]) / 2).toFixed(3))) : null
  report.summary = {
    expected_cases: FIXTURES.length,
    completed_cases: report.completed_cases,
    expected_outcome_passes: report.generated_cases.filter(row => row.expected_outcome_pass).length,
    cases_with_errors: report.generated_cases.filter(row => row.actual_outcome === 'error').length,
    median_sufficient_quiz_seconds: median,
    max_sufficient_quiz_seconds: quizTimes.length ? quizTimes.at(-1) : null,
  }
  save()
  if (report.completed_cases !== FIXTURES.length) process.exitCode = 1
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message || 'evaluation_failed' }))
  process.exitCode = 1
})
