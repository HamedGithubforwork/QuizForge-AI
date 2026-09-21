# Controlled live AI quiz test

The owner authorized one live synthetic quiz test on 2026-09-21, within the
approved USD5 starting AI allowance. This does not authorize permanent AWS
provisioning, a merge, migration, production activation, or DNS changes.

`Single AI quiz canary` checks out application commit
`807a4084237f6db544620cdb8322108ebf52251c` and runs its actual
`generate_quiz_from_pages` function with five easy multiple-choice questions
from two short, synthetic networking pages. The real SDK serializes the compact
schema and the application expands and validates the returned public quiz.

The model transport goes through the current production budget guard and a fresh
TLS-verified PostgreSQL database, bound only to runner loopback. There is no user
database, document upload, browser session, AWS host, or public endpoint involved.
The provider is the global standard-tier Responses endpoint, using the reviewed
gpt-5.6-luna price card. The output cap is 8,192 tokens, including reasoning.
The conservative maximum reservation is **USD0.5397456**, not the expected cost.

SDK retries are disabled. An application adapter rejects a second parse request
before HTTP, a provider adapter rejects a second upstream send, and the SQL
policy permits only one request. Invalid output is reported without trying
another paid generation. A separate simulated run and two local boundary tests
precede the live step. Those checks make no paid API requests.

The API key comes only from the GitHub Actions repository secret
`OPENAI_API_KEY`. It is never committed, passed as a command-line value, or
included in the report. A missing secret blocks the live test. Set it through
the repository's Settings → Secrets and variables → Actions interface, not an
issue, PR comment, chat message, or source file.

The initial authorized push is restricted to the exact commit message recorded
in the workflow. Other pushes only run the simulation. Workflow reruns cannot
make a paid request. A future manually dispatched run requires selecting
`run_live=true` and a new explicit decision to spend; inspect existing evidence
before authorizing another attempt. Do not repeatedly run this fixture as a way
to reset the monthly budget.

Reports include synthetic quiz output, generation time, provider token usage,
reserved and settled amounts, the isolated remaining allowance, and whether the
policy was disabled at completion. The fixture database is then removed.
Copy a completed live receipt into the reviewed launch ledger before enabling
production so this test's accounted amount is deducted from the initial USD5.
The reported charge is the guard's conservative token accounting, not a
reconciled provider invoice. Any usage through other keys or applications is
outside this isolated ledger.

This is a functional integration and output-quality check, not a before/after
model-speed benchmark or a live Lightsail capacity test. Manually inspect the
answers against the included synthetic notes after structural validation passes.

## Evidence

Pending the first CI execution. Local checks already pass for compact quiz
parsing/expansion and suppression of an invalid-quiz regeneration attempt.
