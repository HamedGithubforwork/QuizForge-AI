'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isDeepSeekDistill, deepSeekMessages, deepSeekFinalContent,
  DEEPSEEK_GENERATION } = require('../src/local-deepseek-adapter.cjs')
const { createWindowsLocalAiProvider, deepSeekResponseShape } = require('../src/windows-local-ai-provider.cjs')

const DEEPSEEK = 'deepseek-r1-qwen-1p5b-q4-k-m'
const QWEN = 'qwen3-4b-q4-k-m'
const messages = [
  { role: 'system', content: 'Only cite study notes. Return JSON.' },
  { role: 'user', content: '--- PAGE 1 ---\\nThe nucleus stores DNA.' },
  { role: 'user', content: 'Generate five questions.' },
]
const request = { messages, maxTokens: 1200,
  generationProfile: 'quiz-mcq-v1', jsonSchema: { type: 'object' } }

function makeProvider(id, responseContent) {
  let payload
  const provider = createWindowsLocalAiProvider({
    runtime: {
      async complete(value) {
        payload = value
        return { choices: [{ message: { content: responseContent,
          reasoning_content: 'private thought that must not enter JSON' }, finish_reason: 'stop' }] }
      },
    },
    modelStore: { status: async () => ({ ready: true }) },
    modelId: id, platform: 'win32', arch: 'x64',
  })
  return { provider, payload: () => payload }
}

test('only allowlisted distill IDs receive DeepSeek prompting', () => {
  assert.equal(isDeepSeekDistill(DEEPSEEK), true)
  assert.equal(isDeepSeekDistill('deepseek-r1-qwen-7b-q4-k-m'), true)
  assert.equal(isDeepSeekDistill(QWEN), false)
  assert.equal(isDeepSeekDistill('../custom'), false)
})

test('DeepSeek keeps source in an ordered user prompt, no system role', () => {
  const out = deepSeekMessages(messages)
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'user')
  assert.match(out[0].content, /TASK-INSTRUCTIONS 1/)
  assert.match(out[0].content, /PAGE 1/)
  assert.ok(out[0].content.indexOf('Only cite') < out[0].content.indexOf('The nucleus'))
  assert.ok(out[0].content.indexOf('The nucleus') < out[0].content.indexOf('Generate five'))
  assert.throws(() => deepSeekMessages([{role:'tool',content:'x'}]), TypeError)
})

test('strip only completed leading reasoning; never scrape partial or middle traces', () => {
  assert.equal(deepSeekFinalContent('  <think>ignore private scratchpad</think>  {"questions":[]}'), '{"questions":[]}')
  assert.equal(deepSeekFinalContent('<think>incomplete reasoning {"questions":[]}'), '<think>incomplete reasoning {"questions":[]}')
  assert.equal(deepSeekFinalContent('{"questions":[]}<think>not-leading</think>'), '{"questions":[]}<think>not-leading</think>')
  assert.equal(deepSeekFinalContent('<think>only thought</think>'), '')
  assert.equal(deepSeekFinalContent(null), null)
})

test('DeepSeek uses its own sampling profile and returns final JSON without reasoning', async () => {
  const x = makeProvider(DEEPSEEK, '<think>do not leak</think>{"questions":[]}')
  const out = await x.provider.generate(request)
  assert.equal(out.text, '{"questions":[]}')
  assert.equal(x.payload().temperature, 0.6)
  assert.equal(x.payload().top_p, DEEPSEEK_GENERATION.top_p)
  assert.equal(x.payload().seed, 42)
  assert.equal(x.payload().presence_penalty, undefined)
  assert.equal(x.payload().chat_template_kwargs, undefined)
  assert.equal(x.payload().json_schema.type, 'object')
  assert.equal(x.payload().messages.length, 1)
  assert.equal(x.payload().messages[0].role, 'user')
  assert.doesNotMatch(out.text, /do not leak|private thought/)
})

test('existing Qwen prompt, sampling settings, and output remain unchanged', async () => {
  const x = makeProvider(QWEN, '<think>preserved</think>{"questions":[]}')
  const out = await x.provider.generate(request)
  assert.equal(out.text, '<think>preserved</think>{"questions":[]}')
  assert.deepEqual(x.payload().messages, messages)
  assert.equal(x.payload().temperature, 0.7)
  assert.equal(x.payload().presence_penalty, 1.5)
  assert.equal(x.payload().chat_template_kwargs.enable_thinking, false)
})

test('safe DeepSeek response shapes distinguish reasoning-only and malformed outputs', () => {
  const shape = content => deepSeekResponseShape({
    choices: [{ message: { content, reasoning_content: 'never print this secret' },
      finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
  })
  assert.equal(shape('<think>private deliberation</think>').outputKind, 'reasoning_only')
  assert.equal(shape('<think>still working').outputKind, 'unclosed_think')
  assert.equal(shape('<think>done</think>{"questions":[]}').outputKind, 'valid_json')
  assert.equal(shape('Output: {"questions":[]}').outputKind, 'non_json')
  assert.equal(shape(null).outputKind, 'missing_content')
  assert.equal(shape('').outputKind, 'empty_content')
  const record = shape('<think>private deliberation</think>')
  assert.equal(record.reasoningFieldPresent, true)
  assert.equal(record.usageKind, 'consistent')
  assert.doesNotMatch(JSON.stringify(record), /private|secret|deliberation|questions/)
  assert.equal(deepSeekResponseShape({ choices: [{ message: { content: '{}' },
    finish_reason: 'length' }], usage: { total_tokens: 2 } }).usageKind, 'partial')
})

test('synthetic DeepSeek runtime hooks classify failures without raw exception text', async () => {
  const events = []
  const provider = createWindowsLocalAiProvider({
    runtime: { complete: async () => { throw Object.assign(
      new Error('private local student notes'),
      { code: 'request_failed' }) } },
    modelStore: { status: async () => ({ ready: true }) },
    modelId: DEEPSEEK, platform: 'win32', arch: 'x64',
    onResponseDiagnostic: event => events.push(event),
  })
  await assert.rejects(provider.generate(request), error => error.code === 'runtime_unavailable')
  assert.deepEqual(events, [{ phase: 'runtime_exception', errorCode: 'request_failed' }])
})
