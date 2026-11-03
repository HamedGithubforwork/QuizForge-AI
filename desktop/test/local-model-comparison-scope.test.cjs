'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { selectComparedModels, RETIRED_MODEL_ID } =
  require('../scripts/summarize-local-model-comparison.cjs')

test('routine comparison excludes retired 0.6B; explicit milestone still permits it', () => {
  const active = selectComparedModels().map(x => x.id)
  assert.equal(active.length, 4)
  assert.ok(active.includes('qwen3-1p7b-q4-k-m'))
  assert.ok(active.includes('qwen3-4b-q4-k-m'))
  assert.ok(!active.includes(RETIRED_MODEL_ID))
  const historical = selectComparedModels({ includeRetired: true }).map(x => x.id)
  assert.equal(historical.length, 5)
  assert.ok(historical.includes(RETIRED_MODEL_ID))
})

test('comparison workflow makes retired model strictly manual and isolated', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname,
    '../../.github/workflows/local-ai-model-comparison.yml'), 'utf8')
  assert.match(yaml, /scope == 'retired-0p6b-only'/)
  assert.match(yaml, /scope == 'full-five'/)
  assert.match(yaml, /QFN_QWEN_RETIRED_CHECK:/)
  assert.match(yaml, /\['qwen3-1p7b-q4-k-m'\]/)
  assert.match(yaml, /inputs.scope != 'retired-0p6b-only'/)
  assert.match(yaml, /QFN_INCLUDE_RETIRED:/)
})
