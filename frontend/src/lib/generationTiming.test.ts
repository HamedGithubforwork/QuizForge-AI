import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendGenerationTiming, estimateGenerationTime,
  formatGenerationDuration, readGenerationTimings, storeGenerationTimings,
  type GenerationTimingProfile, type GenerationTimingSample,
} from './generationTiming.ts'

const profile: GenerationTimingProfile = {
  engine: 'local', questionCount: 5, difficulty: 'easy', questionType: 'multiple_choice',
}

test('elapsed timer formats minutes and seconds without promising finish times', () => {
  assert.equal(formatGenerationDuration(0), '0:00')
  assert.equal(formatGenerationDuration(30_999), '0:30')
  assert.equal(formatGenerationDuration(124_000), '2:04')
})

test('estimate starts only after two matching successful settings samples', () => {
  const one = appendGenerationTiming([], profile, 65_000)
  assert.equal(estimateGenerationTime(one, profile, 3_000), null)
  const two = appendGenerationTiming(one, profile, 95_000)
  assert.equal(estimateGenerationTime(two, { ...profile, engine: 'cloud' }, 3_000), null)
  assert.equal(estimateGenerationTime(two, { ...profile, questionType: 'mixed' }, 3_000), null)
  const estimate = estimateGenerationTime(two, profile, 40_000)
  assert.ok(estimate)
  assert.equal(estimate.sampleCount, 2)
  assert.ok(estimate.lowerRemainingMs > 0)
  assert.ok(estimate.upperRemainingMs > estimate.lowerRemainingMs)
  const overdue = estimateGenerationTime(two, profile, 200_000)
  assert.ok(overdue?.overdue)
  assert.equal(overdue.upperRemainingMs, 0)
})

test('practice timings do not borrow regular quiz estimates and legacy samples remain quizzes', () => {
  const practice = { ...profile, kind: 'practice' as const }
  let samples = appendGenerationTiming([], profile, 60_000)
  samples = appendGenerationTiming(samples, profile, 70_000)
  assert.equal(estimateGenerationTime(samples, practice, 1_000), null)
  samples = appendGenerationTiming(samples, practice, 90_000)
  assert.equal(estimateGenerationTime(samples, practice, 1_000), null)
  samples = appendGenerationTiming(samples, practice, 110_000)
  assert.equal(estimateGenerationTime(samples, practice, 10_000)?.sampleCount, 2)
  assert.equal(estimateGenerationTime(samples, profile, 10_000)?.sampleCount, 2)
  const loaded = readGenerationTimings({
    getItem() { return JSON.stringify(samples) },
  })
  assert.equal(estimateGenerationTime(loaded, practice, 10_000)?.sampleCount, 2)
  assert.equal(loaded.filter(x => x.kind === 'practice').length, 2)
  assert.equal(loaded.filter(x => x.kind === undefined).length, 2)
  assert.deepEqual(appendGenerationTiming([], { ...practice, kind: 'wrong' as 'practice' }, 3_000), [])
})

test('only valid durations and settings are stored; limit and failed storage are safe', () => {
  const samples = appendGenerationTiming([], profile, 0)
  assert.deepEqual(samples, [])
  assert.deepEqual(appendGenerationTiming(samples, profile, 31 * 60 * 1000), [])
  let bounded: GenerationTimingSample[] = [...samples]
  for (let i = 0; i < 60; i++) bounded = appendGenerationTiming(bounded, profile, 1000 + i)
  assert.equal(bounded.length, 24)
  let saved = ''
  storeGenerationTimings({ setItem(_key, data) { saved = data } }, bounded)
  const loaded = readGenerationTimings({ getItem() { return saved } })
  assert.deepEqual(loaded, bounded)
  const injected = [...bounded, { ...profile, elapsedMs: -1, studentAnswer: 'private' }]
  const sanitized = readGenerationTimings({ getItem() { return JSON.stringify(injected) } })
  assert.equal(sanitized.length, 23)
  assert.ok(sanitized.every(item => !('studentAnswer' in item)))
  assert.deepEqual(readGenerationTimings({ getItem() { throw new Error('denied') } }), [])
  assert.doesNotThrow(() => storeGenerationTimings({ setItem() { throw new Error('denied') } }, bounded))
})
