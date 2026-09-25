export type MigratedActivationSetup = {
  kind: 'totp_setup'
  email: string
  username: string
  session: string
  secret: string
}

type CognitoResponse = Record<string, unknown>

const endpoint = 'https://cognito-idp.ca-central-1.amazonaws.com/'

function valueString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function challengeParameters(value: unknown) {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

async function cognitoRequest(
  operation: string,
  body: Record<string, unknown>,
): Promise<CognitoResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target':
        'AWSCognitoIdentityProviderService.' + operation,
    },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })

  const value = await response.json().catch(() => ({}))

  if (!response.ok) {
    const code =
      valueString((value as Record<string, unknown>).__type)
        .split('#')
        .pop() || ''

    if (
      code === 'CodeMismatchException' ||
      code === 'EnableSoftwareTokenMFAException'
    ) {
      throw new Error(
        'That authenticator code was not accepted. Wait for a new code and try again.',
      )
    }

    throw new Error(
      'Account activation could not be completed. Check your email and existing password, then try again.',
    )
  }

  if (!value || typeof value !== 'object') {
    throw new Error('Cognito returned an invalid activation response.')
  }

  return value as CognitoResponse
}

export async function beginMigratedActivation(
  clientId: string,
  email: string,
  password: string,
): Promise<MigratedActivationSetup | { kind: 'already_ready' }> {
  const cleanEmail = email.trim().toLowerCase()

  if (!cleanEmail || !cleanEmail.includes('@') || !password) {
    throw new Error('Enter your existing account email and password.')
  }

  const result = await cognitoRequest(
    'InitiateAuth',
    {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: cleanEmail,
        PASSWORD: password,
      },
    },
  )

  const challenge = valueString(result.ChallengeName)

  if (challenge === 'SOFTWARE_TOKEN_MFA') {
    return { kind: 'already_ready' }
  }

  if (challenge !== 'MFA_SETUP') {
    throw new Error(
      'This account is not waiting for first-login security setup. Use Sign in instead.',
    )
  }

  const session = valueString(result.Session)
  const params = challengeParameters(
    result.ChallengeParameters,
  )
  const username =
    valueString(params.USERNAME) || cleanEmail

  if (!session) {
    throw new Error('Cognito did not return an MFA setup session.')
  }

  const association = await cognitoRequest(
    'AssociateSoftwareToken',
    { Session: session },
  )

  const secret = valueString(
    association.SecretCode,
  )
  const nextSession = valueString(
    association.Session,
  )

  if (
    !/^[A-Z2-7]+=*$/i.test(secret) ||
    !nextSession
  ) {
    throw new Error('Cognito did not return a valid authenticator setup key.')
  }

  return {
    kind: 'totp_setup',
    email: cleanEmail,
    username,
    session: nextSession,
    secret,
  }
}

export async function finishMigratedActivation(
  clientId: string,
  setup: MigratedActivationSetup,
  code: string,
) {
  if (!/^[0-9]{6}$/.test(code)) {
    throw new Error(
      'Enter the 6-digit code from your authenticator app.',
    )
  }

  const verified = await cognitoRequest(
    'VerifySoftwareToken',
    {
      Session: setup.session,
      UserCode: code,
      FriendlyDeviceName: 'Quiz From Notes',
    },
  )

  if (
    valueString(verified.Status) !== 'SUCCESS' ||
    !valueString(verified.Session)
  ) {
    throw new Error('Authenticator verification did not complete.')
  }

  const completed = await cognitoRequest(
    'RespondToAuthChallenge',
    {
      ChallengeName: 'MFA_SETUP',
      ClientId: clientId,
      Session: valueString(verified.Session),
      ChallengeResponses: {
        USERNAME: setup.username,
      },
    },
  )

  const authentication =
    completed.AuthenticationResult &&
    typeof completed.AuthenticationResult === 'object'
      ? completed.AuthenticationResult as Record<string, unknown>
      : {}

  const accessToken =
    valueString(authentication.AccessToken)

  if (!accessToken) {
    throw new Error('Cognito did not complete account activation.')
  }

  // This direct API session exists only to complete the imported-account
  // MFA setup. Do not retain it; the normal app session is always obtained
  // through the reviewed PKCE/OIDC redirect flow.
  await cognitoRequest(
    'GlobalSignOut',
    { AccessToken: accessToken },
  ).catch(() => undefined)
}

export function authenticatorSetupUri(
  setup: MigratedActivationSetup,
) {
  const issuer = 'Quiz From Notes'
  const label =
    issuer + ':' + setup.email

  const params = new URLSearchParams({
    secret: setup.secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })

  return (
    'otpauth://totp/' +
    encodeURIComponent(label) +
    '?' +
    params.toString()
  )
}
