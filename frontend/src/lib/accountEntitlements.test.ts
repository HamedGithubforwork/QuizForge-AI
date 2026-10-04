import test from 'node:test'
import assert from 'node:assert/strict'

import {
  loadAccountEntitlements,
} from './accountEntitlements.ts'

function response(
  body: unknown,
  status = 200,
) {
  return Promise.resolve(
    new Response(
      JSON.stringify(body),
      {
        status,
        headers: {
          'Content-Type':
            'application/json',
        },
      },
    ),
  )
}

test('loads the semantic lifetime ad-free entitlement from the authenticated endpoint', async () => {
  const calls: string[] = []

  const result =
    await loadAccountEntitlements(
      async (path) => {
        calls.push(path)
        return response({
          lifetime_ad_free: true,
        })
      },
    )

  assert.deepEqual(calls, [
    '/api/account/entitlements',
  ])
  assert.deepEqual(result, {
    status: 'ready',
    lifetimeAdFree: true,
  })
})

test('free accounts remain explicitly ready rather than being treated as an entitlement failure', async () => {
  const result =
    await loadAccountEntitlements(
      async () => response({
        lifetime_ad_free: false,
      }),
    )

  assert.deepEqual(result, {
    status: 'ready',
    lifetimeAdFree: false,
  })
})

test('network and HTTP failures remain unknown so ad policy fails closed', async () => {
  assert.deepEqual(
    await loadAccountEntitlements(
      async () => response(
        { detail: 'unavailable' },
        503,
      ),
    ),
    {
      status: 'unknown',
      lifetimeAdFree: null,
    },
  )

  assert.deepEqual(
    await loadAccountEntitlements(
      async () => {
        throw new Error(
          'network unavailable',
        )
      },
    ),
    {
      status: 'unknown',
      lifetimeAdFree: null,
    },
  )
})

test('malformed entitlement responses remain unknown', async () => {
  for (const body of [
    {},
    { lifetime_ad_free: 'yes' },
    null,
  ]) {
    assert.deepEqual(
      await loadAccountEntitlements(
        async () => response(body),
      ),
      {
        status: 'unknown',
        lifetimeAdFree: null,
      },
    )
  }
})
