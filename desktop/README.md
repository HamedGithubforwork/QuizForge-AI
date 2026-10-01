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
- A connection failure offers Retry/Offline study/Close without logging URLs, codes or tokens.
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
4. Preview 0.1.6 supports opt-in offline deck browsing and answer-reveal practice.
   Due-card ratings persist locally and sync explicitly after reconnecting. Editing
   and generation require online functionality; do not claim full offline parity.
5. Add local inference behind an explicit provider boundary, hardware/model checks,
   and measured quality/latency tests. Keep cloud secrets server-side.

Do not mark Phase 16 complete or advertise an offline/local-AI desktop product
based on this foundation. Web releases still change the hosted UI independently
of the shell; the bundled offline reader is versioned with the installer.

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

Preview 0.1.6 connects this store to the verified native account through the
**Quiz From Notes → Save for offline study / Remove local study copy**
menu. Both actions require explicit confirmation and online enrolled-account
verification. Save fetches complete deck responses sequentially, validates them,
checks identity again, and atomically replaces only that account's copy. Any
incomplete collection leaves the old copy intact. Account changes during prompts,
fetches or encryption invalidate the operation. Save/remove cannot overlap.

Saving requires explicit consent that **anyone using the same Windows login can
open this copy after sign-out or restart without account sign-in**. Older copies
remain online-only until saved again with this consent. The encrypted envelope
records an optional strictly boolean offlineAccess marker; ordinary online-only
copies retain the previous shape. Old app versions cannot read opted-in copies.

Choose **Open offline study** (also offered when the hosted app cannot load), select
a library, and open decks/reveal answers in the bundled reader. It uses a separate
ephemeral sandbox with no preload, renderer JavaScript, permissions or network.
Dynamic content is escaped; CSP blocks scripts, requests, forms and frames. Native
HTML disclosures remain keyboard-accessible. Cloud generation, editing and account
operations stay in the online app. **Due-card ratings are saved encrypted locally**. Choose Again/Hard/Good/Easy
after revealing the answer. One rating is allowed per saved card until sync and a
fresh library download. Due dates and FSRS state are never locally rewritten.
Choose **Sync offline reviews** while signed in to the same account to apply ratings
using the original review times. Retries retain stable event IDs; lost responses
cannot count a rating twice. Server changes may cause conflicts. Unconfirmed
ratings remain on this computer, and pending ratings block a replacement download.
Removal explicitly warns that it discards unsynced ratings. After successful sync,
save a fresh copy to obtain current schedules. This requires the offline-review
API release; older servers leave events pending. No automatic background sync.

Copies include card content and source references, remain encrypted in the Windows
profile after sign-out, and are not portable backups or automatically refreshed.
Server decks are never changed; collection is not a server-wide transaction.
The offline picker can remove a selected opted-in copy without internet after a
second confirmation. Sign-out, account replacement and snapshot save/remove close
any open reader. Explicit offline reopening remains possible until the copy is
removed. No authentication tokens or purchase assertions are persisted.

Offline access is available during development. A future verified one-time purchase
entitlement will gate it; there is no payment bypass flag or fake entitlement.
Review replay needs a separate idempotent server contract before activation.
Windows CI saves and reopens synthetic OS-encrypted data in two separate processes,
with no online identity dependency, and exercises native answer-reveal interaction.

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

## Offline progress upgrade and verification

Preview 0.1.6 uses `study-snapshots-v2` for saved libraries and review events. It
imports validated v1 copies only when an account has no v2 copy, preserving the
original timestamp and opt-in marker. Older installers can neither read nor
overwrite v2 ratings; edits made with an older installer are not merged back.
Remove deletes the legacy fallback first and then v2, preventing resurrection.
Do not delete v2 data when rolling back an installer.

The reader still has no renderer JavaScript or preload. Rating links contain
random per-window commands; main-process navigation interception cancels every
navigation and accepts only current commands for due, unsuspended saved cards.
The store rechecks snapshot identity and allows one durable event per card.
Windows CI uses three separate Electron processes to save a library, reopen it
and click a rating, and verify that rating survived another restart. Unit tests
cover concurrent clicks, interrupted writes, replacement protection, account
changes, retry identity and v1 upgrade isolation. Purchase gating remains deferred.
