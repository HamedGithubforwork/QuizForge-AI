/** A short-lived, non-persistent proof of an existing Cognito password account.
 * The active Google/OIDC session is not replaced by this direct Cognito flow.
 */
export type CognitoAccountProof =
  | { kind: 'ready'; accessToken: string }
  | { kind: 'mfa'; challenge: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA' | 'EMAIL_OTP'; session: string; username: string }

const endpoint = 'https://cognito-idp.ca-central-1.amazonaws.com/'

type CognitoReply = Record<string, unknown>

async function cognitoRequest(operation: string, body: Record<string, unknown>): Promise<CognitoReply> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + operation },
    body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('Existing-account verification failed. Check your credentials and try again.')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cognito returned an invalid account-verification response.')
  }
  return value as CognitoReply
}

function parseProof(response: CognitoReply, username: string): CognitoAccountProof {
  const result = response.AuthenticationResult
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const token = (result as Record<string, unknown>).AccessToken
    if (typeof token === 'string' && token.length > 0 && token.length <= 16_384) {
      return { kind: 'ready', accessToken: token }
    }
  }

  const challenge = response.ChallengeName
  if (challenge === 'MFA_SETUP') {
    throw new Error('Finish your existing account’s first-time security setup, then return to link Google.')
  }
  if (challenge === 'SOFTWARE_TOKEN_MFA' || challenge === 'SMS_MFA' || challenge === 'EMAIL_OTP') {
    const session = response.Session
    const params = response.ChallengeParameters
    const cognitoUsername = params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).USERNAME : undefined
    if (typeof session !== 'string' || !session || session.length > 8192) {
      throw new Error('Cognito did not return a valid verification challenge.')
    }
    return { kind: 'mfa', challenge, session,
      username: typeof cognitoUsername === 'string' && cognitoUsername ? cognitoUsername : username }
  }
  throw new Error('This existing-account sign-in challenge is not supported for linking.')
}

export async function beginCognitoAccountProof(clientId: string, email: string, password: string): Promise<CognitoAccountProof> {
  const username = email.trim().toLowerCase()
  if (!username || !username.includes('@') || !password) {
    throw new Error('Enter the email and password of your existing account.')
  }
  const response = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  })
  return parseProof(response, username)
}

export async function finishCognitoAccountProof(clientId: string, proof: Extract<CognitoAccountProof, {kind: 'mfa'}>,
                                                code: string): Promise<Extract<CognitoAccountProof, {kind: 'ready'}>> {
  if (!/^[0-9]{6,8}$/.test(code)) throw new Error('Enter the verification code for your existing account.')
  const key = proof.challenge === 'SOFTWARE_TOKEN_MFA' ? 'SOFTWARE_TOKEN_MFA_CODE'
    : proof.challenge === 'SMS_MFA' ? 'SMS_MFA_CODE' : 'EMAIL_OTP_CODE'
  const response = await cognitoRequest('RespondToAuthChallenge', {
    ClientId: clientId, ChallengeName: proof.challenge, Session: proof.session,
    ChallengeResponses: { USERNAME: proof.username, [key]: code },
  })
  const result = parseProof(response, proof.username)
  if (result.kind !== 'ready') throw new Error('Existing-account verification did not complete.')
  return result
}
