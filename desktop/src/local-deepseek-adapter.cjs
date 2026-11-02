'use strict'

// CI-only DeepSeek-R1 distill compatibility: do not alter the shipped Qwen path.
// DeepSeek's published instructions recommend user-role prompts and ~0.6 temp.
// Keep raw reasoning out of quiz JSON validation and out of diagnostic reports.
const DEEPSEEK_IDS = Object.freeze(new Set([
  'deepseek-r1-qwen-1p5b-q4-k-m',
  'deepseek-r1-qwen-7b-q4-k-m',
]))
const DEEPSEEK_GENERATION = Object.freeze({
  temperature: 0.6,
  top_p: 0.95,
  seed: 42,
})

function isDeepSeekDistill(modelId) {
  return typeof modelId === 'string' && DEEPSEEK_IDS.has(modelId)
}

function deepSeekMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 ||
      messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) ||
        typeof m.content !== 'string')) throw new TypeError('Invalid DeepSeek chat input')
  // The roles remain identified by ordered boundary markers. The source is
  // *still untrusted* and never promoted to a system instruction.
  const content = messages.map((m, i) => {
    const kind = m.role === 'system' ? 'TASK-INSTRUCTIONS' :
      m.role === 'assistant' ? 'PREVIOUS-ASSISTANT' : 'USER-INPUT'
    return '[' + kind + ' ' + (i + 1) + ']\n' + m.content +
      '\n[/'+ kind + ' ' + (i + 1) + ']'
  }).join('\n\n')
  if (content.length > 60000) throw new TypeError('DeepSeek input too large')
  return [{ role: 'user', content }]
}

function deepSeekFinalContent(content) {
  if (typeof content !== 'string') return content
  // Some llama.cpp configurations keep a completed think block in content,
  // others expose reasoning_content separately. Only remove a COMPLETE,
  // leading block. Never harvest JSON out of an incomplete reasoning trace.
  const first = content.match(/^\s*<think>[\s\S]*?<\/think>\s*/)
  if (first) return content.slice(first[0].length).trim()
  return content
}

module.exports = { isDeepSeekDistill, deepSeekMessages, deepSeekFinalContent,
  DEEPSEEK_GENERATION }
