import type {
  PushPublicKey,
  PushSubscriptionCreate,
  PushSubscriptionRegistration,
  StudyNotificationPreferences,
  StudyNotificationPreferencesUpdate,
} from '../types/api.generated'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

async function requestJson<T>(
  path: string,
  fetcher: ApiFetch,
  init: RequestInit = {},
  fallback: string,
): Promise<T> {
  const response =
    await fetcher(path, init)

  let data: unknown = null

  try {
    data = await response.json()
  } catch {
    // Empty error responses use the bounded fallback below.
  }

  if (!response.ok) {
    const detail =
      data &&
      typeof data === 'object' &&
      'detail' in data &&
      typeof data.detail === 'string'
        ? data.detail
        : fallback

    throw new Error(detail)
  }

  return data as T
}

export async function getStudyNotificationPreferences(
  fetcher: ApiFetch,
): Promise<StudyNotificationPreferences> {
  return requestJson(
    '/api/study-notifications/preferences',
    fetcher,
    {},
    'Could not load study notification settings.',
  )
}

export async function saveStudyNotificationPreferences(
  payload: StudyNotificationPreferencesUpdate,
  fetcher: ApiFetch,
): Promise<StudyNotificationPreferences> {
  return requestJson(
    '/api/study-notifications/preferences',
    fetcher,
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not save study notification settings.',
  )
}

export async function getPushPublicKey(
  fetcher: ApiFetch,
): Promise<string> {
  const result =
    await requestJson<PushPublicKey>(
      '/api/study-notifications/push/public-key',
      fetcher,
      {},
      'Browser push notifications are not available.',
    )

  return result.public_key
}

export async function savePushSubscription(
  payload: PushSubscriptionCreate,
  fetcher: ApiFetch,
): Promise<PushSubscriptionRegistration> {
  return requestJson(
    '/api/study-notifications/push/subscriptions',
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not register this browser for notifications.',
  )
}

export async function deletePushSubscription(
  endpointHash: string,
  fetcher: ApiFetch,
): Promise<void> {
  const response =
    await fetcher(
      '/api/study-notifications/push/subscriptions/'
        + encodeURIComponent(endpointHash),
      {
        method: 'DELETE',
      },
    )

  if (!response.ok) {
    let detail =
      'Could not remove this browser notification subscription.'

    try {
      const data =
        await response.json()
      if (
        data &&
        typeof data === 'object' &&
        'detail' in data &&
        typeof data.detail ===
          'string'
      ) {
        detail = data.detail
      }
    } catch {
      // Keep bounded fallback.
    }

    throw new Error(detail)
  }
}

function base64Url(
  bytes: ArrayBuffer,
) {
  let binary = ''

  for (
    const byte
    of new Uint8Array(bytes)
  ) {
    binary +=
      String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function applicationServerKey(
  value: string,
) {
  const padding =
    '='.repeat(
      (4 - (value.length % 4)) %
        4,
    )
  const raw = (
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      + padding
  )
  const binary = atob(raw)
  const result =
    new Uint8Array(binary.length)

  for (
    let index = 0;
    index < binary.length;
    index += 1
  ) {
    result[index] =
      binary.charCodeAt(index)
  }

  return result
}

export function browserPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

async function serviceWorkerRegistration() {
  if (!browserPushSupported()) {
    throw new Error(
      'This browser does not support Web Push notifications.',
    )
  }

  await navigator.serviceWorker.register(
    '/study-notifications-sw.js',
    {
      scope: '/',
    },
  )

  return navigator.serviceWorker.ready
}

export async function endpointHash(
  endpoint: string,
) {
  const encoded =
    new TextEncoder().encode(endpoint)
  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      encoded,
    )

  return Array.from(
    new Uint8Array(digest),
    (byte) =>
      byte
        .toString(16)
        .padStart(2, '0'),
  ).join('')
}

function subscriptionPayload(
  subscription: PushSubscription,
): PushSubscriptionCreate {
  const p256dh =
    subscription.getKey('p256dh')
  const auth =
    subscription.getKey('auth')

  if (!p256dh || !auth) {
    throw new Error(
      'The browser returned an incomplete push subscription.',
    )
  }

  return {
    endpoint:
      subscription.endpoint,
    p256dh: base64Url(p256dh),
    auth: base64Url(auth),
  }
}

export async function currentBrowserPushSubscription() {
  if (!browserPushSupported()) {
    return null
  }

  const registration =
    await serviceWorkerRegistration()

  return registration.pushManager
    .getSubscription()
}

export async function enableBrowserPush(
  fetcher: ApiFetch,
) {
  if (!browserPushSupported()) {
    throw new Error(
      'This browser does not support Web Push notifications.',
    )
  }

  let permission =
    Notification.permission

  if (permission === 'default') {
    permission =
      await Notification.requestPermission()
  }

  if (permission !== 'granted') {
    throw new Error(
      'Browser notification permission was not granted.',
    )
  }

  const registration =
    await serviceWorkerRegistration()
  let subscription =
    await registration.pushManager
      .getSubscription()

  if (!subscription) {
    const publicKey =
      await getPushPublicKey(
        fetcher,
      )

    subscription =
      await registration.pushManager.subscribe(
        {
          userVisibleOnly: true,
          applicationServerKey:
            applicationServerKey(
              publicKey,
            ),
        },
      )
  }

  const saved =
    await savePushSubscription(
      subscriptionPayload(
        subscription,
      ),
      fetcher,
    )

  return {
    endpointHash:
      saved.endpoint_hash,
    permission,
  }
}

export async function disableBrowserPush(
  fetcher: ApiFetch,
) {
  const subscription =
    await currentBrowserPushSubscription()

  if (!subscription) {
    return false
  }

  const hash =
    await endpointHash(
      subscription.endpoint,
    )

  await deletePushSubscription(
    hash,
    fetcher,
  )

  await subscription.unsubscribe()

  return true
}

export function detectedTimezone() {
  try {
    return (
      Intl.DateTimeFormat()
        .resolvedOptions()
        .timeZone ||
      'UTC'
    )
  } catch {
    return 'UTC'
  }
}
