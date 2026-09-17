import { authSession } from './authSession'
import {
  rememberCurrentDocumentIdentity,
} from './documentIdentity'
import {
  prepareQuizGenerationRequest,
} from './quizGenerationPolicy'

const configuredApiUrl =
  import.meta.env.VITE_API_URL?.trim()

export const API_URL = (
  configuredApiUrl ||
  'http://127.0.0.1:8000'
).replace(/\/+$/, '')

async function getAccessToken() {
  const session = await authSession()
  if (!session) {
    throw new Error(
      'Your session has expired. Please sign in again.',
    )
  }

  return session.accessToken
}

async function sendAuthenticatedRequest(
  path: string,
  init: RequestInit,
  accessToken: string,
) {
  const headers =
    new Headers(init.headers)

  headers.set(
    'Authorization',
    `Bearer ${accessToken}`,
  )

  return fetch(
    `${API_URL}${path}`,
    {
      ...init,
      headers,
    },
  )
}

async function captureDocumentIdentity(
  path: string,
  response: Response,
) {
  if (
    path !== '/api/documents/upload' ||
    !response.ok
  ) {
    return
  }

  try {
    rememberCurrentDocumentIdentity(
      await response.clone().json(),
    )
  } catch {
    // The upload response remains usable even if identity metadata
    // is missing or malformed.
  }
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
) {
  const accessToken =
    await getAccessToken()

  const preparedInit =
    prepareQuizGenerationRequest(
      path,
      init,
    )

  let response =
    await sendAuthenticatedRequest(
      path,
      preparedInit,
      accessToken,
    )

  if (response.status !== 401) {
    await captureDocumentIdentity(
      path,
      response,
    )
    return response
  }

  const session = await authSession(true).catch(() => null)
  if (!session) {
    return response
  }

  response =
    await sendAuthenticatedRequest(
      path,
      preparedInit,
      session.accessToken,
    )

  await captureDocumentIdentity(
    path,
    response,
  )

  return response
}
