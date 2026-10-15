'use strict'

// Portable contract: no Electron, filesystem, process, transport or model imports.
const ERROR_CODES = new Set([
  'invalid_provider', 'invalid_request', 'invalid_response', 'invalid_capability',
  'cancelled', 'timed_out', 'busy', 'unsupported_platform', 'model_missing',
  'runtime_invalid', 'runtime_unavailable', 'capability_failed', 'generation_failed',
  'invalid_model_store', 'invalid_model_status', 'invalid_model_progress',
  'insufficient_disk', 'invalid_model', 'invalid_download', 'unapproved_download',
  'unsafe_model', 'model_store_failed', 'source_too_large', 'unsupported_quiz_mode',
  'quiz_validation_failed', 'insufficient_source',
])
const REASONS = new Set(['unsupported_platform', 'model_missing', 'runtime_unavailable', 'runtime_invalid'])
const ROLES = new Set(['system', 'user', 'assistant'])
const PROFILES = new Set([
  'quiz-mcq-v1',
  'quiz-mcq-retry-v1',
  'quiz-mcq-targeted-retry-v1',
  'quiz-mcq-targeted-retry-v2',
  'quiz-mcq-targeted-retry-v3',
  'quiz-mcq-targeted-retry-v4',
  'quiz-mcq-targeted-retry-v5',
])
const encoder = new TextEncoder()
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(value)

class LocalAiError extends Error {
  constructor(code, { retryable = false } = {}) {
    const safe = ERROR_CODES.has(code) ? code : 'generation_failed'
    super('Local AI: ' + safe)
    this.name = 'LocalAiError'
    this.code = safe
    this.retryable = retryable === true
    // Do not attach raw causes: runtime errors can contain credentials or paths.
  }
}
const failure = (code, options) => new LocalAiError(code, options)

function checkCancelled(signal) {
  if (!signal?.aborted) return
  if (signal.reason?.name === 'TimeoutError') {
    throw failure('timed_out', { retryable: true })
  }
  if (['watchdog_failed', 'watchdog_timeout', 'watchdog_shutdown_failed']
    .includes(signal.reason?.code)) {
    throw failure('runtime_unavailable')
  }
  throw failure('cancelled')
}

function normalizeError(error, signal, fallback) {
  checkCancelled(signal)
  if (error?.name === 'AbortError') return failure('cancelled')
  if (error?.name === 'TimeoutError') return failure('timed_out', { retryable: true })
  if (error instanceof LocalAiError) return failure(error.code, { retryable: error.retryable })
  return failure(fallback, { retryable: true })
}

async function runOperation(operation, { signal, fallback, checkAfter = true }) {
  try {
    checkCancelled(signal)
    const result = await operation()
    if (checkAfter) checkCancelled(signal)
    return result
  } catch (error) {
    throw normalizeError(error, signal, fallback)
  }
}

function normalizeRequest(value) {
  if (!record(value) || Object.keys(value).some(key => !['generationProfile', 'jsonSchema', 'maxTokens', 'messages'].includes(key)) ||
      !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 64) {
    throw failure('invalid_request')
  }
  const messages = value.messages.map(message => {
    if (!record(message) || !ROLES.has(message.role) || typeof message.content !== 'string' ||
        !message.content.trim() || message.content.length > 60000 ||
        Object.keys(message).some(key => !['role', 'content'].includes(key))) throw failure('invalid_request')
    return Object.freeze({ role: message.role, content: message.content })
  })
  const maxTokens = value.maxTokens === undefined ? 1800 : value.maxTokens
  let jsonSchema
  if (value.jsonSchema !== undefined) {
    if (!record(value.jsonSchema)) throw failure('invalid_request')
    let serialized
    try { serialized = JSON.stringify(value.jsonSchema) } catch { throw failure('invalid_request') }
    if (!serialized || encoder.encode(serialized).byteLength > 16000) throw failure('invalid_request')
    try { jsonSchema = JSON.parse(serialized) } catch { throw failure('invalid_request') }
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1800 ||
      encoder.encode(JSON.stringify({ messages, jsonSchema })).byteLength > 60000) throw failure('invalid_request')
  const generationProfile = value.generationProfile
  if (generationProfile !== undefined && !PROFILES.has(generationProfile)) {
    throw failure('invalid_request')
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    maxTokens,
    ...(jsonSchema === undefined ? {} : { jsonSchema: Object.freeze(jsonSchema) }),
    ...(generationProfile === undefined ? {} : { generationProfile }),
  })
}

function normalizeCapability(value) {
  if (!record(value) || typeof value.available !== 'boolean' || !validId(value.modelId) ||
      (value.available ? value.reason != null : !REASONS.has(value.reason))) throw failure('invalid_capability')
  return Object.freeze({ available: value.available, reason: value.reason ?? null,
    modelId: value.modelId, execution: 'local' })
}

function normalizeResult(value) {
  if (!record(value) || typeof value.text !== 'string' || !value.text.trim() ||
      encoder.encode(value.text).byteLength > 262144 ||
      !['stop', 'length'].includes(value.finishReason)) throw failure('invalid_response')
  let usage = null
  if (value.usage != null) {
    if (!record(value.usage)) throw failure('invalid_response')
    usage = {}
    for (const name of ['inputTokens', 'outputTokens', 'totalTokens']) {
      if (value.usage[name] === undefined) continue
      if (!Number.isSafeInteger(value.usage[name]) || value.usage[name] < 0) throw failure('invalid_response')
      usage[name] = value.usage[name]
    }
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== undefined &&
        usage.totalTokens !== usage.inputTokens + usage.outputTokens) throw failure('invalid_response')
    Object.freeze(usage)
  }
  return Object.freeze({ text: value.text, finishReason: value.finishReason, usage })
}

function createLocalAiProvider({ id, capability, generate }) {
  if (!validId(id) || typeof capability !== 'function' || typeof generate !== 'function') throw failure('invalid_provider')
  return Object.freeze({
    id,
    capability({ signal } = {}) {
      return runOperation(async () => normalizeCapability(await capability({ signal })),
        { signal, fallback: 'capability_failed' })
    },
    generate(request, { signal } = {}) {
      return runOperation(async () => normalizeResult(await generate(normalizeRequest(request), { signal })),
        { signal, fallback: 'generation_failed' })
    },
  })
}

module.exports = { LocalAiError, createLocalAiProvider, failure, normalizeRequest, runOperation, validId }
