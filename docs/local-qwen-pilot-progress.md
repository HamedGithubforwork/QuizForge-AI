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

