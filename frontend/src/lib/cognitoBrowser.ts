import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts'
import { cognitoConfiguration } from './authConfig'
import type { AuthSession } from './authSession'

export const config = cognitoConfiguration(import.meta.env, window.location.origin)

function createManager(authorizationEndpoint: string) {
  return new UserManager({
    authority: config.authority, client_id: config.client, redirect_uri: config.redirect,
    response_type: 'code', scope: 'openid email aws.cognito.signin.user.admin',
    automaticSilentRenew: false, monitorSession: false, loadUserInfo: false,
    staleStateAgeInSeconds: 600, requestTimeoutInSeconds: 10,
    // Only the short-lived PKCE transaction survives a redirect. Tokens stay in memory.
    stateStore: new WebStorageStateStore({ store: window.sessionStorage, prefix: 'quizforge.cognito.state.' }),
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    metadata: {
      issuer: config.authority, authorization_endpoint: authorizationEndpoint,
      token_endpoint: config.domain + '/oauth2/token', revocation_endpoint: config.domain + '/oauth2/revoke',
    },
  })
}

export const manager = createManager(config.domain + '/oauth2/authorize')
const signupManager = createManager(config.domain + '/signup')

let initializing: Promise<void> | undefined
let refreshing: ReturnType<typeof manager.signinSilent> | undefined

export function initialize() {
  initializing ??= (async () => {
    if (window.location.pathname === '/auth/callback') {
      const callback = window.location.href
      // Remove authorization codes/errors before network requests or rendering.
      window.history.replaceState({}, '', '/')
      await manager.clearStaleState()
      try { await manager.signinRedirectCallback(callback) }
      catch { await manager.removeUser(); throw new Error('Sign-in could not be verified. Please start again.') }
    }
    await manager.clearStaleState()
  })()
  return initializing
}

export async function signIn() {
  await manager.clearStaleState()
  await manager.signinRedirect({ nonce: crypto.randomUUID() })
}

export async function signUp() {
  await manager.clearStaleState()
  await signupManager.signinRedirect({ nonce: crypto.randomUUID() })
}

export async function session(refresh = false): Promise<AuthSession | null> {
  let user = await manager.getUser()
  if (user && (refresh || user.expired)) {
    refreshing ??= manager.signinSilent().finally(() => { refreshing = undefined })
    try { user = await refreshing }
    catch { await manager.removeUser(); return null }
  }
  return user ? { accessToken: user.access_token, userId: `cognito:${config.pool}:${user.profile.sub}`,
    email: typeof user.profile.email === 'string' ? user.profile.email : '' } : null
}

export async function signOut() {
  let failed = false
  try { await manager.revokeTokens(['refresh_token']) } catch { failed = true }
  await manager.removeUser()
  await manager.clearStaleState()
  if (failed) throw new Error('Local sign-out completed, but session revocation failed. Close this tab and sign out of Cognito.')
  const url = new URL('/logout', config.domain)
  url.searchParams.set('client_id', config.client)
  url.searchParams.set('logout_uri', config.logout)
  window.location.assign(url.href)
}

export async function identityRequest(path: string, body?: object, legacyToken?: string) {
  const current = await session()
  if (!current) throw new Error('Sign in again to continue.')
  const headers = new Headers({ Authorization: `Bearer ${current.accessToken}` })
  if (body) headers.set('Content-Type', 'application/json')
  if (legacyToken) headers.set('X-Legacy-Authorization', `Bearer ${legacyToken}`)
  const response = await fetch(config.identityApi + path, { method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    throw new Error(typeof value.detail === 'string' ? value.detail : 'Account enrollment could not be completed.')
  }
  if (response.status === 204) return null
  const result = await response.json()
  if (path === '/identity/session' && (result.id !== current.userId || typeof result.email !== 'string'
      || typeof result.enrolled !== 'boolean')) {
    await manager.removeUser()
    throw new Error('Account identity could not be verified. Please sign in again.')
  }
  return result
}
