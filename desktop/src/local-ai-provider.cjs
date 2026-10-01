'use strict'

class LocalAiError extends Error {
  constructor(code, { retryable = false, cause } = {}) {
    super('Local AI: ' + code, cause ? { cause } : undefined)
    this.name = 'LocalAiError'
    this.code = code
    this.retryable = retryable
  }
}

const ROLES = new Set(['system', 'user', 'assistant'])

function failure(code, options) {
  return new LocalAiError(code, options)
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('invalid_request')
  }
  const keys = Object.keys(value).sort()
  if (keys.some(key => !['maxTokens', 'messages'].includes(key))) {
    throw failure('invalid_request')
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 64) {
    throw failure('invalid_request')
  }
  const messages = value.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        !ROLES.has(message.role) || typeof message.content !== 'string' ||
        message.content.length < 1 || message.content.length > 100000 ||
        Object.keys(message).some(key => !['role', 'content'].includes(key))) {
      throw failure('invalid_request')
    }
    return Object.freeze({ role: message.role, content: message.content })
  })
  const maxTokens = value.maxTokens === undefined ? 1800 : value.maxTokens
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1800) {
    throw failure('invalid_request')
  }
  return Object.freeze({ messages: Object.freeze(messages), maxTokens })
}

function normalizeCapability(value) {
  if (!value || typeof value !== 'object' || typeof value.available !== 'boolean') {
    throw failure('invalid_capability')
  }
  const reason = value.reason ?? null
  const modelId = value.modelId ?? null
  if ((reason !== null && (typeof reason !== 'string' || reason.length > 100)) ||
      (modelId !== null && (typeof modelId !== 'string' || modelId.length > 200))) {
    throw failure('invalid_capability')
  }
  return Object.freeze({
    available: value.available,
    reason,
    modelId,
    execution: 'local',
  })
}

function normalizeUsage(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object') throw failure('invalid_response')
  const usage = {}
  for (const [target, source] of [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['totalTokens', 'totalTokens'],
  ]) {
    const number = value[source]
    if (number !== undefined) {
      if (!Number.isSafeInteger(number) || number < 0) throw failure('invalid_response')
      usage[target] = number
    }
  }
  return Object.freeze(usage)
}

function normalizeResult(value) {
  if (!value || typeof value !== 'object' || typeof value.text !== 'string' ||
      value.text.length < 1 || Buffer.byteLength(value.text, 'utf8') > 4 * 1024 * 1024) {
    throw failure('invalid_response')
  }
  const finishReason = value.finishReason ?? null
  if (finishReason !== null && (typeof finishReason !== 'string' || finishReason.length > 100)) {
    throw failure('invalid_response')
  }
  return Object.freeze({
    text: value.text,
    finishReason,
    usage: normalizeUsage(value.usage),
  })
}

function normalizeError(error, signal, fallbackCode) {
  if (error instanceof LocalAiError) return error
  if (signal?.aborted || error?.name === 'AbortError') {
    return failure('cancelled', { cause: error })
  }
  return failure(fallbackCode, { retryable: true, cause: error })
}

function createLocalAiProvider({ id, capability, generate }) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
      typeof capability !== 'function' || typeof generate !== 'function') {
    throw failure('invalid_provider')
  }

  return Object.freeze({
    id,

    async capability({ signal } = {}) {
      signal?.throwIfAborted()
      try {
        return normalizeCapability(await capability({ signal }))
      } catch (error) {
        throw normalizeError(error, signal, 'capability_failed')
      }
    },

    async generate(request, { signal } = {}) {
      const normalized = normalizeRequest(request)
      signal?.throwIfAborted()
      try {
        return normalizeResult(await generate(normalized, { signal }))
      } catch (error) {
        throw normalizeError(error, signal, 'generation_failed')
      }
    },
  })
}

module.exports = {
  LocalAiError,
  createLocalAiProvider,
  failure,
  normalizeRequest,
}
