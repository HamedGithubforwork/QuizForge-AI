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
paid request. After supplying the missing secret, use a fresh reviewed trigger
on this draft branch to complete the still-unused one-request authorization.
The optional manual dispatch, where available, requires `run_live=true`.
Inspect prior evidence first: any second paid attempt requires a new explicit
decision to spend. Do not repeatedly run this fixture to reset the monthly budget.

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
counts; neither measures real model speed or cost. Output quality from a real
model and the real remaining token-cost balance are still untested.

Next action: add `OPENAI_API_KEY` as a repository Actions secret at
[QuizForge-AI secret settings](https://github.com/HamedGithubforwork/QuizForge-AI/settings/secrets/actions).
Supply the key through that secret form; do not post its value in the chat.
Afterward, a fresh trigger can use the existing authorization for one live quiz.
Both application and permanent-infrastructure PRs remain draft and unmerged.
