import assert from 'node:assert/strict'
import test from 'node:test'

import {
  base64UrlToBytes,
  getStudyNotificationPreferences,
  saveStudyNotificationPreferences,
  subscriptionPayload,
} from './studyNotifications.ts'

test(
  'base64UrlToBytes decodes a VAPID public key without padding',
  () => {
    const bytes =
      base64UrlToBytes(
        'BAECAwQFBgcICQ',
      )
    assert.deepEqual(
      Array.from(bytes),
      [4, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    )
  },
)

test(
  'subscriptionPayload serializes browser encryption keys',
  () => {
    const values: Record<
      string,
      Uint8Array
    > = {
      p256dh:
        Uint8Array.from([
          1, 2, 3, 4,
        ]),
      auth:
        Uint8Array.from([
          250, 251, 252,
        ]),
    }

    const payload =
      subscriptionPayload({
        endpoint:
          'https://push.example/sub',
        getKey(name) {
          const value =
            values[name]
          return value
            ? value.buffer
            : null
        },
      })

    assert.deepEqual(
      payload,
      {
        endpoint:
          'https://push.example/sub',
        keys: {
          p256dh:
            'AQIDBA',
          auth:
            '-vv8',
        },
      },
    )
  },
)

test(
  'notification preference clients use GET and PUT safely',
  async () => {
    const requests: Array<{
      path: string
      init: RequestInit
    }> = []

    const fetcher = async (
      path: string,
      init: RequestInit = {},
    ) => {
      requests.push({
        path,
        init,
      })
      return new Response(
        JSON.stringify({
          enabled: true,
          reminder_time:
            '20:30:00',
          timezone:
            'America/Toronto',
          minimum_due_cards: 3,
        }),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json',
          },
        },
      )
    }

    const loaded =
      await getStudyNotificationPreferences(
        fetcher,
      )
    assert.equal(
      loaded.enabled,
      true,
    )

    await saveStudyNotificationPreferences(
      {
        enabled: true,
        reminder_time: '20:30',
        timezone:
          'America/Toronto',
        minimum_due_cards: 3,
      },
      fetcher,
    )

    assert.equal(
      requests[0].path,
      '/api/study-notifications/preferences',
    )
    assert.equal(
      requests[0].init.method,
      undefined,
    )
    assert.equal(
      requests[1].init.method,
      'PUT',
    )
    assert.deepEqual(
      JSON.parse(
        String(
          requests[1].init.body,
        ),
      ),
      {
        enabled: true,
        reminder_time: '20:30',
        timezone:
          'America/Toronto',
        minimum_due_cards: 3,
      },
    )
  },
)
