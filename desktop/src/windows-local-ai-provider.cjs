'use strict'

const { LocalAiError, createLocalAiProvider, failure, validId } = require('./local-ai-provider.cjs')
const RUNTIME_ERRORS = Object.freeze({
  busy: ['busy', true], unsupported_platform: ['unsupported_platform', false],
  model_missing: ['model_missing', false], invalid_model: ['invalid_model', false],
  invalid_runtime: ['runtime_invalid', false], unexpected_files: ['runtime_invalid', false],
  unsafe_directory: ['runtime_invalid', false], invalid_directory: ['runtime_invalid', false],
  invalid_manifest: ['runtime_invalid', false], startup_failed: ['runtime_unavailable', true],
  request_failed: ['runtime_unavailable', true], shutdown_failed: ['runtime_unavailable', true],
  response_too_large: ['invalid_response', false], invalid_response: ['invalid_response', false],
  request_too_large: ['invalid_request', false], invalid_request: ['invalid_request', false],
})

function runtimeError(error) {
  if (error instanceof LocalAiError || ['AbortError', 'TimeoutError'].includes(error?.name)) return error
  const mapped = Object.hasOwn(RUNTIME_ERRORS, error?.code) ? RUNTIME_ERRORS[error.code] : null
  return mapped ? failure(mapped[0], { retryable: mapped[1] }) : failure('runtime_unavailable', { retryable: true })
}

function createWindowsLocalAiProvider({ runtime, modelStore, modelId, platform = process.platform, arch = process.arch }) {
  if (!runtime || typeof runtime.complete !== 'function' || !modelStore ||
      typeof modelStore.status !== 'function' || !validId(modelId)) throw failure('invalid_provider')
  const supported = () => platform === 'win32' && arch === 'x64'
  return createLocalAiProvider({
    id: 'windows-local',
    async capability({ signal }) {
      if (!supported()) return { available: false, reason: 'unsupported_platform', modelId }
      let status
      try { status = await modelStore.status({ signal }) } catch (error) { throw runtimeError(error) }
      if (!status || typeof status.ready !== 'boolean') throw failure('invalid_capability')
      return { available: status.ready, reason: status.ready ? null : 'model_missing', modelId }
    },
    async generate(request, { signal }) {
      if (!supported()) throw failure('unsupported_platform')
      let response
      try {
        response = await runtime.complete({ messages: request.messages, max_tokens: request.maxTokens }, { signal })
      } catch (error) { throw runtimeError(error) }
      if (!Array.isArray(response?.choices) || response.choices.length !== 1) throw failure('invalid_response')
      const choice = response.choices[0]
      if (choice?.message?.tool_calls != null || choice?.message?.function_call != null) throw failure('invalid_response')
      let usage = null
      if (response.usage != null) {
        if (typeof response.usage !== 'object' || Array.isArray(response.usage)) throw failure('invalid_response')
        usage = { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens }
      }
      return { text: choice?.message?.content, finishReason: choice?.finish_reason, usage }
    },
  })
}

module.exports = { createWindowsLocalAiProvider }
