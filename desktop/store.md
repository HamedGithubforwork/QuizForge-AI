# Private Microsoft Store release

The owner selected Microsoft Store distribution, initially available only to the
owner's personal Microsoft account. Store-distributed MSIX/AppX packages receive
Microsoft signing and Store-managed updates. The pinned electron-builder 26 version
calls this target `appx`; it is accepted by this Store packaging route. This is a
preparation profile, not a published app or a certification-ready submission.

## Account and identity (owner action)

1. Register at https://storedeveloper.microsoft.com/ using the owner's account and
   complete Microsoft's identity verification. Individual registration is free.
   Do not buy Artifact Signing for this route.
2. Reserve **Quiz From Notes** if available. If unavailable, ask the owner for the
   alternative name; do not invent a public product identity.
3. Under **Product management → Product identity**, collect the exact Package/Identity/Name,
   Package/Identity/Publisher, Package/Properties/PublisherDisplayName and reserved
   display name. These are public identifiers, not a password or signing key.
4. In the first submission's **Pricing and availability → Visibility → Audience**,
   explicitly choose **Private audience** and add only the owner's confirmed personal
   Microsoft-account email to a known user group. Work/school accounts do not qualify
   as tester accounts. Do not guess the email from repository commit metadata.
5. Leave **Make this product public on** unset. A hidden/direct-link public listing
   is not private. Switching to Public audience requires separate owner authorization;
   Microsoft does not permit switching that product back to Private audience.

## Build on Windows

Install the pinned dependencies with `npm ci`. Set these environment variables to
the exact values from Product identity, then run `npm run pack:store`:

| Variable | Partner Center value |
| --- | --- |
| `QFN_STORE_IDENTITY_NAME` | Package/Identity/Name |
| `QFN_STORE_PUBLISHER` | Package/Identity/Publisher (including `CN=`) |
| `QFN_STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName |
| `QFN_STORE_DISPLAY_NAME` | Reserved display name |

The profile refuses missing or unsupported identity values rather than inventing
them. If a real value is rejected, review and extend validation; never change the
Microsoft-assigned identity to fit the validator. Output is `dist/store/*.appx`.
No upload runs, no certificate is requested, and no external updater feed is embedded.
Do not feed this package to the NSIS signed-build/draft-release scripts.

The manifest declares the existing sign-in URI protocol, outbound internet access
and Electron's required `runFullTrust`; no startup task or new renderer permissions.
In a packaged Store process, the Help menu explains that Microsoft Store manages
updates. The NSIS updater is never initialized, even if an external feed is present.

## Verification and submission still required

CI builds an **unsigned synthetic-identity fixture** on real Windows and inspects
its manifest, callback protocol, version, capabilities and lack of external update
metadata. It neither installs nor uploads that fixture. Node tests exercise both
Store and EXE main-process paths, including sign-in and the updater boundary.
These checks do not prove installed MSIX behavior or Store certification.

After the actual identity is available:

- Replace sample Store tile assets with reviewed product artwork, prepare screenshots,
  description, support/privacy links and truthful age-rating answers. Explain the
  `runFullTrust` capability for the Electron desktop app. Supply a restricted test
  account through Microsoft's certification channel if required; never commit it.
- Build a reviewed commit with the real identity and run Windows package validation.
  Verify installation, launch, hosted study, native cold/warm sign-in callbacks,
  cancellation and uninstall. Existing EXE sign-in acceptance does not prove MSIX
  callback behavior. Check coexistence/protocol selection with the old preview.
- Confirm Private audience and no public-release schedule before submitting. Store
  certification still applies. Do not claim the app is available until approved.
- Install the approved Store version once, then submit a higher package version to
  that same private audience and verify Store-delivered updates, preserved study
  data and the ability to sign in. The current EXE cannot switch to Store delivery
  through its updater. Keep account-backed decks; do not delete preview data or
  silently migrate any local data. A fresh sign-in may be needed.

Source guidance:
- https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options
- https://www.electron.build/v26/docs/appx/
- https://www.electronjs.org/docs/latest/api/process#processwindowsstore-readonly

Existing web/API production deployment and the direct-EXE signing gate are unchanged.
