'use strict'

// CI-only, allowlisted A/B candidates. Desktop product selection remains Qwen.
// Each download is checked against the exact upstream SHA-256 and byte count.
const { CANDIDATE } = require('./local-model-store.cjs')

const BENCHMARK_MODELS = Object.freeze({
  [CANDIDATE.id]: CANDIDATE,
  'qwen3-1p7b-q4-k-m': Object.freeze({
    id: 'qwen3-1p7b-q4-k-m',
    displayName: 'Qwen3 1.7B Q4_K_M',
    repository: 'ggml-org/Qwen3-1.7B-GGUF',
    license: 'Apache-2.0',
    bytes: 1282439264,
    sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
  }),
  'qwen3-0p6b-q4-k-m': Object.freeze({
    id: 'qwen3-0p6b-q4-k-m',
    displayName: 'Qwen3 0.6B Q4_K_M',
    repository: 'bartowski/Qwen_Qwen3-0.6B-GGUF',
    license: 'Apache-2.0',
    bytes: 484220320,
    sha256: '9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf',
  }),
  'deepseek-r1-qwen-1p5b-q4-k-m': Object.freeze({
    id: 'deepseek-r1-qwen-1p5b-q4-k-m',
    displayName: 'DeepSeek R1 Distill Qwen 1.5B Q4_K_M',
    repository: 'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF',
    license: 'MIT',
    bytes: 1117320800,
    sha256: '1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f',
    url: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf',
  }),
  'deepseek-r1-qwen-7b-q4-k-m': Object.freeze({
    id: 'deepseek-r1-qwen-7b-q4-k-m',
    displayName: 'DeepSeek R1 Distill Qwen 7B Q4_K_M',
    repository: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF',
    license: 'MIT',
    bytes: 4683073504,
    sha256: '731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b',
    url: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf',
  }),
})

function getBenchmarkModel(id) {
  if (typeof id !== 'string' || !Object.hasOwn(BENCHMARK_MODELS, id)) {
    throw new TypeError('Unknown allowlisted Local AI benchmark model')
  }
  return BENCHMARK_MODELS[id]
}

module.exports = { BENCHMARK_MODELS, getBenchmarkModel }
