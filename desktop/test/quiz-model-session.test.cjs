'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWindowsLocalAiProvider } = require('../src/windows-local-ai-provider.cjs')

test('Windows provider forwards sequential quiz batches to one scoped inference session', async () => {
  let opens = 0
  let completions = 0
  let directCompletions = 0
  const runtime = {
    async complete() { directCompletions++; throw new Error('unexpected per-batch startup') },
    async withSession(callback) {
      opens++
      return callback(async (payload) => {
        completions++
        assert.equal(payload.chat_template_kwargs.enable_thinking, false)
        assert.equal(payload.model, undefined)
        assert.equal(payload.max_tokens, 900)
        return {
          choices: [{ message: { content: '{"quiz":"part"}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }
      })
    },
  }
  const provider = createWindowsLocalAiProvider({
    runtime,
    modelStore: { status: async () => ({ ready: true }) },
    modelId: 'qwen3-4b-q4-k-m',
    platform: 'win32', arch: 'x64',
  })
  assert.equal(typeof provider.withSession, 'function')
  const results = await provider.withSession(async scoped => {
    assert.equal(typeof scoped.withSession, 'undefined')
    const requests = [1, 2, 3].map(index => ({
      generationProfile: 'quiz-mcq-v1', maxTokens: 900,
      messages: [{ role: 'user', content: 'Batch ' + index }],
    }))
    const answers = []
    for (const request of requests) answers.push(await scoped.generate(request))
    return answers
  })
  assert.equal(opens, 1)
  assert.equal(completions, 3)
  assert.equal(directCompletions, 0)
  assert.equal(results.length, 3)
  assert.ok(results.every(result => result.finishReason === 'stop'))
  assert.ok(results.every(result => result.usage.totalTokens === 150))
})
