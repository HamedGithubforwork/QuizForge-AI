'use strict'

const {
  LocalAiError,
  createLocalAiProvider,
  failure,
} = require('./local-ai-provider.cjs')

const RUNTIME_ERRORS = Object.freeze({
  busy: ['busy', true],
  unsupported_platform: ['unsupported_platform', false],
  model_missing: ['model_missing', false],
  invalid_runtime: ['runtime_invalid', false],
  unexpected_files: ['runtime_invalid', false],
  startup_failed: ['runtime_unavailable', true],
  request_failed: ['runtime_unavailable', true],
  shutdown_failed: ['runtime_unavailable', true],
  response_too_large: ['invalid_response', false],
  invalid_response: ['invalid_response', false],
  request_too_large: ['invalid_request', false],
  invalid_request: ['invalid_request', false],
})

function runtimeError(error, signal) {
  if (error instanceof LocalAiError) return error
  if (signal?.aborted || error?.name === 'AbortError') return failure('cancelled', { cause: error })
  const mapped = RUNTIME_ERRORS[error?.code]
  if (mapped) return failure(mapped[0], { retryable: mapped[1], cause: error })
  return failure('runtime_unavailable', { retryable: true, cause: error })
}

function normalizeRuntimeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const inputTokens = value.prompt_tokens
  const outputTokens = value.completion_tokens
  const totalTokens = value.total_tokens
  const result = {}
  if (Number.isSafeInteger(inputTokens) && inputTokens >= 0) result.inputTokens = inputTokens
  if (Number.isSafeInteger(outputTokens) && outputTokens >= 0) result.outputTokens = outputTokens
  if (Number.isSafeInteger(totalTokens) && totalTokens >= 0) result.totalTokens = totalTokens
  return result
}

function createWindowsLocalAiProvider({
  runtime,
  modelStore,
  modelId,
  platform = process.platform,
  arch = process.arch,
}) {
  if (!runtime || typeof runtime.complete !== 'function' ||
      !modelStore || typeof modelStore.status !== 'function' ||
      typeof modelId !== 'string' || modelId.length < 1 || modelId.length > 200) {
    throw failure('invalid_provider')
  }

  return createLocalAiProvider({
    id: 'windows-local',

    async capability({ signal }) {
      if (platform !== 'win32' || arch !== 'x64') {
        return { available: false, reason: 'unsupported_platform', modelId }
      }
      let status
      try {
        status = await modelStore.status({ signal })
      } catch (error) {
        throw runtimeError(error, signal)
      }
      return {
        available: status?.ready === true,
        reason: status?.ready === true ? null : 'model_missing',
        modelId,
      }
    },

    async generate(request, { signal }) {
      let response
      try {
        response = await runtime.complete({
          messages: request.messages,
          max_tokens: request.maxTokens,
        }, { signal })
      } catch (error) {
        throw runtimeError(error, signal)
      }
      const choice = response?.choices?.[0]
      const text = choice?.message?.content
      if (typeof text !== 'string' || text.length < 1) throw failure('invalid_response')
      return {
        text,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        usage: normalizeRuntimeUsage(response.usage),
      }
    },
  })
}

module.exports = {
  createWindowsLocalAiProvider,
  runtimeError,
}
