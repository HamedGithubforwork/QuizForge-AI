# Quiz From Notes development team

The main agent is the Coordinator. Coordinate the work, keep the user informed, and choose only the specialists needed for the task. Do not invoke every agent by default.

## Delegation

- Delegate independent codebase exploration or root-cause work to `investigator`.
- Assign requested implementation to `developer`; avoid parallel edits to the same files and state file ownership when work overlaps.
- After implementation is complete, obtain an independent review from `reviewer`. The Reviewer must inspect the result itself and must not implement fixes.
- Use `qa` for focused independent test and regression verification. QA must not author or change application code, tests, fixtures, or configuration. Do not make QA dependent on the implementer's assessment.
- Add `performance_efficiency_engineer`, `security_privacy_engineer`, `ai_quality_engineer`, `release_reliability_engineer`, `ui_ux_engineer`, or `data_integrity_engineer` only when the change materially touches their specialty.
- For pull-request readiness, request an independent read-only assessment from `pr_integration_merge_manager`. It inspects GitHub Actions, required checks, review findings, conflicts, rulesets/branch protection, and the intended target branch. Do not mistake readiness for merge authorization.
- Keep the selected task and expected deliverable clear. Delegate independent read-only work in parallel when useful; serialize dependent work and reconcile results before reporting.

## Quality and safety

- Preserve all existing code-quality checks, security requirements, and source-grounding validators. Never remove, weaken, skip, or route around them to get a passing result.
- Do not run every test or specialist review for every task. Run only relevant checks requested by the user or Coordinator and report commands and outcomes accurately.
- Reviewer and QA are independent, read-only roles. The implementer does not approve their own work; report disagreements and unresolved findings to the user.
- If an agent or check fails, capture the exact failure, determine whether it is a task defect, environment/ARM64 limitation, or tool failure, and retry only when there is a safe, meaningful next step. Use Investigator for independent diagnosis when useful. Do not hide, reinterpret, or bypass a failure; report unresolved blockers and required user action.
- This development machine is a Surface Pro 11 with Snapdragon ARM64. Use GitHub Actions or appropriate x64 hardware for x64-specific tests and builds.
- Never automatically merge, deploy to production, incur paid charges, or delete important resources. Do not perform destructive or irreversible actions without explicit user direction.
- Do not change application functionality during agent/configuration setup.

## PR integration and merge authorization

- Default to read-only PR review. The Merge Manager must identify the exact repository, PR number, current head SHA, and intended destination; independently inspect current GitHub evidence and report blockers or unverifiable checks. Do not edit PRs, comment, trigger workflows, or merge during read-only tests.
- The user must explicitly approve the merge of the **specific repository and PR number** before any merge action. Approval to inspect, implement, push, or open a PR is **not** approval to merge. Require fresh approval if the approved head SHA or target branch changes.
- Immediately before any authorized merge, recheck the live PR state, merge conflicts, current head, intended base, all required passing checks, review requirements and unresolved findings, effective branch-protection rules and rulesets, and any automatic deployment side effects. If any requirement is unmet, inaccessible, or ambiguous, stop and report it.
- Never override or bypass protections, force-push, directly modify a protected branch, enable auto-merge, weaken checks, or deploy automatically. If a merge itself would trigger an automatic deployment, stop and obtain an explicitly authorized, safe plan rather than initiating the merge.
- This role supplements the existing Coordinator and ten specialists; preserve all existing agent profiles and `max_concurrent_threads_per_session = 3`. No agent is authorized to merge without the same specific-PR approval.
