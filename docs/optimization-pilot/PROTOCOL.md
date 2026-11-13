# Five-cycle autonomous optimization pilot

## Scope

Repository: `HamedGithubforwork/QuizForge-AI`

Base: `main`

Pilot branch: `pilot/qfn-five-cycle-optimization`

Starting commit: `50ced51d965bce0e7bde69b4b90b1cff383ee6d3`

The pilot may attempt no more than five cycles. Each cycle must address one focused opportunity, record a reproducible before measurement before changing product code, run relevant correctness and quality checks, and preserve the change only when the measured benefit is credible and no correctness, quality, security, or reliability regression appears.

## Cycle sequence

1. Coordinator assigns Investigator and Performance Engineer to find and rank a non-duplicative opportunity.
2. Record the exact baseline command, environment, fixture, samples, and quality results before implementation.
3. Developer makes one focused change on this branch.
4. Run the focused tests and repeat the same benchmark under comparable conditions.
5. Reviewer and QA independently inspect the change and evidence. Add AI Quality or Security review when the touched behavior warrants it.
6. Compare medians and tail latency, note sample count and noise, and preserve or revert the change. A timing-only improvement is not sufficient if relevant quality checks worsen.
7. Append outcome, evidence, and the next candidate to `PROGRESS.md` before beginning another cycle.

## Measurement and acceptance

- Prefer deterministic local fixtures, warmups, repeated samples, and the same machine/runtime for before and after.
- Treat differences within 5% as measurement noise unless repeated runs or a paired benchmark establish otherwise. A candidate timing improvement should exceed 10% on the primary metric, avoid a p95 regression greater than 5%, and pass all relevant regression tests. For small or noisy samples, report inconclusive rather than claiming a win.
- Record CPU/memory metrics only when the harness can measure them reliably; do not infer resource savings from elapsed time.
- Preserve question accuracy, uniqueness, source grounding, citations, and grading behavior. Any semantic change requires the relevant held-out/contract checks and AI Quality review.
- Keep model, prompt, runtime, fixtures, and source revision pinned for Qwen measurements. Do not treat an unmerged PR or a different runner as a comparable production baseline.

## Resource and safety limits

- Maximum five cycles; stop after two consecutive cycles with no meaningful measurable improvement.
- Maximum three concurrent subagents including the Coordinator.
- Prefer focused local checks. Use x64 Windows Actions only for tests that require the supported Windows/model/runtime stack. Do not run full mutation testing except at a major milestone.
- Do not start paid infrastructure, deploy, weaken safeguards, or modify production. Respect existing Actions and AWS budget protections.
- Do not duplicate or overwrite active optimization PRs. If required source, model, runtime, or measurement tooling is unavailable, record the blocker and move only to a clearly disjoint measurable opportunity; stop if no such opportunity exists.
- Commit validated changes incrementally on the pilot branch. Prepare a PR targeting `main`; do not merge it automatically.

## Stop and resume

Stop on a non-resolvable safety/correctness regression, unavailable required tooling with no safe disjoint cycle, a resource/approval boundary, or two consecutive non-improving cycles. `PROGRESS.md` is the resume checkpoint: update it after every baseline, implementation, review, or stop decision so another session can continue without repeating completed work.
