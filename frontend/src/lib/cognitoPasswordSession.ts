import { cognitoRequest, CognitoRequestError } from './cognitoRequest.ts'
import { parseCognitoProof, type CognitoAccountProof, type CognitoMfaMethod } from './cognitoAccountProof.ts'
import { normalizedVerificationEmail } from './cognitoSignupRecovery.ts'

type Session = { accessToken: string; userId: string; email: string }
type StoredSession = Session & { refreshToken: string; expiresAt: number }
export type PasswordStep = Exclude<CognitoAccountProof, { kind: 'ready' }> |
  { kind: 'confirm-email'; email: string } | { kind: 'ready' }

/** Password sessions are memory-only and separate from Google/OIDC sessions.
 * Cognito GetUser verifies identity; the API independently verifies JWTs and enrollment.
 */
export class CognitoPasswordSession {
  private client: string
  private pool: string
  private value: StoredSession | null = null
  private generation = 0
  private refreshing: Promise<Session | null> | undefined
  constructor(client: string, pool: string) { this.client = client; this.pool = pool }
  get active() { return this.value !== null }
  cancel() { this.generation++ }

  async begin(email: string, password: string): Promise<PasswordStep> {
    const username = normalizedVerificationEmail(email)
    if (!password || password.length > 256) throw new Error('Enter your password.')
    const generation = ++this.generation
    try {
      const result = await cognitoRequest('InitiateAuth', { ClientId: this.client, AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password } })
      return await this.finish(result, username, generation)
    } catch (error) {
      if (generation !== this.generation) throw new Error('Sign-in was cancelled. Please start again.')
      if (error instanceof CognitoRequestError && error.code === 'UserNotConfirmedException') {
        return { kind: 'confirm-email', email: username }
      }
      if (error instanceof CognitoRequestError && error.code === 'PasswordResetRequiredException') {
        throw new Error('Reset your password using Forgot your password, then sign in again.')
      }
      throw error
    }
  }

  async respond(step: Extract<PasswordStep, {kind: 'mfa' | 'select-mfa'}>, answer: string): Promise<PasswordStep> {
    if (step.kind === 'select-mfa' ? !step.methods.includes(answer as CognitoMfaMethod) : !/^[0-9]{6,8}$/.test(answer)) {
      throw new Error('Enter a valid verification code or choose an available method.')
    }
    const generation = this.generation
    const key = step.kind === 'select-mfa' ? 'ANSWER' : step.challenge === 'SOFTWARE_TOKEN_MFA'
      ? 'SOFTWARE_TOKEN_MFA_CODE' : step.challenge === 'SMS_MFA' ? 'SMS_MFA_CODE' : 'EMAIL_OTP_CODE'
    const reply = await cognitoRequest('RespondToAuthChallenge', {
      ClientId: this.client, ChallengeName: step.kind === 'select-mfa' ? 'SELECT_MFA_TYPE' : step.challenge,
      Session: step.session, ChallengeResponses: { USERNAME: step.username, [key]: answer },
    })
    if (step.kind === 'select-mfa') {
      const next = parseCognitoProof(reply, step.username)
      if (next.kind !== 'mfa' || next.challenge !== answer) {
        await this.revokeReply(reply)
        throw new Error('The selected verification method did not start.')
      }
    }
    return this.finish(reply, step.username, generation)
  }

  private async verified(reply: Record<string, unknown>, previous?: StoredSession): Promise<StoredSession> {
    const raw = reply.AuthenticationResult
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Sign-in did not complete.')
    const result = raw as Record<string, unknown>
    const accessToken = result.AccessToken
    const refreshToken = result.RefreshToken ?? previous?.refreshToken
    const seconds = result.ExpiresIn
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16_384 ||
        typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 16_384 ||
        typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
      throw new Error('Sign-in returned an invalid session.')
    }
    const startedAt = Date.now()
    const user = await cognitoRequest('GetUser', { AccessToken: accessToken })
    if (!Array.isArray(user.UserAttributes)) throw new Error('Account identity could not be verified.')
    const attributes = new Map<string, string>()
    for (const item of user.UserAttributes) {
      if (!item || typeof item.Name !== 'string' || typeof item.Value !== 'string' || attributes.has(item.Name)) {
        throw new Error('Account identity could not be verified.')
      }
      attributes.set(item.Name, item.Value)
    }
    const sub = attributes.get('sub') || ''
    const email = attributes.get('email') || ''
    const userId = `cognito:${this.pool}:${sub}`
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sub) ||
        !email || attributes.get('email_verified') !== 'true' || (previous && previous.userId !== userId)) {
      throw new Error('Account identity could not be verified.')
    }
    return { accessToken, refreshToken, userId, email, expiresAt: startedAt + seconds * 1000 }
  }

  private async finish(reply: Record<string, unknown>, username: string, generation: number): Promise<PasswordStep> {
    if (generation !== this.generation) {
      await this.revokeReply(reply)
      throw new Error('Sign-in was cancelled. Please start again.')
    }
    // Keep challenge validation shared with existing-account linking.
    const parsed = parseCognitoProof(reply, username)
    if (parsed.kind !== 'ready') return parsed
    let next: StoredSession
    try { next = await this.verified(reply) }
    catch (error) { await this.revokeReply(reply); throw error }
    if (generation !== this.generation) {
      await this.revokeReply(reply)
      throw new Error('Sign-in was cancelled. Please start again.')
    }
    this.value = next
    return { kind: 'ready' }
  }

  private async revokeReply(reply: Record<string, unknown>) {
    const token = (reply.AuthenticationResult as Record<string, unknown> | undefined)?.RefreshToken
    if (typeof token === 'string' && token) {
      await cognitoRequest('RevokeToken', { ClientId: this.client, Token: token }).catch(() => undefined)
    }
  }

  async session(refresh = false): Promise<Session | null> {
    const current = this.value
    if (!current) return null
    if (refresh || current.expiresAt <= Date.now()) {
      if (!this.refreshing) {
        const generation = this.generation
        this.refreshing = (async () => {
          try {
            const reply = await cognitoRequest('InitiateAuth', { ClientId: this.client, AuthFlow: 'REFRESH_TOKEN_AUTH',
              AuthParameters: { REFRESH_TOKEN: current.refreshToken } })
            const next = await this.verified(reply, current)
            if (generation !== this.generation) return null
            this.value = next
            return this.publicSession(next)
          } catch {
            if (generation === this.generation) this.value = null
            return null
          }
        })().finally(() => { this.refreshing = undefined })
      }
      return this.refreshing
    }
    return this.publicSession(current)
  }
  private publicSession(value: StoredSession): Session {
    return { accessToken: value.accessToken, userId: value.userId, email: value.email }
  }
  async signOut() {
    const current = this.value
    this.value = null
    this.generation++
    if (current) await cognitoRequest('RevokeToken', { ClientId: this.client, Token: current.refreshToken })
  }
}
