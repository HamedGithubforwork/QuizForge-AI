import type {
  StudyNotificationPreferences,
  StudyNotificationPreferencesUpdate,
  VapidPublicKeyResponse,
  WebPushSubscriptionCreate,
  WebPushSubscriptionSummary,
} from '../types/api.generated'

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

async function requestJson<T>(
  path: string,
  fetcher: ApiFetch,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  const response =
    await fetcher(path, init)

  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // Empty failures use the safe fallback below.
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
    'Could not load study reminder settings.',
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
    'Could not save study reminder settings.',
  )
}

export async function getVapidPublicKey(
  fetcher: ApiFetch,
): Promise<string> {
  const result =
    await requestJson<VapidPublicKeyResponse>(
      '/api/study-notifications/vapid-public-key',
      fetcher,
      {},
      'Browser notifications are not configured.',
    )
  return result.public_key
}

export async function listPushSubscriptions(
  fetcher: ApiFetch,
): Promise<WebPushSubscriptionSummary[]> {
  return requestJson(
    '/api/study-notifications/subscriptions',
    fetcher,
    {},
    'Could not load browser notification devices.',
  )
}

export async function savePushSubscription(
  payload: WebPushSubscriptionCreate,
  fetcher: ApiFetch,
): Promise<WebPushSubscriptionSummary> {
  return requestJson(
    '/api/study-notifications/subscriptions',
    fetcher,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify(payload),
    },
    'Could not enable browser notifications on this device.',
  )
}

export async function deletePushSubscription(
  subscriptionId: string,
  fetcher: ApiFetch,
): Promise<void> {
  const response = await fetcher(
    `/api/study-notifications/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'DELETE',
    },
  )
  if (!response.ok) {
    let detail =
      'Could not remove browser notifications from this device.'
    try {
      const body =
        await response.json()
      if (
        body &&
        typeof body === 'object' &&
        'detail' in body &&
        typeof body.detail ===
          'string'
      ) {
        detail = body.detail
      }
    } catch {
      // Use safe fallback.
    }
    throw new Error(detail)
  }
}

function bytesToBase64Url(
  bytes: Uint8Array,
): string {
  let raw = ''
  for (const byte of bytes) {
    raw += String.fromCharCode(byte)
  }
  return btoa(raw)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function base64UrlToBytes(
  value: string,
): Uint8Array {
  const padded =
    value.replace(/-/g, '+')
      .replace(/_/g, '/') +
    '='.repeat(
      (4 - (value.length % 4)) % 4,
    )
  const raw = atob(padded)
  return Uint8Array.from(
    raw,
    (character) =>
      character.charCodeAt(0),
  )
}

export function subscriptionPayload(
  subscription: Pick<
    PushSubscription,
    'endpoint' | 'getKey'
  >,
): WebPushSubscriptionCreate {
  const p256dh =
    subscription.getKey('p256dh')
  const auth =
    subscription.getKey('auth')

  if (!p256dh || !auth) {
    throw new Error(
      'This browser did not provide Web Push encryption keys.',
    )
  }

  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: bytesToBase64Url(
        new Uint8Array(p256dh),
      ),
      auth: bytesToBase64Url(
        new Uint8Array(auth),
      ),
    },
  }
}

export async function sha256Hex(
  value: string,
): Promise<string> {
  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    )
  return Array.from(
    new Uint8Array(digest),
    (byte) =>
      byte
        .toString(16)
        .padStart(2, '0'),
  ).join('')
}

export function browserTimezone() {
  return (
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone ||
    'America/Toronto'
  )
}

export function supportsWebPush() {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

async function serviceWorkerRegistration() {
  if (!supportsWebPush()) {
    throw new Error(
      'Browser notifications are not supported on this device.',
    )
  }

  return navigator.serviceWorker.register(
    '/study-notifications-sw.js',
    {
      scope: '/',
    },
  )
}

export async function currentDeviceSubscription(
  fetcher: ApiFetch,
) {
  if (!supportsWebPush()) {
    return {
      supported: false,
      permission: 'unsupported',
      subscription: null,
      serverSubscription: null,
    } as const
  }

  const registration =
    await navigator.serviceWorker.getRegistration(
      '/',
    )
  const subscription =
    registration
      ? await registration.pushManager.getSubscription()
      : null

  if (!subscription) {
    return {
      supported: true,
      permission: Notification.permission,
      subscription: null,
      serverSubscription: null,
    } as const
  }

  const endpointSha256 =
    await sha256Hex(
      subscription.endpoint,
    )
  const server =
    await listPushSubscriptions(
      fetcher,
    )

  return {
    supported: true,
    permission: Notification.permission,
    subscription,
    serverSubscription:
      server.find(
        (item) =>
          item.endpoint_sha256 ===
          endpointSha256,
      ) ?? null,
  } as const
}

export async function enablePushOnCurrentDevice(
  fetcher: ApiFetch,
) {
  if (!supportsWebPush()) {
    throw new Error(
      'Browser notifications are not supported on this device.',
    )
  }

  const permission =
    Notification.permission ===
    'default'
      ? await Notification.requestPermission()
      : Notification.permission

  if (permission !== 'granted') {
    throw new Error(
      'Browser notification permission was not granted.',
    )
  }

  const registration =
    await serviceWorkerRegistration()
  let subscription =
    await registration.pushManager.getSubscription()

  if (!subscription) {
    const publicKey =
      await getVapidPublicKey(
        fetcher,
      )
    subscription =
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey:
          base64UrlToBytes(
            publicKey,
          ),
      })
  }

  return savePushSubscription(
    subscriptionPayload(
      subscription,
    ),
    fetcher,
  )
}

export async function disablePushOnCurrentDevice(
  fetcher: ApiFetch,
) {
  if (!supportsWebPush()) {
    return
  }

  const registration =
    await navigator.serviceWorker.getRegistration(
      '/',
    )
  const subscription =
    registration
      ? await registration.pushManager.getSubscription()
      : null

  if (!subscription) {
    return
  }

  const endpointSha256 =
    await sha256Hex(
      subscription.endpoint,
    )
  const server =
    await listPushSubscriptions(
      fetcher,
    )
  const matching =
    server.find(
      (item) =>
        item.endpoint_sha256 ===
        endpointSha256,
    )

  if (matching) {
    await deletePushSubscription(
      matching.id,
      fetcher,
    )
  }

  await subscription.unsubscribe()
}
