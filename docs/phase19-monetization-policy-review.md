# Phase 19 monetization policy review

Status: engineering prerequisite for Phase 19. This document records current
distribution/provider constraints before QuizForge implements ads or a lifetime
ad-free entitlement. It does **not** select or activate an ad network, payment
provider, billing flow, Store submission, or public monetization.

Reviewed: 2026-10-04.

## Product intent

Phase 19 keeps the core Local AI/study tier usable without recurring cloud-AI
costs, may support that free tier with ads on appropriate surfaces, and adds an
optional one-time lifetime Ad-Free entitlement.

The lifetime purchase must remove ads only. It must not promise unlimited GPT
Cloud use because cloud inference has recurring per-use cost. GPT Cloud billing
and usage allowances remain Phase 20 work.

Ads must stay out of focus-critical study interactions, including active review,
timed exam flows, and answer-reveal interactions. Prefer library/home/results
surfaces where the placement does not compete with study controls.

## Current provider findings

### Google AdSense: web only for our purposes

Google's AdSense ad-placement policy currently says publishers may not distribute
Google ads or AdSense for Search through software applications, including desktop
applications. It states that AdSense code may only be implemented on web-based
pages and approved WebView technologies.

Source:
https://support.google.com/adsense/answer/1346295?hl=en

Engineering consequence:

- A normal QuizForge browser page may be evaluated for AdSense separately.
- Do **not** assume that the same AdSense unit can be shown inside the Electron
  desktop application merely because Electron renders hosted web content.
- Any future web ad integration must have an explicit native-shell suppression
  gate unless Google has expressly approved the exact desktop/WebView use case.
- Do not weaken this boundary with user-agent-only checks that can drift. Keep the
  application environment signal authoritative where practical.

### Google AdMob: mobile path, not the Windows desktop answer

Google's current AdMob setup and implementation documentation exposes Android
and iOS app platforms, with implementation guidance for Android/iOS (and some
documentation also references Unity). It does not establish a supported Windows
Electron integration.

Sources:
https://support.google.com/admob/answer/9989980?hl=en
https://support.google.com/admob/answer/7356427?hl=en

Engineering consequence:

- AdMob is a candidate to evaluate later for Android/iOS Phase 22 work.
- Do not select AdMob as the Windows Electron ad provider based only on its mobile
  app support.
- A Windows desktop ad provider, if one is used, requires a separate provider
  terms/SDK/privacy/security review.

## Microsoft Store constraints

Microsoft Store policy version 7.19 is the currently effective baseline at this
review date. Microsoft has already published version 7.20 with an effective date
of 2026-10-22, so Store/payment/ad requirements must be rechecked against the
effective policy at implementation and again before submission.

Current policy/change-history sources:
https://learn.microsoft.com/en-us/windows/apps/publish/store-policies-change-history
https://learn.microsoft.com/en-us/windows/apps/publish/store-policies-and-code-of-conduct

Relevant engineering points:

- Microsoft policy permits advertising but requires the product's primary purpose
  not to be ad clicks and ads to be clearly distinguishable from product content.
- For non-game products on PC, current policy permits qualifying in-product
  digital purchases through the Microsoft purchase API or, where policy allows,
  a secure third-party purchase API. The exact rules vary by purchase type and
  policy version.
- Therefore the lifetime Ad-Free entitlement must not be coupled to a payment
  provider until the direct-download and Microsoft Store distribution paths are
  checked against the then-effective rules.
- Microsoft Store work remains deferred by owner decision. This review does not
  resume Partner Center enrollment, Store submission, or paid signing.

## Required architecture boundary before monetization activation

When Phase 19 implementation begins, keep three decisions separate:

1. **Entitlement authority**
   - One account-level semantic entitlement such as lifetime ad-free ownership.
   - Server-authoritative acquisition/ownership state where account-backed use is
     expected across web and desktop.
   - A bounded local cache/offline grace policy may mirror that entitlement, but
     local state must not mint ownership.

2. **Ad presentation policy**
   - Decide whether an ad may appear from product surface + runtime/distribution
     environment + entitlement.
   - Ad-free ownership suppresses all ad-provider calls, not just ad rendering.
   - Focus-critical study surfaces remain ad-free regardless of entitlement.
   - Browser and desktop policies may differ because provider terms differ.

3. **Provider adapters**
   - Web ad provider, future mobile ad provider, and any future Windows desktop
     provider are separate adapters behind the presentation policy.
   - Payment provider/store billing adapters sit behind the entitlement boundary.
   - Do not let ad SDK or payment-provider types leak into deck/review/Local AI
     domain code.

This preserves future web, direct Windows, Microsoft Store, Android, and iOS
distribution without making one provider the product contract.

## Privacy, security, and reliability requirements

Before enabling ads or purchases:

- Document exactly what data an ad/payment provider receives.
- Update the privacy disclosure/consent path as legally and contractually needed.
- Never send PDF text, quiz answers, generated questions, deck contents, Local AI
  prompts, bearer tokens, model paths, or unrelated study history to an ad
  provider.
- Keep provider secrets server-side. No payment secret or cloud provider secret
  belongs in the desktop renderer.
- Validate webhook/event authenticity before granting an entitlement.
- Make purchase fulfillment idempotent so retries cannot duplicate or revoke
  ownership incorrectly.
- Store provider transaction references needed for reconciliation, but avoid
  retaining unnecessary payment data.
- Define refund/reversal/restoration behavior before launch.
- Preserve core study and Local AI use if an ad service or billing service is
  unavailable.
- Add observability for entitlement/ad-provider failures without logging sensitive
  payment or study content.

## Provider-selection gate

No ad or payment provider is selected by this document.

Before selecting one, verify from current authoritative documentation:

- supported distribution environments (browser, Windows desktop, Store, Android,
  iOS);
- whether Electron/WebView use is expressly permitted;
- SDK maintenance and security posture;
- Canadian and intended-market privacy/consent requirements;
- age/child-directed restrictions if applicable;
- fees/revenue share and payout constraints;
- one-time purchase, refund, restore, and cross-platform entitlement support;
- Microsoft/Apple/Google store rules effective on the implementation/submission
  date;
- ability to test with sandbox/test ads or test payments without real charges.

Do not add a dependency or production credential merely to prototype provider
selection.

## Phase 19 implementation sequence

After Phase 18 closes:

1. Add/test the provider-neutral account entitlement contract for lifetime
   ad-free ownership, without activating real billing.
2. Add/test a pure ad-presentation policy that explicitly excludes focus-critical
   surfaces and suppresses ads for ad-free users.
3. Add a browser-only ad-provider adapter only after provider approval/terms are
   confirmed; ensure the native desktop shell suppresses it by default.
4. Add the selected one-time purchase adapter only after the payment/distribution
   decision is reviewed.
5. Add webhook/reconciliation/idempotency/refund/restore tests before real
   entitlement activation.
6. Run browser and real-desktop acceptance proving ad suppression on forbidden
   surfaces and for ad-free accounts.
7. Recheck then-effective Microsoft Store rules before any Store monetization
   work is resumed.

## Non-goals of this review

- No advertisements are added.
- No ad SDK is added.
- No payment SDK/provider is selected or added.
- No billing account is created.
- No production database/schema change is made.
- No entitlement is activated.
- No price is chosen.
- No Store enrollment/submission is resumed.
- No signing purchase or other paid service is authorized.
- No GPT Cloud subscription behavior is changed.
