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

An authorized push is restricted to the exact commit message recorded in the
workflow. Other pushes only run the simulation. Workflow reruns cannot make a
paid request. The owner supplied the missing key and the one-request
authorization was consumed by successful run 35571516905. Do not use the trigger
again without authorization for another paid attempt. The optional manual
dispatch, where available, requires `run_live=true`. Inspect prior evidence
first; do not repeatedly run this fixture to reset the monthly budget.

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

### Completed live test

After the owner added the key, configuration commit
`86ea61ac8c6c39f57cafcb542a02929194d2c318` passed
[CI run 35571516905](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35571516905/job/106243961513)
at 2026-09-21 07:09 UTC. The key was available and accepted by OpenAI.

| Measurement | Live result |
| --- | --- |
| Model | gpt-5.6-luna, standard tier |
| Quiz | Five easy multiple-choice questions from two synthetic pages |
| Generation and application validation | 6.72728 seconds |
| Real requests / retries | 1 / 0 |
| Input / output tokens | 634 / 370 (0 reported reasoning tokens) |
| Maximum reserved | USD0.5397456 |
| Conservative settled budget charge | USD0.0006025 (0.06025 US cents) |
| Unused reservation released | USD0.5391431 |
| Remaining isolated USD5 allowance | USD4.9993975 |
| Final state | Settlement verified; generation disabled; fixture removed |

The SDK parsed the compact schema, the application expanded and validated the
public quiz, and all five answers/explanations were manually checked against the
synthetic notes. All source-page citations were correct and no questions were
duplicates. Question 2's phrasing could be more direct, but its answer was
unambiguous and supported. This is one successful sample, not an average latency
or an evaluation of scanned documents, longer notes, mixed or short-answer modes.

At the reviewed standard uncached rates, reported tokens imply USD0.0005708
before any invoice adjustments. The enforced budget uses the higher conservative
USD0.0006025 value. Neither figure is a reconciled provider invoice.
Both retry-boundary tests and the real-database simulated rehearsal passed again.
The [saved live JSON](benchmarks/ai-live-canary-2026-09-21.json) includes the quiz,
notes, provider usage, accounting receipt, and quality review.

**Carry forward before launch:** September 2026 has one paid attempt and
602,500 nano-USD of conservative usage from this canary. Reconcile this receipt
once into the current-month production usage before enabling the gateway; do not
start September production with a fresh USD5 balance or count the receipt twice.
The production ledger has not been provisioned or updated. The current remainder
only covers this tracked attempt; reconcile any other provider usage separately.

This completes isolated live-provider acceptance for this sample. Permanent AWS
capacity with backups, real restore and alarm delivery, final-domain HTTPS/auth
and recovery, migration reconciliation, and launch approval remain outstanding.
Both application and permanent-infrastructure PRs remain draft and unmerged.

### Initial attempt: missing secret

Configuration commit: `1d2512b5cc1714bb73c1b406cd866b10b9f2b776`.
[CI run 35570683603](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35570683603/job/106241479995)
completed on 2026-09-21 with these results:

- Both compact-parsing and application-retry-boundary tests passed.
- The simulated provider integration passed against real TLS PostgreSQL: one
  request, validated five-question public quiz, committed reservation, verified
  settlement, and policy disabled at completion.
- The live step stopped before contacting OpenAI because the `OPENAI_API_KEY`
  secret was unavailable. **Zero paid model requests; actual test spend USD0.**
- The overall workflow is failed because the requested live check is blocked.
  It must not be treated as a successful live-model acceptance test.

The [saved JSON evidence](benchmarks/ai-canary-2026-09-21.json) clearly separates
simulation values from the blocked live attempt. The simulated 1.776-second
duration and USD0.00146 settlement are harness results using invented token
counts; neither measures real model speed or cost. The missing-secret blocker
was resolved by the successful live test above.
