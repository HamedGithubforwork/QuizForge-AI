/**
 * Stable, non-sensitive sign-in diagnostics. Never expose OAuth callback URLs,
 * state, authorization codes, identity response bodies, or error messages.
 */
export class IdentitySessionHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super('Identity session request failed.')
    this.name = 'IdentitySessionHttpError'
    this.status = status
  }
}

export type AuthStartupStage = 'callback' | 'session' | 'identity'

export function authStartupFailure(stage: AuthStartupStage, caught: unknown): string {
  if (stage === 'callback') {
    const kind = caught && typeof caught === 'object' && 'error' in caught
      ? (caught as { error?: unknown }).error : undefined
    if (kind === 'access_denied') {
      return 'Google sign-in was cancelled or declined (QF-OAUTH-CANCEL). Please start again.'
    }
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
