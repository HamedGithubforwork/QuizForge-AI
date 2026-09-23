# September 21 launch-test follow-up

Permanent launch is **not yet ready**. This follows the earlier
[18:36 acceptance snapshot](lightsail-acceptance-2026-09-21.md). The application
remains `807a4084237f6db544620cdb8322108ebf52251c`; the stack fixture uses
`62e39f33d715cc83928390cfd5ff1728008c4053` (documentation-only changes since the
previous runtime configuration). PR127 and PR155 remain draft and unmerged.
No permanent host, public routing or user-data migration was activated.

## Active AWS budget

The approved USD20 monthly account-wide budget is now present. Its accounting
settings, actual thresholds above USD10/16/20, forecast threshold above USD20 and
all four private email subscribers passed read-only verification in
[run 35646730802](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35646730802),
job 106488959866. The initial create succeeded, but the verifier rejected AWS's
omitted optional percentage type; subsequent diagnostics and a focused
regression test corrected that read-back handling. No duplicate or replacement
budget was created. There is no spending-stop action and inbox delivery is not
claimed.

The recipient remains a private repository secret and is omitted from this
public evidence. Before permanent Terraform apply, import the existing fixed
budget into the selected Lightsail state; retain direct email until a future SNS
subscription and delivery test pass. The separate USD5 model allowance remains
prepared, with generation disabled pending launch reconciliation.

## Authentication

[Run 35645380916](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35645380916)
reproduced the intermittent failure in job 106485623532. Exact observations were:
authorization requested, callback received without a provider error, no token
POST observed, and the browser still at `/auth/callback`. The earlier broad
`mapped: mandatory TOTP` label was insufficient to locate its own failure and has
been corrected in the historical evidence. Cleanup job 106486851549 verified all
temporary auth resources absent.

The test harness used a Vite development server. It now builds and serves the
unchanged application's assets, matching deployment rather than using development
dependency optimization/HMR. The built-asset test
[35647077853](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35647077853),
job 106491096573, passed initial login, TOTP, PKCE/nonce, backend JWT/GetUser,
history CRUD and owner isolation, one-use enrollment and unverified-email denial,
then **three** strict logout/password/TOTP cycles with protected history HTTP200.
Provider cookies were cleared, fresh tokens were revoked, and tokens stayed out
of browser storage. No application auth assertion or security control was relaxed.
Cleanup job **106492608055** independently verified the pool, users, clients,
domain, Lambda, role, logs and recovery parameters absent.

This is evidence of a passing built-asset rehearsal, not proof of the precise
cause of the development-server failure. Final-domain and production-pool auth
acceptance remain required.

## Current-stack load measurement

The new harness boots API, identity, generation guard, PostgreSQL, Redis and Caddy
with the planned individual limits and the actual 1536 MiB/no-swap aggregate
cgroup. It uses the application's isolated PDF worker on 30 deterministic scanned
pages, 400 synthetic history rows, repeated real database export/encryption, and
health requests through Caddy. A seventh temporary backup process is limited to
256 MiB. Its test CPU limit is 0.5 CPU versus the proposed production backup's
0.25 CPU; this is extra concurrent CPU pressure, not a measurement of the exact
scheduled backup's duration. AI stays disabled and no customer data is used.

CI [35646294016](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35646294016)
passed. The first actual 2 GB Canada Central measurement
[35646836888](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35646836888)
also recorded a passing workload:

| Measure | First actual-host result |
| --- | --- |
| 30 scanned pages | 29.35 seconds |
| OCR token precision / recall | 100% / 100% on this synthetic fixture |
| Encrypted export round trips | 15; largest archive 5,937,491 bytes |
| Health requests / failures | 168 / 0 |
| Health response p95 | 14.36 ms |
| Minimum host memory available | 712.7 MiB |
| Peak aggregate application memory | 778.0 MiB |
| OOM kills / unexpected restarts | 0 / 0 |

The overall workflow remained **failed** because the remote exit-status artifact
was missing. The authenticated SSH command completed successfully, the complete
workload report and final fixture PASS were retained, and instance deletion was
verified. A local reproduction demonstrated that a child inheriting the remote
`bash -s` input could consume the script's final status-writing commands. The fix
isolates child stdin; it does not waive the exit-status requirement. Preserve the
[first-run report](evidence/current-stack-35646836888.json) and its failed workflow
status alongside the corrected controller's subsequent verification.

The corrected run
[35648577830](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35648577830),
job **106495926233**, passed the entire workflow. Its retained remote exit code is
**0**, all six services remained running, and the controller independently
verified the temporary instance absent. The external deletion fallback remains
scheduled. No permanent instance was created.

| Measure | Corrected actual-host result |
| --- | --- |
| 30 scanned pages | 28.88 seconds |
| OCR token precision / recall | 100% / 100% on this synthetic fixture |
| Encrypted export round trips | 15; largest archive 5,937,491 bytes |
| Health requests / failures | 166 / 0 |
| Health response p95 | 13.36 ms |
| Minimum host memory available | 717.6 MiB |
| Peak aggregate application memory | 776.0 MiB |
| OOM kills / unexpected restarts | 0 / 0 |

The [corrected report](evidence/current-stack-35648577830.json) preserves the
measurements, controller identity, exit status and cleanup verification. These
are capacity observations, not a controlled before/after optimization comparison.

The test does not establish arbitrary user concurrency, exhausted CPU credits,
real document accuracy or full application-route latency. Synthetic local backup
encryption is not a real AWS S3 restore.

## Concrete remaining backup plan

Read-only [plan 35647550787](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35647550787),
job 106491644682, verified the exact retained resource names are absent and
prepared 13 Terraform creates with no updates, deletes or apply. These configure
one private versioned Canada Central backup bucket, ownership/encryption/lifecycle
and access rules, three unattached upload/recovery/health policies, one SNS topic
and email subscription, and one alarm that treats missing backup metrics as
breaching. The recipient matched the approved private setting. No host, DNS,
access key or policy attachment is part of this plan.

The existing backup preparation explicitly reserves retained-resource activation
for a separate review (`docs/lightsail-backup-automation.md`). Actual S3 versions,
a separately retained encryption key, separate uploader/recovery access, fresh
restore target, full rebuild timing and delivered failure/stale/missing-heartbeat
alerts still need that activation and a live rehearsal. The read-only plan is a
concrete proposal, not proof that backups or notifications are running.

Final production DNS/Caddy HTTPS, callback/logout origins, production-pool
signup/MFA/recovery, operator SSH public key and IPv4 /32, extra request ceilings,
image digests, and migration/rollback reconciliation remain launch gates. Carry
the previous single AI canary's one request and 602,500 nano-USD settlement into
September's launch ledger exactly once. No additional real model request was made
in these tests.
