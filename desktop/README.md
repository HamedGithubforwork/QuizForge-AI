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
- Preserve the existing in-window authorization-code/PKCE redirect. The explicit native sign-in acceptance test uses a separate reviewed desktop client and private callback.
- Enable Electron sandbox, context isolation and web security. Disable Node in
  every renderer context. No preload or renderer IPC bridge. Only the explicit native test can open its internally generated sign-in URL in the system browser.
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
synthetic fixtures are intentionally incompatible. Changes to backend/decks.py response contracts
must be reviewed alongside snapshot-validation.cjs.

Preview 0.1.4 connects this store to the verified native account through the
**Quiz From Notes → Save encrypted local study copy / Remove local study copy**
menu. Both actions require explicit confirmation and online enrolled-account
verification. Save fetches complete deck responses sequentially, validates them,
checks identity again, and atomically replaces only that account's copy. Any
incomplete collection leaves the old copy intact. Account changes during prompts,
fetches or encryption invalidate the operation. Save/remove cannot overlap.

This is **not enabled offline study or a portable backup**. Copies include card
content and source references, remain encrypted in the Windows profile after
sign-out, and are not automatically refreshed. Server decks are never changed;
collection is not a server-wide transactional snapshot. No new renderer IPC,
offline authentication, token persistence or review replay is exposed. Removal
currently requires online sign-in to the owning account. Windows CI exercises the
account/menu flow with synthetic responses and real OS-encrypted save/load/remove.
Offline browsing and queued-review reconciliation remain separate work.

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

## Desktop diagnostics

Open **Help → Desktop diagnostics…** to inspect app/Electron/Chromium versions,
platform/architecture, packaged status and this session's page-load and renderer-exit
counts. Choose **Copy** to put the displayed report on your clipboard for support.
Closing the dialog does not copy anything; nothing uploads automatically. The report
contains no URLs, error messages, account identifiers, study content, file paths,
tokens or environment variables. Counts reset when the app closes. This is a minimal
in-memory support report, not persistent crash dumps or telemetry.

## Native browser sign-in acceptance (preview 0.1.1)

Use **Help → Test desktop sign-in…** in the installed Windows app. Finish signing in
and any MFA in your system browser, allow the return to the desktop app, and expect
**Desktop sign-in test passed**. The test checks refresh and revokes its private test
session. It leaves the study window on its existing account. Cancel through
**Help → Cancel desktop sign-in test**. See `native-auth.md` for acceptance details.
This menu is available only in the packaged Windows preview with reviewed public
configuration. It does not enable offline study or native desktop reminders.

## Updates to the installed app

The selected release route is now **Microsoft Store, initially Private audience**.
See [Store preparation](store.md) for the packaging profile, account/identity setup,
and outstanding Windows acceptance. The direct-EXE update path below remains an
optional alternative; no signing subscription is required for Store distribution.

The main process supports **Help → Check for updates…** and **Restart to update…**.
An update-enabled signed build checks after startup and every four hours, downloads
new published releases, and leaves restart under your control. Save your work before
restarting. Ordinary quit never installs an update. Downloads use electron-updater's
checksum and Windows publisher-signature verification; prereleases, downgrades and
web installers are disabled. No account or GitHub token is embedded in the app.

The current unsigned preview deliberately reports that updates are not enabled.
Version 0.1.1 cannot acquire an updater remotely: one manual installation of the first
update-enabled signed build is required. Subsequent published versions replace the
existing installation and preserve its app-data directory. Web-interface changes
already appear when the app reloads and do not require replacing the executable.

To activate this path, the owner must supply an existing trusted Windows signing
certificate or approve a signing provider/cost. On the signing machine, use the
existing build command with `-EnableUpdates`. This selects `build/update-enabled.cjs`,
forces signing, embeds the certificate publisher, and verifies `latest.yml` against
the actual installer. Run `scripts/draft-update.ps1` with the reviewed commit,
certificate thumbprint and release notes to upload a **draft** to the existing public
GitHub repository. Publish only after real signed version-to-version Windows acceptance.
Upload the EXE, its blockmap and latest.yml together; retain prior signed releases.
CI tests a synthetic older installer upgrading in place and rejects unsigned output.
It also downloads copies of the actual EXE through the real Electron/NSIS updater,
using temporary test certificates trusted only inside the disposable Windows runner.
It checks the expected signer, wrong signer, unsigned/tampered binaries, checksum
failures, rejected-download cleanup and recovery. These fixtures are never installed
or uploaded, and the test certificates are removed. This is automated real-Windows
coverage, not interactive acceptance or public signed-release/feed acceptance; the
latter still requires the owner's trusted certificate and actual release path.
Never set a fake publisher or disable signature checks to make unsigned previews update.

Only published releases reach installed apps; merging a PR alone does not ship an
executable. For a faulty release, publish a higher version containing the known-good
code, because automatic downgrades are disabled. A manual verified older installer
remains a recovery option. Do not change the app ID/product name or use an expiring
Actions-artifact URL as the update feed. Nothing is published or purchased by default.
