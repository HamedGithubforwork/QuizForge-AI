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
2. applied to the account entitlement and marked processed in the same database
   transaction.

Never mark an event processed in a separate successful transaction before the
entitlement update.

Never grant from a browser callback, redirect query parameter, renderer message,
or unverified webhook.

## Grant behavior

A verified completed purchase for a currently free account grants lifetime
Ad-Free and records the provider + transaction as the ownership source.

A repeated completed event for the same transaction is idempotent.

A different completed transaction received after lifetime ownership already
exists does not silently replace the original ownership source. Support/reconcile
the duplicate commerce transaction separately.

## Refund and reversal behavior

A refund or reversal revokes lifetime Ad-Free only when both provider and
transaction match the transaction that granted the current entitlement.

A refund for another provider/transaction cannot revoke the user's current
ownership.

A refund/reversal for an already-free account is a safe no-op but should still be
recorded as processed.

## Account isolation

The normalized event user identifier must match the entitlement record owner.
Cross-account events fail closed rather than being silently redirected.

The provider adapter must bind checkout creation to an authenticated QuizForge
account using server-controlled metadata/reference fields. Client-provided user
identifiers are never trusted as entitlement authority.

## Persistence still required before activation

The current pure decision contract deliberately does not choose a database
schema. Before real purchases are enabled, persistence must provide:

- account-level lifetime Ad-Free state;
- source provider and transaction identifier;
- a unique processed-event ledger;
- atomic event-ledger + entitlement updates;
- reconciliation lookup by provider transaction;
- migration/equivalence tests;
- backup/restore behavior.

No production schema change is authorized by this contract.
