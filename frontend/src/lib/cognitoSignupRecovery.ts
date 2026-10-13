/** Recover Cognito signup verification without an authenticated session.
 * A code from the original signup email works; resending is optional.
 * Calls the regional Cognito Identity Provider only, not the QuizForge API.
 */
const endpoint = 'https://cognito-idp.ca-central-1.amazonaws.com/'

type VerificationOperation = 'ResendConfirmationCode' | 'ConfirmSignUp' | 'SignUp'

/** A duplicate signup may be confirmed or unconfirmed. Never assume either. */
export class ExistingCognitoAccountError extends Error {
  constructor() {
    super('An account may already exist. You can enter an earlier verification code or sign in.')
    this.name = 'ExistingCognitoAccountError'
  }
}

export function passwordRequirements(value: string) {
  return {
    lowercase: /[a-z]/.test(value),
    uppercase: /[A-Z]/.test(value),
    number: /[0-9]/.test(value),
    length: value.length >= 8,
    symbol: value.includes(' ') || /[^\p{L}\p{N}\s]/u.test(value),
    noEdgeSpaces: !value.startsWith(' ') && !value.endsWith(' '),
  }
}

const ERRORS: Record<string, string> = {
  CodeMismatchException: 'That confirmation code was not accepted. Check the latest email and try again.',
  ExpiredCodeException: 'That confirmation code has expired. Request a new code.',
  TooManyRequestsException: 'Too many attempts. Wait a few minutes before trying again.',
  LimitExceededException: 'Too many attempts. Wait a few minutes before trying again.',
  InvalidPasswordException: 'Choose a password that meets the requirements, then try again.',
}

function validatedClient(client: string) {
  if (!/^[a-z0-9]{1,128}$/.test(client)) throw new Error('Account verification is unavailable.')
  return client
}

export function normalizedVerificationEmail(email: string) {
  const value = email.trim().toLowerCase()
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Enter a valid email address.')
  }
  return value
}

function validatedCode(code: string) {
  const value = code.trim()
  if (!/^[A-Za-z0-9]{6,8}$/.test(value)) {
    throw new Error('Enter the confirmation code from your email.')
  }
  return value
}

async function callCognito(operation: VerificationOperation, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + operation,
      },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Could not contact account verification. Please try again later.')
  }
  if (response.ok) {
    if (operation !== 'SignUp') return {}
    const result: unknown = await response.json().catch(() => null)
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        typeof (result as Record<string, unknown>).UserConfirmed !== 'boolean') {
      throw new Error('Account creation could not be verified. Sign in to check your account status.')
    }
    return result as Record<string, unknown>
  }
  // Never print or surface Cognito's raw provider response: it can contain
  // account existence details. Only safe, allowlisted code errors are shown.
  let type = ''
  try {
    const value: unknown = await response.json()
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const raw = (value as Record<string, unknown>).__type
      if (typeof raw === 'string' && raw.length < 150) type = raw.split('#').pop() || ''
    }
  } catch {
    // No provider diagnostics should reach the UI.
  }
  if (operation === 'SignUp' && type === 'UsernameExistsException') {
    throw new ExistingCognitoAccountError()
  }
  throw new Error(ERRORS[type] || 'Could not complete verification. Check your email and try again.')
}

export async function resendSignupCode(client: string, email: string) {
  await callCognito('ResendConfirmationCode', {
    ClientId: validatedClient(client),
    Username: normalizedVerificationEmail(email),
  })
}

export async function confirmSignupCode(client: string, email: string, code: string) {
  await callCognito('ConfirmSignUp', {
    ClientId: validatedClient(client),
    Username: normalizedVerificationEmail(email),
    ConfirmationCode: validatedCode(code),
  })
}

/** Signup through the public Cognito browser client, not a hosted form or QuizForge API. */
export async function signUpWithEmail(client: string, email: string, password: string) {
  const publicClient = validatedClient(client)
  const username = normalizedVerificationEmail(email)
  if (password.length < 8 || password.length > 256) {
    throw new Error('Use a password with at least 8 characters.')
  }
  const result = await callCognito('SignUp', {
    ClientId: publicClient, Username: username, Password: password,
    UserAttributes: [{ Name: 'email', Value: username }],
  })
  return { email: username, confirmed: result.UserConfirmed === true }
}
