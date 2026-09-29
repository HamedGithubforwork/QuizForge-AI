import {
  expect,
  type Page,
} from '@playwright/test'
import {
  createHmac,
} from 'node:crypto'
import {
  readFileSync,
} from 'node:fs'

export const frontendUrl =
  process.env.CANARY_FRONTEND_URL ||
  'https://quizfromnotes.com'

type CanaryFixture = {
  email: string
  password: string
  totp: string
}

export function readCanaryFixture(): CanaryFixture {
  const path =
    process.env.CANARY_FIXTURE_PATH || ''

  expect(path.length).toBeGreaterThan(0)

  const value =
    JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<CanaryFixture>

  expect(value.email).toMatch(
    /^qf-prod-canary-[0-9]+@example\.invalid$/,
  )
  expect(value.password?.length).toBeGreaterThan(
    20,
  )
  expect(value.totp).toMatch(
    /^[A-Z2-7]{16,128}$/,
  )

  return {
    email: value.email!,
    password: value.password!,
    totp: value.totp!,
  }
}

function currentTotp(secret: string) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''

  for (
    const character of secret.replace(/=+$/, '')
  ) {
    const index =
      alphabet.indexOf(character)

    if (index < 0) {
      throw new Error(
        'Invalid production canary TOTP secret.',
      )
    }

    bits +=
      index.toString(2).padStart(5, '0')
  }

  const chunks =
    bits.match(/.{8}/g) ?? []
  const key = Buffer.from(
    chunks.map((chunk) =>
      Number.parseInt(chunk, 2),
    ),
  )
  const counter = Buffer.alloc(8)

  counter.writeBigUInt64BE(
    BigInt(
      Math.floor(Date.now() / 30_000),
    ),
  )

  const digest =
    createHmac('sha1', key)
      .update(counter)
      .digest()
  const offset =
    digest[digest.length - 1] & 15
  const code =
    (
      digest.readUInt32BE(offset) &
      0x7fffffff
    ) % 1_000_000

  return String(code).padStart(6, '0')
}

export async function signInAndEnrollCanary(
  page: Page,
  fixture: CanaryFixture,
) {
  await page.goto(frontendUrl)

  const signIn =
    page.getByRole('button', {
      name: /^Sign in(?: or create account)?/,
    })

  await expect(signIn).toBeVisible({
    timeout: 30_000,
  })
  await signIn.click()

  const usernameInput =
    page.locator(
      'input[name="username"]:visible',
    )
  const passwordInput =
    page.locator(
      'input[name="password"]:visible',
    )

  await usernameInput.waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await usernameInput.fill(fixture.email)
  await passwordInput.fill(fixture.password)

  await page
    .locator(
      'input[name="signInSubmitButton"]:visible,button[name="signInSubmitButton"]:visible',
    )
    .click()

  const totpInput =
    page.locator(
      'input[name="authentication_code"][id="totpCodeInput"]:visible',
    )

  await totpInput.waitFor({
    state: 'visible',
    timeout: 30_000,
  })

  // The setup OTP cannot be reused in the same period.
  await page.waitForTimeout(
    31_000 - (Date.now() % 30_000),
  )
  await totpInput.fill(
    currentTotp(fixture.totp),
  )

  await page
    .locator(
      'input[type="submit"]:visible,button[type="submit"]:visible',
    )
    .click()

  const productionOrigin =
    new URL(frontendUrl).origin

  await page.waitForURL(
    (url) =>
      url.origin === productionOrigin,
    {
      timeout: 60_000,
    },
  )

  const setupHeading =
    page.getByRole('heading', {
      name: 'Set up your account',
    })
  const uploadHeading =
    page.getByRole('heading', {
      name: 'Upload your study material',
    })

  await page.waitForTimeout(2_000)

  const setupVisible =
    await setupHeading
      .isVisible()
      .catch(() => false)
  const uploadVisible =
    await uploadHeading
      .isVisible()
      .catch(() => false)

  if (!setupVisible && !uploadVisible) {
    const signInVisible =
      await page
        .getByRole('button', {
          name: /^Sign in(?: or create account)?/,
        })
        .isVisible()
        .catch(() => false)
    const alertText =
      await page
        .getByRole('alert')
        .first()
        .textContent()
        .catch(() => null)

    let errorClass = 'none'

    if (alertText?.includes(
      'Sign-in could not be verified',
    )) {
      errorClass =
        'identity_verification_failed'
    } else if (alertText?.includes(
      'session is invalid',
    )) {
      errorClass = 'invalid_session'
    } else if (alertText?.includes(
      'temporarily unavailable',
    )) {
      errorClass =
        'auth_service_unavailable'
    } else if (alertText?.includes(
      'Untrusted request origin',
    )) {
      errorClass = 'untrusted_origin'
    } else if (alertText) {
      errorClass = 'other_error'
    }

    console.log(
      'PRODUCTION_CANARY_POST_LOGIN_STATE ' +
      JSON.stringify({
        path: new URL(page.url()).pathname,
        signInVisible,
        errorClass,
      }),
    )
  }

  if (setupVisible) {
    await page
      .getByLabel('Account setup')
      .selectOption('enroll')

    await page
      .getByRole('button', {
        name: 'Continue account setup',
      })
      .click()

    await page
      .getByRole('button', {
        name: 'Confirm account setup',
      })
      .click()
  }

  await expect(uploadHeading).toBeVisible({
    timeout: 30_000,
  })
}

