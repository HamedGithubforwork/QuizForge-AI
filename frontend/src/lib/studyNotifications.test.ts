import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deletePushSubscription,
  getPushPublicKey,
  getStudyNotificationPreferences,
  savePushSubscription,
  saveStudyNotificationPreferences,
} from './studyNotifications.ts'

test(
  'loads study notification preferences',
  async () => {
    let path = ''

    const preferences =
      await getStudyNotificationPreferences(
        async (requestPath) => {
          path = requestPath
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
        },
      )

    assert.equal(
      path,
      '/api/study-notifications/preferences',
    )
    assert.equal(
      preferences.minimum_due_cards,
      3,
    )
  },
)

test(
  'saves complete reminder preferences',
  async () => {
    let init: RequestInit = {}

    await saveStudyNotificationPreferences(
      {
        enabled: true,
        reminder_time: '19:15',
        timezone:
          'America/Toronto',
        minimum_due_cards: 2,
      },
      async (
        _path,
        requestInit,
      ) => {
        init =
          requestInit ?? {}
        return new Response(
          JSON.stringify({
            enabled: true,
            reminder_time:
              '19:15:00',
            timezone:
              'America/Toronto',
            minimum_due_cards: 2,
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        )
      },
    )

    assert.equal(
      init.method,
      'PUT',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        enabled: true,
        reminder_time: '19:15',
        timezone:
          'America/Toronto',
        minimum_due_cards: 2,
      },
    )
  },
)

test(
  'retrieves VAPID public key',
  async () => {
    const key =
      await getPushPublicKey(
        async () =>
          new Response(
            JSON.stringify({
              public_key:
                'A'.repeat(87),
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

    assert.equal(
      key,
      'A'.repeat(87),
    )
  },
)

test(
  'registers and removes browser push subscription',
  async () => {
    const paths: string[] = []

    const saved =
      await savePushSubscription(
        {
          endpoint:
            'https://push.example/subscription',
          p256dh: 'p'.repeat(32),
          auth: 'auth-token',
        },
        async (
          path,
          init,
        ) => {
          paths.push(
            `${init?.method ?? 'GET'} ${path}`,
          )
          return new Response(
            JSON.stringify({
              endpoint_hash:
                'b'.repeat(64),
            }),
            {
              status: 201,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
      )

    assert.equal(
      saved.endpoint_hash,
      'b'.repeat(64),
    )

    await deletePushSubscription(
      'b'.repeat(64),
      async (
        path,
        init,
      ) => {
        paths.push(
          `${init?.method ?? 'GET'} ${path}`,
        )
        return new Response(
          null,
          {
            status: 204,
          },
        )
      },
    )

    assert.deepEqual(
      paths,
      [
        'POST /api/study-notifications/push/subscriptions',
        'DELETE /api/study-notifications/push/subscriptions/'
          + 'b'.repeat(64),
      ],
    )
  },
)
