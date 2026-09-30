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
per-user NSIS installer. It then installs the package for the disposable runner's
user, verifies the packaged window opens and closes, and uninstalls it. The smoke
refuses a pre-existing installation and checks per-user registration/removal.
It makes only signed-out page loads; no credentials or model calls are used.
Its seven-day artifact is an **unsigned internal preview**,
not a public release. Packaging never publishes a GitHub release or update feed.
The signed-out hosted-login check opens the real site, clicks Sign in, verifies
S256 PKCE and the expected sandboxed Cognito username/password form, then clears
its temporary browser session. It never enters credentials, exchanges tokens or
calls generation. This check depends on public site/Cognito availability and does
not establish authenticated account acceptance.

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

1. On Windows, manually verify installation on a normal user machine, signup and existing-account
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

## Encrypted snapshot storage foundation

`windows-snapshot-store.cjs` provides main-process-only snapshot save/load/remove
operations using Electron's asynchronous Windows OS encryption. Files use opaque
account-derived names, a versioned envelope, an 8 MiB plaintext bound, and atomic
same-directory replacement. Concurrent operations are serialized. Encryption
unavailability, corruption, wrong-owner envelopes, unknown schema versions,
symlinks, and oversized files fail closed; there is no plaintext fallback.

The caller must obtain the account identity from a verified session. Encryption
protects stored data at the Windows-account boundary; it does not protect against
malware already running as that Windows user. Snapshot validation requires complete schema-1 DeckDetail/CardRow responses: known
fields, UUIDs and deck/card ownership, globally unique IDs, bounded card content,
question/answer shapes, dates, FSRS values, source references and matching counts.
Unknown or incomplete snapshots fail closed on both save and load. Earlier minimal
synthetic fixtures are intentionally incompatible; no real user data has been saved
by this unconnected storage layer. Changes to backend/decks.py response contracts
must be reviewed alongside snapshot-validation.cjs.

This is a tested storage foundation, **not an enabled offline feature**. It has no
renderer IPC bridge, does not save any real account data automatically, and does
not persist authentication tokens. A future authenticated offline workflow must
bind the account from a verified session, provide explicit save/remove controls, and
reconcile queued reviews before this store is connected to the UI. Windows CI
exercises a real OS-encrypted round trip and deletion using synthetic data only.

## Opt-in signed candidate build

On a Windows signing machine with PowerShell 7, install the owner's existing
trusted code-signing certificate/private-key provider in the current-user Windows
certificate store. No certificate purchase, enrollment, key export, secret upload,
or paid service is performed by this repository. If no certificate exists, owner
selection and approval of the signing provider/cost are required first.

From a clean checkout of the reviewed commit, run:

```powershell
./desktop/scripts/build-signed.ps1 -ReviewedCommit <full-reviewed-commit> -CertificateThumbprint <40-character-thumbprint>
```

The script requires the exact clean commit, audits dependencies, runs unit tests,
forces code signing, and pins the Windows certificate. It independently requires
trusted, timestamped Authenticode signatures on the installer and packaged app.
It creates `dist-signed/verified-candidate.json` with version, reviewed commit,
public certificate thumbprint and installer SHA-256 only after those checks pass.
The manifest is an integrity record, not an authenticated update feed. Keep each
reviewed candidate and manifest together for manual rollback/reinstallation.

The unsigned CI preview remains separate. CI parses the scripts and proves that
its actual unsigned installer cannot pass the signing gate. A successful signed
build cannot be claimed until an owner-controlled certificate is available and
that path runs on Windows. Nothing publishes automatically. Signing alone does
not complete account acceptance, authenticated updates, or offline synchronization.
