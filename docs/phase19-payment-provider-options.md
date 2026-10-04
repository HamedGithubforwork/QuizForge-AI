# Phase 19 payment-provider options

Status: provider-selection prerequisite only. This document does **not** create a
merchant account, production credential, checkout, purchase, entitlement grant,
database migration, or Store submission.

Reviewed: 2026-10-04.

## Product need

QuizForge needs one provider path for the optional lifetime Ad-Free purchase.
The purchase removes ads only; it does not grant unlimited GPT Cloud use.

The product already keeps entitlement semantics separate from provider details.
Any selected provider should therefore be an acquisition/fulfillment adapter
behind the account entitlement boundary, not a product-domain dependency.

## Shortlist

### Paddle

Current official documentation supports one-time digital products and describes
Paddle as Merchant of Record. One-time purchases can be fulfilled from a
`transaction.completed` webhook. Paddle provides a sandbox account for testing.

Published pay-as-you-go pricing at review time: **5% + 50¢ per Checkout
transaction**.

Engineering advantages:

- Merchant of Record model handles sales tax/VAT/GST collection and remittance.
- Purpose-built support for software/digital products and one-time purchases.
- Sandbox is available before a live seller account is required.
- Webhook-based fulfillment maps cleanly to QuizForge's server-authoritative
  entitlement boundary.
- Checkout can stay outside study-domain code.

Sources:
https://developer.paddle.com/get-started/how-paddle-works/digital-products/
https://developer.paddle.com/get-started/quickstart/
https://www.paddle.com/pricing
https://developer.paddle.com/concepts/sell/supported-countries-locales/

### Lemon Squeezy

Lemon Squeezy supports single-payment digital products and acts as Merchant of
Record, including tax collection/compliance.

Published base pricing at review time: **5% + 50¢ per transaction**, with some
payments potentially subject to additional fees.

Engineering advantages:

- Simple one-time digital-product model.
- Merchant of Record reduces tax-compliance burden.
- Provider details can remain behind the same QuizForge entitlement adapter.

Sources:
https://docs.lemonsqueezy.com/help/products/single-payment
https://www.lemonsqueezy.com/pricing

### Stripe Payments / Checkout

Stripe Checkout supports one-time payments. Standard Canadian card pricing at
review time is published as **2.9% + CA$0.30 per successful domestic-card
transaction**.

Standard Stripe Payments is the lower published processing-cost option in this
shortlist, but the business remains responsible for the merchant/tax/compliance
work that a Merchant of Record takes over. Stripe also advertises a separate
Managed Payments Merchant-of-Record product with an additional published fee.

Engineering advantages:

- Mature hosted Checkout and webhook tooling.
- Lower published direct-processing fee for ordinary Canadian domestic-card
  transactions than the two 5% + 50¢ Merchant-of-Record options.
- Good fit if QuizForge later chooses to own the tax/compliance responsibilities
  or already has accounting infrastructure for them.

Sources:
https://stripe.com/en-ca/payments/checkout
https://stripe.com/en-ca/pricing

## Microsoft Store compatibility checkpoint

Microsoft Store policy version 7.20 was published on 2026-09-15 and has an
effective date of **2026-10-22**.

The published 7.20 text says non-game products on PC may use either a secure
third-party purchase API or the Microsoft Store in-product purchase API for
digital items/services used within the product. It also requires an allowed
third-party purchase flow to identify the commerce provider, authenticate the
user, obtain user confirmation, and be declared in Partner Center.

Removal of advertising is explicitly treated as a digital good/service in the
financial-transaction section.

This makes a provider-neutral third-party purchase adapter compatible in
principle with the published PC non-game policy, but the then-effective policy
must be checked again immediately before Store submission.

Source:
https://learn.microsoft.com/en-us/windows/apps/publish/store-policies

## Provisional engineering recommendation

For the current solo/early-stage QuizForge situation, **Paddle sandbox is the
preferred first integration candidate** for lifetime Ad-Free.

Reasoning:

- The lifetime purchase is a digital one-time product, which Paddle supports
  directly.
- Merchant-of-Record handling removes a large amount of tax/VAT/GST and
  transaction-compliance work from the application owner.
- The webhook fulfillment model fits the existing server-authoritative
  entitlement architecture.
- The sandbox lets the implementation and idempotency/reconciliation path be
  proved without a live sale.
- The provider-neutral entitlement and ad-policy boundaries mean this choice can
  later be replaced without rewriting study/review/Local AI code.

This is a **provisional engineering recommendation, not authorization to open or
verify a live seller account or accept real payments**.

Stripe remains the margin-optimized alternative if the business deliberately
chooses to own tax/compliance responsibilities. Lemon Squeezy remains a valid
Merchant-of-Record alternative if its onboarding/product terms are preferred.

## Required implementation sequence after provider approval

1. Use the provider's sandbox/test environment only.
2. Add a server-side provider adapter; no provider secret enters the renderer or
   desktop package.
3. Create checkout only for an authenticated QuizForge account.
4. Bind the purchase to an internal account/user identifier through trusted
   server-side metadata or a server-created transaction.
5. Verify webhook signatures/authenticity before any entitlement change.
6. Make fulfillment idempotent against provider transaction/event identifiers.
7. Record enough provider reference data for reconciliation/refunds without
   storing card/payment details.
8. Grant the semantic lifetime Ad-Free entitlement only after the provider's
   completed/paid event has been verified.
9. Define and test refund/reversal/restoration behavior before live sales.
10. Keep study functionality usable when checkout/provider services are down.
11. Recheck current provider terms, privacy requirements, taxes, and Microsoft
    Store policy immediately before production activation.

## Explicitly deferred

- Live Paddle/Lemon Squeezy/Stripe account creation or verification.
- API keys or webhook secrets.
- A real price or currency decision.
- Production checkout.
- Production database migration/application.
- Real entitlement grants.
- Refunds against real transactions.
- Microsoft Store submission.
- Mobile App Store / Google Play billing decisions.
