# Native sign-in integration plan

Status: the unsigned Windows preview provides **Help → Test desktop sign-in…** for manual acceptance. The test opens the system browser, receives the exact installed callback, verifies token signatures/claims and refresh, and revokes its in-memory test session before reporting success. The study window still uses its existing hosted login; native study-account integration and offline storage are not enabled.

`src/native-auth-attempt.cjs` is main-process-only preparation for system-browser sign-in. It produces a pinned Cognito authorization URL with independent random state, nonce and S256 PKCE proof. The verifier stays in its closure until a matching callback is consumed once. Attempts expire after five monotonic minutes or explicit cancellation. Unrelated callbacks do not cancel an active attempt; matching malformed or denied responses consume it. Errors never include returned provider values.

The proposed callback is `com.quizfromnotes.desktop.preview:/oauth/callback`. This exact URI is registered by the Windows installer. It only reaches the session callback receiver; it cannot navigate the renderer or open arbitrary URLs. The function returns a token request description and expected nonce, not tokens or a verified account. Never log either authorization callbacks or returned request bodies.

`src/native-auth-client.cjs` exchanges codes, refreshes sessions and revokes refresh tokens against the pinned Cognito HTTPS origin. It uses the pinned `jose` dependency for RSA signature/JWT verification against the configured Canadian pool's JWKS, with bounded responses, timeouts and no redirects. Initial sign-in requires the expected nonce; ID/access tokens must match account and authentication time, with the intended client, token use, issuer, scope, lifetime and verified email. Refresh cannot switch accounts. Only main-process callers may hold the returned tokens; errors are generic and no session is saved to disk. JWT verification alone cannot detect revocation: the API/identity service must continue its existing online GetUser checks on every protected request.

Windows installer acceptance loads this module and its production JWT dependency from the installed ASAR without contacting the network. Unit tests use real synthetic RSA signatures and mocked HTTP, not real accounts.

`src/native-session.cjs` composes the transaction and token client in memory. It opens only the generated URL through an injected main-process browser launcher, settles cancelled/replaced/expired attempts, ignores unrelated or duplicate callbacks, and serializes refresh. An epoch guard prevents delayed exchange or refresh results from restoring a signed-out/replaced account; discarded token results are revoked where possible. Sign-out clears local identity immediately even when remote revocation fails. A sticky `revocationUnconfirmed` status exposes that limitation without private error details. Session views omit refresh tokens. The acceptance menu connects this module to the shell callback receiver and internally generated browser URL. Its session view remains main-process-only; there is no renderer IPC or persisted token store.

## Remaining activation requirements

1. Configure a dedicated public desktop Cognito app client without a client secret, using authorization code grant and the exact callback. Review scopes and retain the existing web client and web callbacks. The shared API/identity verifier supports one optional `COGNITO_DESKTOP_CLIENT_ID` alongside `COGNITO_CLIENT_ID`. It defaults to disabled, requires a distinct explicit client ID and retains all access-token, issuer, scope, signature, expiration and online revocation checks. Configure both API and identity services only after registration and end-to-end acceptance; no deployed value is changed by this preparation. Never accept arbitrary clients from the pool.
2. Register the private URI scheme in the Windows installer, handle both cold and second-instance launches, and allow only one pending attempt. Cancel the old attempt on replacement, window closure and sign-out. Launch only the internally produced authorization URL through the system browser; renderer-provided URLs must never reach `shell.openExternal`.
3. Connect the tested main-process session lifecycle to the app and complete authenticated API/identity acceptance before binding account data. Keep the epoch/cancellation guards intact when adding window, account-switch and renderer integration; a decoded JWT or callback state alone is not identity verification.
4. Bind encrypted study snapshots to that verified account. Keep tokens out of renderer IPC, URLs, logs and persisted snapshots. Define refresh/revocation and sign-out cancellation before exposing account data. Design a narrowly scoped renderer bridge with sender/frame checks and explicit commands; the current remote renderer has no preload or IPC.
5. Test real Windows cold/warm callbacks, cancellation, MFA, replay, wrong client/issuer/nonce, account switching and logout, plus the existing hosted-login regression. Complete signing and manual Windows acceptance before making a public native-login release.

## References

- [OAuth for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252): external user agents, PKCE and private-use URI schemes.
- [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html): registered callbacks, S256 and nonce.
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): external navigation and IPC boundaries.

`src/native-protocol.cjs` accepts a single exact callback from bounded OS arguments and forwards it only to an already-pending in-memory session. Cold/signed-out callbacks are discarded, never queued. State, expiry, replay and PKCE remain the session transaction’s responsibility. Windows acceptance checks the exact per-user protocol command, cold callback launch, warm dispatch through the registered URI handler, single-window behavior and uninstall cleanup. Real account/MFA acceptance remains required.

## Manual Windows native acceptance

Install preview 0.1.1, then choose **Help → Test desktop sign-in…**. Complete sign-in/MFA in the system browser and allow it to return to Quiz From Notes Preview. Expect **Desktop sign-in test passed**. The test verifies refresh and attempts remote revocation automatically; it does not sign the study screen into this account. **Help → Cancel desktop sign-in test** cancels an unfinished attempt. Closing the app clears the private session and waits for bounded revocation. Cold or replayed callbacks cannot resume a prior attempt.

Repeat cancellation and sign-in with another account. Never share callback URLs, codes, tokens or passwords in test reports. Report only the final message and whether browser return worked. A real Windows account/MFA run remains required; automated CI uses synthetic sessions and signed-out page loads only.

The packaged `src/native-runtime.json` contains only public OAuth routing IDs, sourced from the read-only configuration artifact after live policy and hosted-form checks. It contains no secret and cannot be overridden by renderer content, environment variables or command-line arguments. The configuration artifact provenance is recorded in the application PR.
