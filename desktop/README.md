# Windows desktop foundation — internal preview

This is the first slice of roadmap Phase 16 / Release E. It wraps the existing
HTTPS study interface in a restricted Electron window, using the existing account,
deck, FSRS and analytics contracts. It does not create a second backend or copy
provider secrets into a client. Production deployment is unaffected.

## Run and build

Use Node 22+ on Windows:

```sh
cd desktop
npm ci
npm test
npx --no-install electron test/runtime.cjs
npm start
npm run pack:windows
```

The dedicated Windows CI job runs a real renderer security smoke and builds a
per-user NSIS installer. Its seven-day artifact is an **unsigned internal preview**,
not a public release. Packaging never publishes a GitHub release or update feed.
No administrator installation is required. The app is separately versioned.

## Boundaries

- Reuse the deployed React interface at `https://quizfromnotes.com`.
- Permit only that exact origin and reviewed paths on its exact public Cognito
  hosted-login origin; reject other navigation, redirects, popups and webviews.
- Preserve the existing in-window authorization-code/PKCE redirect. No desktop
  callback URI or authentication-provider configuration change is introduced.
- Enable Electron sandbox, context isolation and web security. Disable Node in
  every renderer context. No preload, IPC bridge, shell opener or custom protocol.
- Use an in-memory browser partition. Tokens retain the web app's in-memory
  handling; closing the app discards the session. No persistent token cache yet.
- Deny permission requests and downloads. PDF upload uses the existing browser
  file picker. Browser push is not claimed to work in Electron; use web reminders
  until a supported desktop notification path is verified.
- A connection failure offers Retry/Close without logging URLs, codes or tokens.
- Existing server AI quotas and entitlements remain authoritative. No local model
  runtime, paid service, new AWS resource or automatic update is enabled.

## Acceptance before expanding distribution

1. On Windows, manually verify installer/uninstaller, signup and existing-account
   login, MFA, password recovery, logout, PDF selection, deck browsing and due-card
   review. Automated sandbox checks are not authentication acceptance.
2. Verify Cognito's supported native-app/system-browser authorization approach
   before public distribution; replace the embedded preview login with an audited
   PKCE system-browser flow if required. Do not loosen navigation to make it work.
3. Add signed installers and authenticated, versioned automatic updates with a
   tested rollback path. Obtain owner approval for signing costs/credentials.
4. Design encrypted local storage and offline deck/review synchronization before
   claiming offline operation. This initial preview requires the internet; AI
   unavailability is separate from network unavailability.
5. Add local inference behind an explicit provider boundary, hardware/model checks,
   and measured quality/latency tests. Keep cloud secrets server-side.

Do not mark Phase 16 complete or advertise an offline/local-AI desktop product
based on this foundation. Web releases still change the hosted UI independently
of the shell; a bundled, version-compatible offline UI belongs in the next slice.

Security references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox),
and [NSIS packaging](https://www.electron.build/docs/nsis/).
