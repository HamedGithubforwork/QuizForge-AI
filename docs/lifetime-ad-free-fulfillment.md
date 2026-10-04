# Lifetime Ad-Free fulfillment contract

Status: provider-neutral Phase 19 contract. No provider webhook endpoint,
production database migration, checkout, or entitlement activation is introduced
by this document.

## Purpose

A real lifetime Ad-Free purchase eventually needs a safe bridge between a
verified commerce event and the semantic account entitlement already exposed by
QuizForge.

The provider adapter and persistence layer must remain separate from the
fulfillment decision.

## Normalized event boundary

A verified provider adapter may normalize only these facts for the fulfillment
layer:

- provider identifier;
- provider event identifier;
- provider transaction identifier;
- bound QuizForge user identifier;
- event kind: completed, refunded, or reversed.

Provider-specific payloads, signatures, card details, buyer addresses, raw
webhook bodies, and SDK objects stay outside this domain contract.

The adapter must verify the provider webhook signature/authenticity **before**
constructing a normalized event.

## Idempotency and atomicity

The persistence implementation must make the provider event identifier unique
within the provider namespace.

A provider event is either:

1. already processed, in which case fulfillment is a strict no-op; or
2. applied to the account purchase-source state and marked processed in the same
   database transaction.

Never mark an event processed in a separate successful transaction before the
purchase-source/entitlement update.

Never grant from a browser callback, redirect query parameter, renderer message,
or unverified webhook.

## Multi-source ownership

Lifetime Ad-Free is derived from the set of active verified purchase sources for
the account rather than trusting one mutable "current transaction" field.

This matters for cross-platform and duplicate-purchase safety:

- the first active completed purchase transitions the account from free to
  entitled;
- another independently paid transaction is recorded as an additional active
  source without double-granting the semantic entitlement;
- refunding/reversing one source removes only that source;
- lifetime Ad-Free is revoked only when no active verified purchase source
  remains.

This prevents a refund of one transaction from incorrectly removing access that
is still backed by another valid purchase.

## Refund and reversal behavior

A refund or reversal affects only the matching provider + transaction source.

An unrelated provider/transaction cannot revoke the user's current ownership.

A refund/reversal for a source that is already inactive is a safe retain/no-op
for entitlement but should still be recorded as processed.

## Account isolation

The normalized event user identifier must match the entitlement record owner.
Cross-account events fail closed rather than being silently redirected.

The provider adapter must bind checkout creation to an authenticated QuizForge
account using server-controlled metadata/reference fields. Client-provided user
identifiers are never trusted as entitlement authority.

Identifiers are expected to arrive already normalized. Whitespace-mutated or
empty identifiers fail closed.

## Persistence still required before activation

The current pure decision contract deliberately does not choose a database
schema. Before real purchases are enabled, persistence must provide:

- account-scoped active purchase sources keyed by provider + transaction;
- a semantic lifetime Ad-Free read path derived from those sources or updated
  atomically with them;
- a unique processed-event ledger keyed by provider + event identifier;
- atomic event-ledger + purchase-source/entitlement updates;
- reconciliation lookup by provider transaction;
- migration/equivalence tests;
- backup/restore behavior.

No production schema change is authorized by this contract.
