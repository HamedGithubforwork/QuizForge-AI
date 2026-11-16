Warning: truncated output (original token count: 1760)
Total output lines: 50

# Local Qwen pilot progress

Updated: 2026-11-06

## Targeted diagnostic

- Workflow: [Local AI targeted-practice diagnostic, run #2](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42293627959)
- Workflow run ID: `42293627959`; workflow source was `main` at `aad0afeda769a6715f2ba8351294b61839ff5fe6`.
- Application source: `diagnostic/targeted-practice-stage-timing-20261103` (PR #664), exact SHA `fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`.
- The diagnostic setup, model checksum, runtime checksum, and source-SHA recording passed. The diagnostic failed at the targeted-practice quality gate and still uploaded its sanitized report.
- Run artifact: `local-ai-targeted-practice-diagnostic`, SHA-256 `2c04541180be833e3af2988a6ec3bd8ea870c0ffcff7cf21283c9924fa6df637` (three-day retention).
- Retrieved GitHub Actions artifact ID: `13540873823` (expires 2026-11-09 21:13 UTC). The saved diagnostics confirm aggregate timings and labels, but do not retain the raw/structural primary response, finish reason, or candidate-level rejection categories; the 18-token response cause therefore remains undetermined.
- Constraints honored: one Windows x64 CPU run, pinned Qwen3 4B Q4_K_M model and llama.cpp runtime, synthetic fixture only, 25-minute workflow timeout, no prompt/response/study content retained. No additional model run was started.

## Measurements

The warmup took **131.291 s** and passed its semantic oracle with five questions. Its generation response took 110.347 s (28.785 s prefill, 81.532 s decode; 759 prompt and 629 completion tokens). The artifact also has one unmatched warmup inference metric (16.812 s; 356 prompt and 6 completion tokens); its event type is not identified, so it is excluded from the generation-call count below.

Targeted practice took **338.625 s** and failed before producing a final quiz. Four generation calls were observed:

| Target stage | Elapsed interval | Inference elapsed | Prefill | Decode | Prompt → completion tokens | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Primary generation | 70.075 s | 64.797 s | 61.960 s | 2.815 s | 1,347 → 18 | Abstained; `insufficient_source` |
| Weak-area recovery | 107.369 s | 107.365 s | 22.586 s | 84.719 s | 604 → 560 | Five candidate questions; recovery continued |
| Retry 1 | 77.013 s | 77.008 s | 29.840 s | 47.084 s | 1,651 → 261 | Three candidate questions |
| Retry 2 | 83.940 s | 83.934 s | 34.463 s | 49.452 s | 1,768 → 267 | Three candidate questions; candidate pool exhausted |

Target generation totals: **4 calls**, **333.104 s** of measured inference (148.849 s prefill and 184.070 s decode), **5,370 prompt tokens**, and **1,106 completion tokens**. Prefill accounts for about 44.7% and decode 55.3% of measured inference time. The four call intervals sum to 338.397 s; the targeted-stage timer adds about 0.228 s beyond those intervals. Across warmup and target there were five generation-response callbacks and six raw inference metrics because of the unmatched warmup event.

## Quality and failure analysis

The target primary attempt was rejected with `insufficient_source`. The recovery path ended with `candidate_pool_exhausted`. Those were the o…160 tokens truncated… be treated as a target quality pass.

The observed failure path is: the primary abstained, weak-area recovery generated a candidate batch, two retries followed, and recovery exhausted its candidate pool. Recovery and the two retries consumed about **268.3 s** of the **338.6 s** targeted stage. This identifies a costly area, but not the exact bad candidate or a causal root beyond the reported validator categories.

## Comparison with PRs #664–#666

- **#664** adds privacy-safe timing only. Its rationale cites the #663 selected-pages product-acceptance case at 266.472 s versus 163.394 s for #653. Those product-acceptance totals are not directly comparable with this diagnostic's warmup and targeted-stage timers.
- **#665** proposes requesting only the missing number of validated replacement questions in the first recovery batch and allowing one backup in the existing second batch, while preserving source, answer, citation, and uniqueness validators.
- A prior completed diagnostic workflow run, [#42046508800](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42046508800), used #665's branch at SHA `85518cf6240836448ef331260d16ba2401d7bfa7`, not the requested #664 source. It completed targeted practice in 124.389 s with five semantically valid, distinct questions and passed prior-question avoidance. It is useful context, but it is not a substitute for this run's #664 baseline or a controlled comparison.
- The controlled #666 ABBA artifact ([run #41748544318](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/41748544318)) used the same Windows x64 CPU host class and pinned model. Both variants passed with five validated facts in each trial. Baseline (PR #664, SHA `fa78f594`) had a 101.349 s median, 129.243 s maximum, and three provider calls across two trials. Optimized (PR #665, pinned SHA `95b984a9`) had a 75.439 s median, 76.750 s maximum, and two provider calls across two trials. The 25.6% lower median and one fewer total call are encouraging for that fixture and small sample; they do **not** establish an improvement for this failed #664 diagnostic.

## Recommended next step

The most promising safe optimization to evaluate is #665's bounded minimal-replacement batching: ask for only missing validated replacements first and at most one backup in the existing second batch. The expected benefit is fewer redundant candidates and potentially fewer/shorter recovery calls; the #666 measurements support the direction, but the benefit for this failed diagnostic is unquantified. Keep every source-grounding, answer, citation, uniqueness, and prior-question validator unchanged.

Validation plan: review the #665 diff against #664 to confirm validators remain intact; run focused regression coverage for replacement counts and fail-closed behavior; then, only with fresh authorization, use the same bounded Windows x64 synthetic workflow and fixture on the candidate source. Compare call count, stage and prefill/decode timings, validation categories, semantic source-oracle result, answer correctness, uniqueness, and prior-question avoidance. Do not infer a speedup unless the candidate is implemented and measured under that plan.

## Follow-up diagnosis (2026-11-16)

- Current protected `main` is `d4055b045c93ba2722f0c6b23f76085db70547ed`. It contains the privacy-safe diagnostic tool, but not the Windows desktop Local AI runtime. The runtime under investigation remains on the open stacked PR chain #663 → #664 → #665; latest heads inspected were #663 `071b8910b30dc774be977ed618f63ab53262234f`, #664 `fa78f5944381aa5cc6edbfa3c7f43e8211e226c0`, and #665 `85518cf6240836448ef331260d16ba2401d7bfa7`. PRs #690/#691 concern agent/review/checkpoint controls rather than the Qwen generation implementation; the repository instructions still prohibit starting the real Local Qwen pilot until #691 and dependencies are integrated.
- The #664 targeted diagnostic artifact has expired (the GitHub artifact API now returns no artifacts for run `42293627959`). Its saved report contains the 18-token primary result, but no finish reason or candidate-level classification. Thus the historical report cannot prove whether that response ended with `stop` or `length`.
- Source inspection on #665 shows the validator maps `finishReason: length` to `truncated_output`; a valid empty `Insufficient source material` response maps to `insufficient_source`. Therefore a primary issue classified as `insufficient_source` is consistent with a completed model abstention rather than truncation, but the missing finish reason prevents confirming that inference from the old run.
- PR #665's latest full Local AI acceptance run, [#41878992364](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/41878992364), failed in both “Critical Local AI biology and visible output” and “Local AI factual quality and edge cases” on head `85518cf6240836448ef331260d16ba2401d7bfa7`. Other lifecycle, answer-grading, and weak-area follow-up jobs passed. Its artifacts have expired. The separate targeted-only run [#42046508800](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/42046508800) passed in 124.389 seconds, but it does not override the full acceptance failures or identify their cause.
- PR #677 (`276bf73ab5bec77e857b211d85974cdbe739d6cf`, stacked on #664) updates the synthetic response inspector to support the app's `choices` plus `correct_index` shape. The prior diagnostic allowlist did not include its fixed `question_shape` reason. This explains why that known category could be reduced to `other`; because the failed artifact is gone, it does not prove that all 11 historical `other` entries had that reason.
- A focused diagnostic-only change on `codex/local-qwen-diagnostic-evidence` now preserves allowlisted finish reasons (`stop`/`length`), known parser/oracle reason codes, and safe `operation_failed`/`runtime_failed` categories while retaining existing numeric token/timing metrics. Unknown values remain `unknown`/`other`. It does not change generation, validators, retry logic, or retain prompts, notes, raw responses, filesystem paths, error messages, or credentials. Some recovery response callbacks on #665 still omit finish-reason metadata; their `truncated_output` validator event remains observable, but the per-response reason may be `unknown` until the producer supplies it.

### Reproducible Windows x64 diagnostic procedure

The existing `.github/workflows/local-ai-targeted-practice-diagnostic.yml` is a manual `workflow_dispatch` on `windows-2025` x64. It accepts only the two named #664/#665 source branches, verifies the pinned Qwen3-4B Q4_K_M model and llama.cpp b11317 runtime checksums, runs one synthetic selected-pages warmup and targeted-practice case, records the checked-out source SHA, and uploads the sanitized report for three days. A cache miss downloads the pinned model and runtime. Do not run it without a separate bounded-run authorization; it consumes a hosted Windows runner and may download large artifacts.

When authorized, first record the selected source branch's full SHA and confirm it is the intended PR head. The workflow input is a mutable branch name, not an immutable revision; after checkout, compare the report's `sourceSha` with that preflight SHA and treat any difference as an invalid run. Dispatch exactly one run with:

```powershell
gh workflow run local-ai-targeted-practice-diagnostic.yml `
  --repo HamedGithubforwork/QuizForge-AI `
  -f source_branch=perf/local-practice-minimal-replacement-batch-20261103
```

Then record the resulting run ID and exact source SHA, monitor that run to completion, and retrieve only its `local-ai-targeted-practice-diagnostic` artifact. Compare its finish-reason counts, numeric completion tokens, parser/validator categories, runtime-failure categories, recovery termination, semantic oracle, uniqueness, and prior-question avoidance. Do not use run output or logs that contain raw prompts or model responses. The current ARM64 development machine is not the x64 acceptance host; use the existing Windows x64 workflow rather than claiming local x64 validation.

