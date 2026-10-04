import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveAdSenseConfig,
} from './adSenseConfig.ts'

test('accepts a configured publisher client and numeric ad slot', () => {
  assert.deepEqual(
    resolveAdSenseConfig(
      ' ca-pub-1234567890123456 ',
      ' 1234567890 ',
    ),
    {
      client:
        'ca-pub-1234567890123456',
      homeSlot: '1234567890',
    },
  )
})

test('missing or malformed configuration disables ads fail-closed', () => {
  for (const values of [
    [undefined, undefined],
    ['', '123'],
    ['pub-123', '123'],
    ['ca-pub-123', 'slot-home'],
    ['ca-pub-abc', '123'],
  ] as const) {
    assert.equal(
      resolveAdSenseConfig(
        values[0],
        values[1],
      ),
      null,
    )
  }
})
