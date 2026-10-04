import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adPresentationDecision,
  shouldRequestAdProvider,
  type AdSurface,
} from './adPresentationPolicy.ts'

const eligibleSurfaces: AdSurface[] = [
  'home',
  'deck_library',
  'results_summary',
  'progress',
]

const focusCriticalSurfaces: AdSurface[] = [
  'active_quiz',
  'review_session',
  'answer_reveal',
  'timed_exam',
]

test('unknown entitlement state suppresses provider requests until ownership is verified', () => {
  assert.deepEqual(
    adPresentationDecision({
      surface: 'home',
      runtime: 'browser',
      lifetimeAdFree: null,
      approvedProviderRuntime:
        'browser',
    }),
    {
      requestProvider: false,
      reason: 'entitlement_unknown',
    },
  )
})

test('ad-free ownership suppresses every provider request', () => {
  for (const surface of [
    ...eligibleSurfaces,
    ...focusCriticalSurfaces,
    'settings' as const,
  ]) {
    assert.deepEqual(
      adPresentationDecision({
        surface,
        runtime: 'browser',
        lifetimeAdFree: true,
        approvedProviderRuntime:
          'browser',
      }),
      {
        requestProvider: false,
        reason: 'ad_free',
      },
    )
  }
})

test('focus-critical study surfaces stay ad-free regardless of provider approval', () => {
  for (const surface of focusCriticalSurfaces) {
    assert.deepEqual(
      adPresentationDecision({
        surface,
        runtime: 'browser',
        lifetimeAdFree: false,
        approvedProviderRuntime:
          'browser',
      }),
      {
        requestProvider: false,
        reason: 'focus_critical',
      },
    )
  }
})

test('only explicitly eligible product surfaces may request an approved provider', () => {
  for (const surface of eligibleSurfaces) {
    assert.equal(
      shouldRequestAdProvider({
        surface,
        runtime: 'browser',
        lifetimeAdFree: false,
        approvedProviderRuntime:
          'browser',
      }),
      true,
    )
  }

  assert.deepEqual(
    adPresentationDecision({
      surface: 'settings',
      runtime: 'browser',
      lifetimeAdFree: false,
      approvedProviderRuntime:
        'browser',
    }),
    {
      requestProvider: false,
      reason: 'surface_not_eligible',
    },
  )
})

test('a provider approved for one runtime cannot leak into another runtime', () => {
  for (const runtime of [
    'desktop',
    'mobile',
  ] as const) {
    assert.deepEqual(
      adPresentationDecision({
        surface: 'home',
        runtime,
        lifetimeAdFree: false,
        approvedProviderRuntime:
          'browser',
      }),
      {
        requestProvider: false,
        reason: 'provider_unavailable',
      },
    )
  }
})

test('runtime identity alone never authorizes provider loading', () => {
  for (const runtime of [
    'browser',
    'desktop',
    'mobile',
  ] as const) {
    assert.equal(
      shouldRequestAdProvider({
        surface: 'home',
        runtime,
        lifetimeAdFree: false,
        approvedProviderRuntime: null,
      }),
      false,
    )
  }
})
