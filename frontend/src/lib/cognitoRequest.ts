/** Public-client Cognito transport. Provider diagnostics never reach the UI. */
export class CognitoRequestError extends Error {
  code: string
  constructor(code: string) {
    super(code === 'CodeMismatchException' || code === 'ExpiredCodeException'
      ? 'That verification code was not accepted or has expired. Try a current code.'
      : code === 'TooManyRequestsException' || code === 'LimitExceededException'
        ? 'Too many attempts. Wait a few minutes before trying again.'
        : 'Sign-in failed. Check your email and password, or try again later.')
    this.code = code
  }
}

export async function cognitoRequest(operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch('https://cognito-idp.ca-central-1.amazonaws.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + operation },
      body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw new Error('Could not contact sign-in. Please try again later.') }
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).__type : ''
    throw new CognitoRequestError(typeof raw === 'string' && raw.length < 150 ? raw.split('#').pop()! : '')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sign-in returned an invalid response.')
  return value as Record<string, unknown>
}
