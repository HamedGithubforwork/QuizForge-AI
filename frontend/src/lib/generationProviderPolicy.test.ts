import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveQuizGenerationMode,
} from './generationProviderPolicy.ts'

test('defaults to Local AI only when the native local quiz path is ready', () => {
  assert.equal(resolveQuizGenerationMode({
    explicitMode: null,
    localAvailable: true,
  }), 'local')
  assert.equal(resolveQuizGenerationMode({
    explicitMode: null,
    localAvailable: false,
  }), 'cloud')
})

test('preserves an explicit provider choice instead of silently falling back', () => {
  assert.equal(resolveQuizGenerationMode({
    explicitMode: 'cloud',
    localAvailable: true,
  }), 'cloud')
  assert.equal(resolveQuizGenerationMode({
    explicitMode: 'local',
    localAvailable: false,
  }), 'local')
})
