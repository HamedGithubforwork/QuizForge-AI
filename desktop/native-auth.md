# Native sign-in integration plan

Status: transaction and token-verification primitives tested; **native sign-in is not enabled**. The preview still uses its existing hosted sign-in window. No protocol handler, browser launcher or new Cognito client is enabled. The token client is not connected to the running application.

`src/native-auth-attempt.cjs` is main-process-only preparation for system-browser sign-in. It produces a pinned Cognito authorization URL with independent random state, nonce and S256 PKCE proof. The verifier stays in its closure until a matching callback is consumed once. Attempts expire after five monotonic minutes or explicit cancellation. Unrelated callbacks do not cancel an active attempt; matching malformed or denied responses consume it. Errors never include returned provider values.

The proposed callback is `com.quizfromnotes.desktop.preview:/oauth/callback`. This exact URI must be registered before integration; it is not an active endpoint today. The function returns a token request description and expected nonce, not tokens or a verified account. Never log either authorization callbacks or returned request bodies.

`src/native-auth-client.cjs` exchanges codes, refreshes sessions and revokes refresh tokens against the pinned Cognito HTTPS origin. It uses the pinned `jose` dependency for RSA signature/JWT verification against the configured Canadian pool's JWKS, with bounded responses, timeouts and no redirects. Initial sign-in requires the expected nonce; ID/access tokens must match account and authentication time, with the intended client, token use, issuer, scope, lifetime and verified email. Refresh cannot switch accounts. Only main-process callers may hold the returned tokens; errors are generic and no session is saved to disk. JWT verification alone cannot detect revocation: the API/identity service must continue its existing online GetUser checks on every protected request.

Windows installer acceptance loads this module and its production JWT dependency from the installed ASAR without contacting the network. Unit tests use real synthetic RSA signatures and mocked HTTP, not real accounts.

## Remaining activation requirements

1. Configure a dedicated public desktop Cognito app client without a client secret, using authorization code grant and the exact callback. Review scopes and retain the existing web client and web callbacks. The API currently validates one web client ID; add an explicit desktop client allowlist with rejection tests before accepting desktop tokens. Never accept arbitrary clients from the pool.
2. Register the private URI scheme in the Windows installer, handle both cold and second-instance launches, and allow only one pending attempt. Cancel the old attempt on replacement, window closure and sign-out. Launch only the internally produced authorization URL through the system browser; renderer-provided URLs must never reach `shell.openExternal`.
3. Connect the tested transaction and token client to a cancellable main-process session lifecycle. Reject late exchange/refresh results after logout or account replacement. Complete authenticated API/identity acceptance before binding account data; a decoded JWT or callback state alone is not identity verification.
4. Bind encrypted study snapshots to that verified account. Keep tokens out of renderer IPC, URLs, logs and persisted snapshots. Define refresh/revocation and sign-out cancellation before exposing account data. Design a narrowly scoped renderer bridge with sender/frame checks and explicit commands; the current remote renderer has no preload or IPC.
5. Test real Windows cold/warm callbacks, cancellation, MFA, replay, wrong client/issuer/nonce, account switching and logout, plus the existing hosted-login regression. Complete signing and manual Windows acceptance before making a public native-login release.

## References

- [OAuth for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252): external user agents, PKCE and private-use URI schemes.
- [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html): registered callbacks, S256 and nonce.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): external navigation and IPC boundaries.
