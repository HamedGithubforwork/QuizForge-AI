import test from 'node:test'
import assert from 'node:assert/strict'

import {
  reportLocalGenerationUsage,
} from './generationUsage.ts'

test('reports only the bounded local generation event payload', async () => {
  let capturedPath = ''
  let capturedInit:
    | RequestInit
    | undefined

  const ok =
    await reportLocalGenerationUsage(
      async (path, init) => {
        capturedPath = path
        capturedInit = init
        return new Response(null, {
          status: 204,
        })
      },
      'quiz',
    )

  assert.equal(ok, true)
  assert.equal(
    capturedPath,
    '/api/generation-usage/local',
  )
  assert.equal(
    capturedInit?.method,
    'POST',
  )
  assert.equal(
    capturedInit?.body,
    JSON.stringify({
      kind: 'quiz',
    }),
  )
})

test('telemetry failure never breaks the completed local quiz', async () => {
  assert.equal(
    await reportLocalGenerationUsage(
      async () => {
        throw new Error('offline')
      },
      'targeted_practice',
    ),
    false,
  )

  assert.equal(
    await reportLocalGenerationUsage(
      async () =>
        new Response(null, {
          status: 503,
        }),
      'quiz',
    ),
    false,
  )
})
