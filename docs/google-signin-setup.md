# Google sign-in preparation

Google sign-in is **disabled by default**. Email/password remains supported.

Create a Google Cloud OAuth **Web application** client for Quiz From Notes. Set its authorized origin to the Cognito domain returned by the `auth_origin` Terraform output, and its Google redirect to that domain followed by `/oauth2/idpresponse`. The browser continues to use `https://quizfromnotes.com/auth/callback` after Cognito authentication.

Use the `enable_google_signin` Terraform switch only after reviewing the private OAuth client ID/secret configuration and completing a production authentication smoke test. Never commit Google OAuth secrets to Git. Sensitive Terraform inputs can still appear in encrypted Terraform state; keep state access restricted.

**Critical account-safety rule:** Cognito creates a new user subject for an unlinked Google identity. Existing quiz history is associated with an existing Cognito subject. Implement and test an authenticated, explicit account-linking flow before public activation; matching email addresses alone are insufficient proof of account ownership. Verify Google-only registration, existing-account linking, password sign-in, session refresh, logout, and authorization in production-like tests.

Changing `name@host.com` in Cognito's built-in classic sign-in input is not supported by its normal style configuration. Do not replace the production login interface just to change that example address.
