export type MfaSecurityStatus = {
  phoneNumber: string
  phoneVerified: boolean
  smsEnabled: boolean
  totpEnabled: boolean
  preferred: 'sms' | 'totp' | 'none'
}

type CognitoResponse = Record<string, unknown>

const endpoint = 'https://cognito-idp.ca-central-1.amazonaws.com/'

function valueString(value: unknown) {
  return typeof value === 'string' ? value : ''
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

    if (code === 'CodeMismatchException') {
      throw new Error(
        'That verification code was not accepted. Wait for a new code and try again.',
      )
    }
    if (code === 'ExpiredCodeException') {
      throw new Error(
        'That verification code expired. Request a new code and try again.',
      )
    }
    if (
      code === 'LimitExceededException' ||
      code === 'TooManyRequestsException'
    ) {
      throw new Error(
        'Too many verification attempts. Please wait before trying again.',
      )
    }

    throw new Error(
      'Phone-number security settings could not be updated. Please try again.',
    )
  }

  if (!value || typeof value !== 'object') {
    throw new Error('Cognito returned an invalid security response.')
  }

  return value as CognitoResponse
}

function normalizeE164(phone: string) {
  const value = phone.trim()
  if (!/^\+[1-9][0-9]{7,14}$/.test(value)) {
    throw new Error(
      'Enter the phone number with country code, for example +16135551234.',
    )
  }
  return value
}

function userAttributes(value: unknown) {
  if (!Array.isArray(value)) return new Map<string, string>()
  const result = new Map<string, string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = valueString(row.Name)
    const entry = valueString(row.Value)
    if (name) result.set(name, entry)
  }
  return result
}

export async function getMfaSecurityStatus(
  accessToken: string,
): Promise<MfaSecurityStatus> {
  if (!accessToken) throw new Error('Sign in again to manage security settings.')

  const result = await cognitoRequest(
    'GetUser',
    { AccessToken: accessToken },
  )
  const attrs = userAttributes(result.UserAttributes)
  const settings = Array.isArray(result.UserMFASettingList)
    ? result.UserMFASettingList.map(valueString)
    : []
  const preferred = valueString(result.PreferredMfaSetting)

  return {
    phoneNumber: attrs.get('phone_number') || '',
    phoneVerified: attrs.get('phone_number_verified') === 'true',
    smsEnabled: settings.includes('SMS_MFA'),
    totpEnabled: settings.includes('SOFTWARE_TOKEN_MFA'),
    preferred:
      preferred === 'SMS_MFA'
        ? 'sms'
        : preferred === 'SOFTWARE_TOKEN_MFA'
          ? 'totp'
          : 'none',
  }
}

export async function beginPhoneVerification(
  accessToken: string,
  phone: string,
) {
  if (!accessToken) throw new Error('Sign in again to manage security settings.')
  const normalized = normalizeE164(phone)

  const result = await cognitoRequest(
    'UpdateUserAttributes',
    {
      AccessToken: accessToken,
      UserAttributes: [
        {
          Name: 'phone_number',
          Value: normalized,
        },
      ],
    },
  )

  const deliveries = Array.isArray(result.CodeDeliveryDetailsList)
    ? result.CodeDeliveryDetailsList
    : []
  const delivered = deliveries.some((item) => {
    if (!item || typeof item !== 'object') return false
    const row = item as Record<string, unknown>
    return (
      valueString(row.AttributeName) === 'phone_number' &&
      valueString(row.DeliveryMedium) === 'SMS'
    )
  })

  if (!delivered) {
    throw new Error(
      'Cognito did not start phone verification. Please try again.',
    )
  }

  return normalized
}

export async function verifyPhoneNumber(
  accessToken: string,
  code: string,
) {
  if (!accessToken) throw new Error('Sign in again to manage security settings.')
  if (!/^[0-9]{6}$/.test(code)) {
    throw new Error('Enter the 6-digit code sent to your phone.')
  }

  await cognitoRequest(
    'VerifyUserAttribute',
    {
      AccessToken: accessToken,
      AttributeName: 'phone_number',
      Code: code,
    },
  )
}

export async function setMfaPreference(
  accessToken: string,
  method: 'sms' | 'totp',
) {
  if (!accessToken) throw new Error('Sign in again to manage security settings.')

  await cognitoRequest(
    'SetUserMFAPreference',
    {
      AccessToken: accessToken,
      SMSMfaSettings: {
        Enabled: true,
        PreferredMfa: method === 'sms',
      },
      SoftwareTokenMfaSettings: {
        Enabled: true,
        PreferredMfa: method === 'totp',
      },
    },
  )
}

export function maskedPhoneNumber(phone: string) {
  if (!phone) return ''
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '••••'
  return '••••' + digits.slice(-4)
}
