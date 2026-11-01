'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const LIMIT = 300
const MAX_BYTES = 512 * 1024
const events = new Set(['session_started', 'page_load_failed', 'renderer_exited',
  'question_rejected', 'availability_failed', 'operation_started', 'operation_completed', 'operation_failed', 'cancel_requested',
  'execution_selected', 'gpu_startup_failed', 'runtime_started', 'runtime_stopped',
  'inference_completed', 'validation_failed', 'runtime_launch', 'runtime_ready', 'runtime_failed'])
const reasons = new Set(('cancelled timed_out busy model_missing invalid_model runtime_invalid runtime_unavailable source_too_large document_too_large unsupported_quiz_mode quiz_validation_failed insufficient_source invalid_request invalid_response generation_failed invalid_input invalid_selection input_too_large too_many_pages text_too_large processing_failed unsupported_platform insufficient_memory insufficient_disk runtime_acceleration_unavailable no_eligible_local_profile avoided_question duplicate_choices duplicate_question duplicate_source_fact insufficient_source_facts invalid_abstention json mixed_type_coverage multiple_choice_shape question_count question_shape requested_type_mismatch short_answer_shape short_answer_format short_answer_unsupported_answer source_fact_shape top_level_shape true_false_shape truncated_output unexpected_output_script unsupported_answer unsupported_source_fact candidate_pool_exhausted startup_failed shutdown_failed runtime_closed invalid_runtime unexpected_files unsafe_directory invalid_directory invalid_manifest request_failed request_too_large response_too_large invalid_json watchdog_failed watchdog_timeout watchdog_shutdown_failed clean-exit abnormal-exit killed crashed oom launch-failed integrity-failure unknown').split(' '))
const enums = {
  stage: ['verification', 'startup', 'inference', 'cleanup'],
  kind: ['quiz', 'document_quiz', 'pdf'],
  difficulty: ['easy', 'medium', 'hard'],
  questionType: ['multiple_choice', 'true_false', 'short_answer', 'mixed'],
  acceleration: ['cpu', 'gpu', 'unknown'],
  attempt: ['primary', 'retry', 'recovery'],
}
const numbers = ['questionNumber', 'elapsedMs', 'questionCount', 'returnedCount', 'layers', 'completionTokens',
  'logicalCpuCount', 'gpuMemoryBytes', 'totalMemoryBytes']
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)

// Reapply the same allowlist to disk contents and live events. Never persist raw
// errors, process arguments/output, paths, account data, prompts or quiz content.
function sanitize(value) {
  if (!value || !events.has(value.event)) return null
  const result = { event: value.event }
  for (const key of ['sessionId', 'operationId']) if (uuid(value[key])) result[key] = value[key]
  if (typeof value.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.time)) result.time = value.time
  for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(value[key])) result[key] = value[key]
  for (const key of numbers) if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= Number.MAX_SAFE_INTEGER) result[key] = Math.round(value[key])
  if (value.reason !== undefined) result.reason = reasons.has(value.reason) ? value.reason : 'unknown'
  if (Array.isArray(value.sourcePages)) result.sourcePages = value.sourcePages.filter(page => Number.isSafeInteger(page) && page > 0 && page <= 1000000).slice(0, 8)
  if (typeof value.gpuDetected === 'boolean') result.gpuDetected = value.gpuDetected
  if (typeof value.appVersion === 'string' && /^\d{1,4}(\.\d{1,6}){1,3}(-[A-Za-z0-9.-]{1,40})?$/.test(value.appVersion)) result.appVersion = value.appVersion
  return result
}

function createDiagnosticHistory({ directory, appVersion }) {
  const sessionId = randomUUID()
  let records = []
  let persistence = 'available'
  const file = path.join(directory, 'history.json')
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error('oversized')
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(saved)) records = saved.slice(-LIMIT).map(sanitize).filter(Boolean)
    }
  } catch { persistence = 'unavailable' }
  function record(event, fields = {}) {
    const entry = sanitize({ ...fields, event, sessionId, time: new Date().toISOString() })
    if (!entry) return
    records.push(entry)
    records = records.slice(-LIMIT)
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(records), { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
      persistence = 'available'
    } catch { persistence = 'unavailable' }
  }
  record('session_started', { appVersion })
  return { record, snapshot: () => ({ persistence, limit: LIMIT, records: records.map(entry => ({ ...entry })) }) }
}

module.exports = { createDiagnosticHistory }
