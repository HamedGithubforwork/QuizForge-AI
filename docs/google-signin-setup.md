# Google sign-in setup

Google sign-in is **disabled by default**. Email/password remains supported.

## Google OAuth client

Create a Google Cloud OAuth client of type **Web application** for Quiz From Notes.

- Authorized JavaScript origin: the Cognito domain from the Terraform `auth_origin` output.
- Authorized redirect URI: that same Cognito domain followed by `/oauth2/idpresponse`.
- Cognito callback to the browser: `https://quizfromnotes.com/auth/callback`.

The Google redirect goes to Cognito; Cognito then returns the browser to the app callback.

## Private configuration

The Lightsail Cognito Terraform stack has these variables:

- `enable_google_signin` (defaults to `false`)
- `google_oauth_client_id`
- `google_oauth_client_secret` (sensitive)

Supply the credentials only to the protected Terraform execution environment, for example through `TF_VAR_google_oauth_client_id` and `TF_VAR_google_oauth_client_secret`. Never commit them, paste them into chat, or print them in CI logs. Terraform state can contain the secret, so restrict state access even when its storage is encrypted.

The frontend also hides the button unless `VITE_COGNITO_GOOGLE_SIGNIN_ENABLED=true`. Keep both settings disabled until all release checks below pass.

## Account linking and MFA behavior

Cognito gives an unlinked Google identity a new user subject. Existing quiz history remains attached to the user's existing Cognito subject. Do not link based on matching email addresses.

To link existing history, the user must authenticate the existing Cognito account with its password and any configured MFA, then confirm the one-time link. The Google session remains active during this proof.

After linking, later Google sign-ins use Google's authentication and security settings. Cognito MFA is not prompted on those federated sign-ins. The account-linking screen discloses this. Decide before activation whether relying on Google's security settings is acceptable; if every login must require an app-controlled second factor, design and test that separately.

Google OAuth itself does not require SMS production access. If the existing Cognito account uses SMS MFA, the SMS sandbox can be used for testing with a verified destination number; sending to arbitrary customer numbers requires production access.

## Pre-activation test checklist

Run this against the configured provider in a production-like environment, with test accounts and no real user data:

1. Sign in with Google for a new account. Confirm Cognito creates one new account with no prior quiz history.
2. Sign in with Google for an account that has existing Quiz From Notes history. Link by entering the existing Cognito password and completing its configured MFA; confirm the old history appears under the linked identity.
3. Try an incorrect password and an incorrect or expired MFA code. Confirm linking does not occur. Cancel the flow and confirm the account remains unlinked.
4. Verify existing email/password sign-in, its MFA challenge, session refresh, logout, and API authorization still work.
5. Confirm passwords and proof tokens are not stored in local or session storage and are not sent in URLs.
6. Confirm the Google sign-in button is absent when `VITE_COGNITO_GOOGLE_SIGNIN_ENABLED=false`.

Before public activation, require exact-head CI to pass, review backend identity-linking changes, complete this real-provider test, decide the MFA policy above, and review the active production release lock. Keep OAuth credentials in private configuration throughout.

## Cognito-managed email example

Changing `name@host.com` in Cognito's built-in classic sign-in input is not supported by its normal style configuration. The app-owned account setup and linking inputs use the conventional `you@example.com` example instead.
