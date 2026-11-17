# GitHub-native merge architecture — approved design, not activated

The owner approved **design and implementation** of GitHub-enforced reviews/checks as an alternative to unauthenticated Codex-invocation claims. This does **not** authorize a merge, standing-policy activation, GitHub repository transfer, merge-queue/ruleset change, new credentials, or deployment.

## Intended trust model

1. Codex agents may develop and review a PR. Their session and checkpoint claims remain advisory; they are not merge authorization.
2. A trusted evaluator must independently fetch GitHub checks and formal reviews from protected, owner-approved policy code. Only results emitted by configured trustworthy applications are eligible evidence. Candidate PR code or changed workflows may not approve themselves.
3. The trusted evaluator needs complete, paginated files/diff evidence, conservative semantic risk classification, and rejection of authentication, secrets, permissions, security, infrastructure, migration, deployment, billing, cloud spending, CI, and policy changes.
4. A separately approved, least-privilege executor would only submit future eligible PRs to an **enforced, tested merge queue**. Merge-group integration checks must pass. Required checks alone are not an atomic target/base guard.
5. Immediately before privileged queue admission, the evaluator must re-check authorization, revocation, repository identity, PR target/head/base, risk, checks, formal reviews, protections, and side effects. Missing, stale, changing, or unknown evidence blocks.
6. High-risk PRs always require a separately authorized supervised manual integration.

This changes the assurance: **independently verified GitHub checks and formal reviews**, not attested execution of Codex specialists. The old agent team can remain a development/review tool.

## First implemented component

`scripts/autonomy/github-native-preflight.cjs` is a **read-only** GitHub API preflight for the currently personal-account-owned public repository. It pins current numeric repository and owner IDs, ruleset, check issuer (GitHub Actions), and CI workflow identity. It checks:

- Open, non-draft, mergeable PR targeting protected `main` at the exact current base SHA
- GitHub-associated PR head and a successful `Required PR gate` check from the expected GitHub Actions app
- The matching successful CI workflow run, check-suite ID, and the run's own PR association for the exact PR number, head SHA, `main` target, and base SHA
- Active strict protection and lack of ruleset bypass actors
- Merge-queue rule presence and final re-read of PR/main/repository/ruleset, Required PR gate, and workflow-run state

The preflight requires no privileged GitHub token and performs **no writes**. A successful result is labeled `OBSERVATION_ONLY`; it is not a durable attestation and never outputs merge authorization. Mocked `read` calls are strictly a test seam, not trusted evidence. A future privileged implementation must execute reviewed policy code from a protected revision and never from an untrusted candidate PR.

Main currently does **not** enforce a merge queue, so real preflight checks must fail closed with `merge_queue_not_enforced` or another unmet prerequisite. Merely finding a queue rule will not prove successful real merge-group execution.

The new module is **not wired to the standing policy evaluator**. Its unconditional `trusted_live_verification_unavailable` hard stop and disabled policy remain unchanged.

## Still unimplemented and separately gated

- Full diff/risk/side-effect validation, authenticated independent QA/security checks, formal review and unresolved-thread evaluation
- All effective inherited organization rulesets and trusted privileged runtime
- Actual queue enforcement and successful `merge_group` integration evidence
- Limited queue-admission executor, precise target binding, safe post-merge reconciliation, owner policy activation
- Organization transfer and AWS OIDC read-back/migration

The pinned owner/ruleset/workflow identity must be revisited through an independently reviewed change after any future authorized repository transfer. Never silently relax the identity checks.
