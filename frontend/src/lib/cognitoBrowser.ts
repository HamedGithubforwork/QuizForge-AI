import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts'
import { cognitoConfiguration } from './authConfig'
import type { AuthSession } from './authSession'
import { CognitoPasswordSession } from './cognitoPasswordSession'

export const config = cognitoConfiguration(import.meta.env, window.location.origin)
export const passwordSession = new CognitoPasswordSession(config.client, config.pool)

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
const resetManager = createManager(config.domain + '/forgotPassword')

export async function resetPassword() {
  await manager.clearStaleState()
  await resetManager.signinRedirect({ nonce: crypto.randomUUID() })
}

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

export async function signInWithGoogle() {
  if (!config.googleSignInEnabled) throw new Error('Google sign-in is not available yet.')
  await manager.clearStaleState()
  // Preserve the same Cognito authorization-code + PKCE flow; select the
  // Google identity provider at the Cognito authorize endpoint.
  await manager.signinRedirect({
    nonce: crypto.randomUUID(),
    extraQueryParams: { identity_provider: 'Google' },
  })
}

export async function signUp() {
  await manager.clearStaleState()
  await signupManager.signinRedirect({ nonce: crypto.randomUUID() })
}

export async function session(refresh = false): Promise<AuthSession | null> {
  if (passwordSession.active) {
    const current = await passwordSession.session(refresh)
    if (!current) await manager.removeUser()
    return current
  }
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
  try { await passwordSession.signOut() } catch { failed = true }
  try { await manager.revokeTokens(['refresh_token']) } catch { failed = true }
  await manager.removeUser()
  await manager.clearStaleState()
  if (failed) throw new Error('Local sign-out completed, but session revocation failed. Close this tab and sign out of Cognito.')
  const url = new URL('/logout', config.domain)
  url.searchParams.set('client_id', config.client)
  url.searchParams.set('logout_uri', config.logout)
  window.location.assign(url.href)
}

export async function identityRequest(path: string, body?: object, legacyToken?: string, cognitoLinkToken?: string) {
  const current = await session()
  if (!current) throw new Error('Sign in again to continue.')
  const headers = new Headers({ Authorization: `Bearer ${current.accessToken}` })
  if (body) headers.set('Content-Type', 'application/json')
  if (legacyToken && cognitoLinkToken) throw new Error('Choose one existing-account authentication method.')
  if (legacyToken) headers.set('X-Legacy-Authorization', `Bearer ${legacyToken}`)
  if (cognitoLinkToken) headers.set('X-Cognito-Link-Authorization', `Bearer ${cognitoLinkToken}`)
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
    await passwordSession.signOut().catch(() => undefined)
    await manager.removeUser()
    throw new Error('Account identity could not be verified. Please sign in again.')
  }
  return result
}
