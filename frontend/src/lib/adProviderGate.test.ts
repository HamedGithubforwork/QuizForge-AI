import test from 'node:test'
import assert from 'node:assert/strict'

import {
  requestEligibleAd,
  type AdProviderAdapter,
} from './adProviderGate.ts'

function entitlementResponse(
  lifetimeAdFree: boolean,
) {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        lifetime_ad_free:
          lifetimeAdFree,
      }),
      {
        status: 200,
        headers: {
          'Content-Type':
            'application/json',
        },
      },
    ),
  )
}

function provider(
  runtime:
    | 'browser'
    | 'desktop'
    | 'mobile',
  calls: string[],
  fail = false,
): AdProviderAdapter {
  return {
    runtime,
    async request(input) {
      calls.push(input.surface)
      if (fail) {
        throw new Error(
          'provider unavailable',
        )
      }
    },
  }
}

test('eligible free browser surface is the only path that invokes a browser provider', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'home',
      runtime: 'browser',
      requestEntitlements:
        async () =>
          entitlementResponse(false),
      provider: provider(
        'browser',
        calls,
      ),
    })

  assert.deepEqual(calls, [
    'home',
  ])
  assert.equal(
    result.decision.reason,
    'eligible',
  )
  assert.equal(
    result.providerRequested,
    true,
  )
  assert.equal(
    result.providerSucceeded,
    true,
  )
})

test('lifetime ad-free ownership prevents the provider from being called', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'home',
      runtime: 'browser',
      requestEntitlements:
        async () =>
          entitlementResponse(true),
      provider: provider(
        'browser',
        calls,
      ),
    })

  assert.deepEqual(calls, [])
  assert.equal(
    result.decision.reason,
    'ad_free',
  )
  assert.equal(
    result.providerRequested,
    false,
  )
})

test('unknown entitlement state prevents the provider from being called', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'home',
      runtime: 'browser',
      requestEntitlements:
        async () =>
          new Response(
            'unavailable',
            { status: 503 },
          ),
      provider: provider(
        'browser',
        calls,
      ),
    })

  assert.deepEqual(calls, [])
  assert.equal(
    result.decision.reason,
    'entitlement_unknown',
  )
  assert.equal(
    result.providerRequested,
    false,
  )
})

test('focus-critical study surfaces never reach the provider', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'answer_reveal',
      runtime: 'browser',
      requestEntitlements:
        async () =>
          entitlementResponse(false),
      provider: provider(
        'browser',
        calls,
      ),
    })

  assert.deepEqual(calls, [])
  assert.equal(
    result.decision.reason,
    'focus_critical',
  )
})

test('provider approval cannot cross runtime boundaries', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'home',
      runtime: 'desktop',
      requestEntitlements:
        async () =>
          entitlementResponse(false),
      provider: provider(
        'browser',
        calls,
      ),
    })

  assert.deepEqual(calls, [])
  assert.equal(
    result.decision.reason,
    'provider_unavailable',
  )
})

test('ad-provider failure never breaks the study surface', async () => {
  const calls: string[] = []

  const result =
    await requestEligibleAd({
      surface: 'progress',
      runtime: 'browser',
      requestEntitlements:
        async () =>
          entitlementResponse(false),
      provider: provider(
        'browser',
        calls,
        true,
      ),
    })

  assert.deepEqual(calls, [
    'progress',
  ])
  assert.equal(
    result.providerRequested,
    true,
  )
  assert.equal(
    result.providerSucceeded,
    false,
  )
})
