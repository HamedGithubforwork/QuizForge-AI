# Cognito SMS MFA activation runbook

Status: **prepared, not activated**

Quiz From Notes keeps TOTP optional and available. SMS stays disabled until AWS End User Messaging SMS production access is approved and an SMS-capable origination identity exists in `ca-central-1`.

## Why the activation is API-managed

The production AWS provider is pinned to HashiCorp AWS provider 6.64.0. The provider's Cognito user-pool resource does not currently model the AWS End User Messaging SMS direct `EumsSms` configuration. The guarded controller therefore uses the Cognito API for the direct SMS configuration while preserving every currently supported user-pool and app-client field returned by AWS.

## Before activation

1. AWS End User Messaging SMS account tier must report `PRODUCTION`.
2. Request an SMS-capable Canadian origination identity in `ca-central-1`.
3. Copy the exact **ARN** of that phone number or phone pool. Do not use the E.164 phone number as the activation input.
4. Run **Cognito SMS MFA readiness and activation** with `operation=inspect`. This uses read-only AWS permissions and publishes a sanitized readiness result without requiring an origination ARN or confirmation phrase.
5. Confirm the result reports the production SMS tier and at least one SMS-capable phone number or pool before activation.
6. Do not place phone numbers, verification codes, or credentials in GitHub workflow inputs.

## Activation

Run the GitHub Actions workflow **Cognito SMS MFA readiness and activation** on `main` with `operation=activate`.

Inputs:

- `operation`: `activate`
- `origination_identity_arn`: exact `ca-central-1` phone-number or pool ARN.
- `confirmation`: `ENABLE COGNITO SMS MFA`

The workflow refuses to continue unless the SMS account is production-ready and the supplied identity belongs to the current AWS account and is SMS-capable.

The activation controller then:

- creates or verifies the dedicated `quizforge-production-cognito-sms` IAM role;
- restricts the role trust policy to Cognito, the production user-pool ARN, the current AWS account, and a deterministic external ID;
- grants only `sms-voice:SendTextMessage` on the exact origination identity ARN;
- preserves the current Cognito user-pool settings;
- enables automatic phone verification and requires verification before phone-number updates become active;
- preserves optional MFA and TOTP;
- configures the direct AWS End User Messaging SMS path;
- enables SMS MFA;
- preserves the current app client while adding read/write access for phone-number attributes;
- performs a complete readback before reporting success.

## Refresh the website feature flag

After the activation workflow succeeds, manually run **Permanent Lightsail Cognito frontend correction**.

That workflow rebuilds the existing pinned frontend candidate from the live Cognito configuration. Its public build flag will then expose Text-message 2FA because `GetUserPoolMfaConfig` reports SMS MFA as configured.

## Final smoke test

Use a test account on `https://quizfromnotes.com`:

1. Open **Settings > Security**.
2. Add a Canadian phone number in E.164 format, for example `+16135551234`.
3. Confirm receipt of the verification code.
4. Verify the number.
5. Enable Text-message 2FA.
6. Sign out and sign back in once with SMS.
7. Confirm Authenticator 2FA still works and MFA can still be disabled.

Do not log or commit the real phone number or one-time code.
