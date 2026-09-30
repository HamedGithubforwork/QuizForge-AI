# Native sign-in integration plan

Status: transaction primitive tested; **native sign-in is not enabled**. The preview still uses its existing hosted sign-in window. No protocol handler, browser launcher, token exchange or new Cognito client is installed by this change.

`src/native-auth-attempt.cjs` is main-process-only preparation for system-browser sign-in. It produces a pinned Cognito authorization URL with independent random state, nonce and S256 PKCE proof. The verifier stays in its closure until a matching callback is consumed once. Attempts expire after five monotonic minutes or explicit cancellation. Unrelated callbacks do not cancel an active attempt; matching malformed or denied responses consume it. Errors never include returned provider values.

The proposed callback is `com.quizfromnotes.desktop.preview:/oauth/callback`. This exact URI must be registered before integration; it is not an active endpoint today. The function returns a token request description and expected nonce, not tokens or a verified account. Never log either authorization callbacks or returned request bodies.

## Remaining activation requirements

1. Configure a dedicated public desktop Cognito app client without a client secret, using authorization code grant and the exact callback. Review scopes and retain the existing web client and web callbacks. The shared API/identity verifier supports one optional `COGNITO_DESKTOP_CLIENT_ID` alongside `COGNITO_CLIENT_ID`. It defaults to disabled, requires a distinct explicit client ID and retains all access-token, issuer, scope, signature, expiration and online revocation checks. Configure both API and identity services only after registration and end-to-end acceptance; no deployed value is changed by this preparation. Never accept arbitrary clients from the pool.
2. Register the private URI scheme in the Windows installer, handle both cold and second-instance launches, and allow only one pending attempt. Cancel the old attempt on replacement, window closure and sign-out. Launch only the internally produced authorization URL through the system browser; renderer-provided URLs must never reach `shell.openExternal`.
3. Exchange the consumed code in the main process over the pinned HTTPS endpoint, with redirects disabled, bounded response size, timeout and strict token-response validation. Use a maintained JWT/OIDC verifier to check signature, pinned issuer, intended desktop client, token use, expiration, nonce and matching subject before establishing identity. A decoded JWT or callback state alone is not identity verification.
4. Bind encrypted study snapshots to that verified account. Keep tokens out of renderer IPC, URLs, logs and persisted snapshots. Define refresh/revocation and sign-out cancellation before exposing account data. Design a narrowly scoped renderer bridge with sender/frame checks and explicit commands; the current remote renderer has no preload or IPC.
5. Test real Windows cold/warm callbacks, cancellation, MFA, replay, wrong client/issuer/nonce, account switching and logout, plus the existing hosted-login regression. Complete signing and manual Windows acceptance before making a public native-login release.

## References

- [OAuth for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252): external user agents, PKCE and private-use URI schemes.
- [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html): registered callbacks, S256 and nonce.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): external navigation and IPC boundaries.
