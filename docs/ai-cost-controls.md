# USD5 monthly AI control — prepared, inactive

The owner approved USD5/month for model usage, separately from the USD20 AWS
alert budget. The private recipient/settings file and public release template
record those decisions. No production resources or production model calls are
enabled. One isolated live canary passed on September 21; its conservative charge
of USD0.0006025 must be carried into September launch accounting.

## What is enforced

The gateway commits one PostgreSQL reservation before each `/v1/responses`
call. Request counters and money share an atomic lock/transaction; all gateway
processes use the same ledger. Each retry is a new attempt. The monthly balance
includes both settled costs and outstanding maximum reservations. A request
that would take this balance above USD5 is rejected before the provider is
contacted. Amounts are integer nano-USD, avoiding floating-point rounding.

The ledger uses UTC calendar months at admission time. Starting a new day does
not reset monthly usage. A new month gets a new allowance; a late settlement
adjusts the original month. Restarts preserve balances. Runtime roles cannot
edit policy or clear the ledger, and the legacy zero-argument request function
always refuses admission. Missing policy, expired/mismatched pricing, disabled
policy or database errors stop new calls.

Successful or incomplete responses with valid usage can release unused funds
exactly once. Timeouts, transport errors, missing/invalid usage, unexpected
models/tiers or settlement failures retain the maximum. Request counts are
never refunded. This can stop generation early, but avoids treating an uncertain
provider failure as free.

## Reviewed pricing and conservative reservation

Checked September 21, 2026: GPT-5.6 Luna standard rates per million tokens are
USD0.20 input, USD0.25 cache-write input, and USD1.20 output. Above 272,000 input
tokens the applicable maxima are USD0.50 cache-write input and USD1.80 output.
The documented context window is 1,050,000 tokens. Sources:
[model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[pricing](https://developers.openai.com/api/docs/pricing).

The gateway forces standard processing (`service_tier: default`), uses the global
OpenAI endpoint, permits text only, and rejects tools, prior conversations and
caller-selected tiers. It reserves the **entire documented input context** plus
the requested output maximum, capped at 8,192 tokens. Thus schema and internal
input overhead do not rely on a local tokenizer estimate. The maximum hold is
USD0.5397456 per attempt, not the expected price of a quiz. Once valid usage
arrives, the charge uses actual token counts at the conservative cache-write
rate; cache discounts are deliberately ignored. Output usage includes reasoning
tokens, which the output cap also covers:
[token accounting](https://developers.openai.com/api/docs/guides/token-counting).

This conservative first version may stop with roughly USD0.54 remaining; it
never starts a call on the assumption that its output will be shorter. Long
context/cache-write coverage and conservative settlement may also overcount
the provider invoice. The rate card expires on **October 21, 2026 (UTC)**. Before
activation or renewal, recheck the exact model, prices, context limit and tier,
then update/test the versioned card and policy together. Published prices can
change before expiry: this is a bounded application control under the reviewed
prices, not a guarantee about an external invoice. Taxes, other keys/projects,
AWS and any existing provider usage are outside this ledger. Use a dedicated
production provider project/key, and reconcile its usage before enabling it.

## Configuration and recovery

`release.example.json` contains `ai_monthly_budget_usd: 5`. The renderer accepts
zero through five dollars in whole cents and writes the allowance, pricing key
and expiry to `reviewed-ai-policy.sql` with `enabled=false`. Additional daily/
monthly attempt ceilings still need selection. The fresh bootstrap starts with
zero money and no reviewed pricing. Never enable the gateway before installing
the policy, checking its expiry and completing acceptance.

This changes the fresh database schema before launch; it is not an in-place
migration for an existing populated database. Backups include the monetary
policy, usage and outstanding/settled reservations. Restore requires a matching
schema and disables AI. Old-format schema fingerprints fail closed. Restoring a
stale backup can omit newer provider usage, so reconcile the current month with
the provider (or conservatively mark the remaining allowance exhausted) before
re-enabling. Never clear usage to resolve a budget error.

Attempt metadata retains current/prior month, with a 10,000-row ceiling matching
the backup limit. Older metadata can be pruned on admission; aggregate costs
remain counted. No prompts, documents, responses or provider keys enter the
ledger. The approved ceiling cannot be raised above USD5 through the renderer
or SQL policy constraint without a reviewed code/schema change.

## Tests without paid requests

The `USD5 reservations with a simulated provider` job starts disposable
PostgreSQL 17 and runs the actual reservation/settlement functions. Tests include
USD4.99 plus USD0.02 rejection, exact-limit acceptance, competing requests, a
fresh Python process reading persisted usage, timeouts/retries, once-only
settlement, month rollover and stale/missing policy. Handler tests replace the
provider connection, proving denied calls never contact it. Recovery CI verifies
encrypted round-trip preservation of the ledger with generation disabled.

Locally, with the locked operations dependencies installed:

```bash
PYTHONPATH=scripts/production:scripts/rds_rehearsal python -m unittest test_generation_costs test_lightsail_configuration -v
```

The database tests require the disposable CI database and must not be pointed
at production. Existing Compose CI exercises the real disabled gateway before
and after a service restart. The simulated tests do not measure live quiz quality,
latency or provider access.

## Completed isolated live provider check

The [September 21 live canary](ai-live-canary.md) passed through the exact
application candidate and real TLS budget database: one request, five validated
questions, 6.72728 seconds, 634 input/370 output tokens and verified settlement.
The budget charged USD0.0006025, leaving USD4.9993975 of the isolated starting
allowance; generation was then disabled. There were no automatic retries.
The token-based standard-price estimate is USD0.0005708; budget accounting
deliberately uses the higher rate and is not an invoice reconciliation.

Before September production activation, reconcile the saved receipt's single
attempt and **602,500 nano-USD** into the current-month usage exactly once.
The production database is not active and has not received this charge yet.
Do not reset the allowance or drop the canary cost when moving from the
disposable fixture to production. Real AWS/full-website acceptance remains.

The separate [before/after overhead benchmark](benchmarks/ai-budget-overhead-2026-09-21.md)
measured about 13–14 ms added median per AI call at concurrency one and 86–94 ms
under eight continuously active requests on a two-CPU CI fixture. It used real
TLS database operations and a simulated provider; these are not live Lightsail
or end-to-end quiz timings. Raw samples and conditions accompany the report.
