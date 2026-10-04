import test from 'node:test'
import assert from 'node:assert/strict'

import {
  automaticGenerationMode,
  showGenerationModeSelector,
} from './generationModePolicy.ts'
import type {
  DesktopLocalAiQuizStatus,
} from './desktop.ts'

const ready: DesktopLocalAiQuizStatus = {
  available: true,
  reason: null,
  busy: false,
  modelId: 'qwen3-4b-q4-k-m',
  execution: 'local',
  constraints: {
    questionCount: 5,
    questionType: 'multiple_choice',
    maxSourceBytes: 8000,
  },
}

test('ready desktop Local AI becomes the automatic no-cloud-cost default', () => {
  assert.equal(
    automaticGenerationMode(
      'cloud',
      ready,
      false,
    ),
    'local',
  )
})

test('explicit user provider choice always wins', () => {
  assert.equal(
    automaticGenerationMode(
      'cloud',
      ready,
      true,
    ),
    'cloud',
  )
  assert.equal(
    automaticGenerationMode(
      'local',
      {
        ...ready,
        available: false,
        reason: 'runtime_unavailable',
      },
      true,
    ),
    'local',
  )
})

test('loss of local readiness never silently switches an existing local selection to cloud', () => {
  assert.equal(
    automaticGenerationMode(
      'local',
      {
        ...ready,
        available: false,
        reason: 'runtime_unavailable',
      },
      false,
    ),
    'local',
  )
  assert.equal(
    showGenerationModeSelector(
      'local',
      false,
    ),
    true,
  )
})

test('browser and non-ready desktop paths preserve their current cloud mode', () => {
  assert.equal(
    automaticGenerationMode(
      'cloud',
      null,
      false,
    ),
    'cloud',
  )
  assert.equal(
    automaticGenerationMode(
      'cloud',
      {
        ...ready,
        available: false,
        reason: 'model_missing',
      },
      false,
    ),
    'cloud',
  )
  assert.equal(
    showGenerationModeSelector(
      'cloud',
      false,
    ),
    false,
  )
})
