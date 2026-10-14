/** Stable, non-sensitive sign-in diagnostics.
 * Never expose OAuth URLs, state, authorization codes, identity response bodies, or error text.
 */
export class IdentitySessionHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Identity session request failed.')
    this.name = 'IdentitySessionHttpError'
    this.status = status
  }
}

export type CallbackFailurePhase =
  'provider' | 'transaction' | 'nonce' | 'code' | 'token' | 'network' | 'unknown'

export class OAuthCallbackDiagnostic extends Error {
  readonly phase: CallbackFailurePhase
  readonly protocolError: string
  constructor(phase: CallbackFailurePhase, protocolError = '') {
    super('OAuth callback could not be verified.')
    this.name = 'OAuthCallbackDiagnostic'
    this.phase = phase
    // An allowlisted standard OAuth error identifier only; never provider descriptions.
    this.protocolError = protocolError
  }
}

const permittedOAuthErrors = new Set([
  'access_denied', 'invalid_request', 'invalid_grant', 'invalid_client',
  'unauthorized_client', 'invalid_scope', 'server_error', 'temporarily_unavailable',
  'login_required', 'interaction_required', 'consent_required',
])

function oauthErrorCode(value: unknown): string {
  return typeof value === 'string' && permittedOAuthErrors.has(value) ? value : ''
}

/** Call only after the OIDC library has rejected its ordinary validated callback.
 * Inspect only static field names, known library error signatures and allowlisted
 * OAuth error identifiers. Never inspect or store OAuth code/state/description values.
 */
export function classifyOidcCallbackFailure(callbackUrl: string, caught: unknown): OAuthCallbackDiagnostic {
  const query = new URL(callbackUrl).searchParams
  if (query.has('error')) {
    return new OAuthCallbackDiagnostic('provider', oauthErrorCode(query.get('error')))
  }
  const message = caught instanceof Error ? caught.message : ''
  if (message === 'No state in response' || message === 'No matching state found in storage' ||
      message === 'State does not match' || message === 'authority mismatch on settings vs. signin state' ||
      message === 'client_id mismatch on settings vs. signin state') {
    return new OAuthCallbackDiagnostic('transaction')
  }
  if (message === 'nonce in id_token does not match nonce in client storage') {
    return new OAuthCallbackDiagnostic('nonce')
  }
  if (message === 'Expected code in response') return new OAuthCallbackDiagnostic('code')
  if (query.has('code')) {
    const error = caught && typeof caught === 'object' && 'error' in caught
      ? (caught as { error?: unknown }).error : undefined
    const protocolError = oauthErrorCode(error)
    if (protocolError) return new OAuthCallbackDiagnostic('token', protocolError)
    if (caught instanceof TypeError || (caught instanceof Error && caught.name === 'ErrorTimeout')) {
      return new OAuthCallbackDiagnostic('network')
    }
    return new OAuthCallbackDiagnostic('token')
  }
  return new OAuthCallbackDiagnostic('unknown')
}

export type AuthStartupStage = 'callback' | 'session' | 'identity'

export function authStartupFailure(stage: AuthStartupStage, caught: unknown): string {
  if (stage === 'callback') {
    if (caught instanceof OAuthCallbackDiagnostic) {
      if (caught.phase === 'provider') {
        if (caught.protocolError === 'access_denied') {
          return 'Google sign-in was cancelled or declined (QF-OAUTH-CANCEL). Please start again.'
        }
        if (caught.protocolError === 'invalid_request') {
          return 'Cognito rejected the Google sign-in request (QF-OAUTH-PROVIDER-REQUEST). Please try again.'
        }
        if (caught.protocolError === 'server_error' || caught.protocolError === 'temporarily_unavailable') {
          return 'Google sign-in provider returned an error (QF-OAUTH-PROVIDER-SERVER). Please try again.'
        }
        return 'The Google sign-in provider returned an error (QF-OAUTH-PROVIDER-OTHER). Please try again.'
      }
      if (caught.phase === 'transaction') {
        return 'The Google sign-in transaction could not be matched (QF-OAUTH-STATE). Please sign out and retry in the same tab.'
      }
      if (caught.phase === 'nonce') {
        return 'The Google sign-in identity check failed (QF-OAUTH-NONCE). Please start again.'
      }
      if (caught.phase === 'code') {
        return 'Google sign-in did not return an authorization code (QF-OAUTH-NO-CODE). Please start again.'
      }
      if (caught.phase === 'network') {
        return 'The Google token exchange could not connect (QF-OAUTH-NETWORK). Please try again.'
      }
      if (caught.phase === 'token') {
        if (caught.protocolError === 'invalid_grant') {
          return 'Cognito rejected the authorization code (QF-OAUTH-TOKEN-GRANT). Please start again.'
        }
        if (caught.protocolError) {
          return 'Cognito rejected the token exchange (QF-OAUTH-TOKEN-REJECTED). Please try again.'
        }
        return 'The Google token exchange or validation failed (QF-OAUTH-TOKEN). Please start again.'
      }
    }
    // Historical callers and unexpected preprocessing failures remain fail-closed.
    return 'Google sign-in could not be completed (QF-OAUTH-CALLBACK). Please start again.'
  }
  if (stage === 'session') {
    return 'The sign-in session could not be loaded (QF-SESSION). Sign out and start again.'
  }
  if (caught instanceof IdentitySessionHttpError) {
    const allowed = [400, 401, 403, 404, 409, 429, 500, 502, 503, 504]
    const code = allowed.includes(caught.status) ? String(caught.status) : 'OTHER'
    return `Sign-in returned, but account verification failed (QF-IDENTITY-${code}). Sign out and start again.`
  }
  return 'Sign-in returned, but account verification could not connect (QF-IDENTITY-NET). Please try again.'
}
