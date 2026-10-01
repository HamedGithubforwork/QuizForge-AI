# Initial CPU evidence — not product acceptance

Environment: native Linux x86_64 shared execution host, Intel Xeon Platinum 8573C,
9 visible logical CPUs, approximately 9.7 GiB host RAM with an 8 GiB container
memory limit and an eight-CPU quota; llama.cpp b11317, two inference
threads, GPU layers zero, one slot, 4096 context tokens. Model and runtime digests
are recorded in the benchmark README and raw JSON. These are automated inference
runs with assistant review of their synthetic output, not a blinded quality study.

## Qwen3 0.6B Q8

Three five-question quizzes, one run per fixture. Median request time 41.839 s;
individual times 38.539, 41.839 and 42.708 s. Peak child-process RSS reported by
Linux `getrusage(RUSAGE_CHILDREN)` after runtime shutdown was 1,330,796 KiB
(about 1.27 GiB). This measures the maximum child peak, not whole-system memory,
GPU memory, or a guaranteed memory requirement. Model download: 639,446,688 bytes.

Two of three quizzes passed structural validation. Manual inspection:

- Facts: only question 5 selects the correct option; questions 1–4 incorrectly
  use index 1 despite their explanations supporting option 0. Question 5 asks the
  color of the “red telescope”, a trivial question whose explanation is unrelated.
- Multiple pages: all five selected answers and cited pages match the notes.
- Quoted-instruction fixture: question 1 repeats the same answer four times;
  question 2 omits the correct answer (six wheels); questions 3–4 select incorrect
  answers; only question 5 is usable and correct. It did not output the injected
  command, but that alone does not make the quiz acceptable.

**Decision: reject this baseline as a default.** The roughly 610 MiB download is
attractive, but wrong answer indexes would teach users incorrect answers. Schema
constraints and syntactically valid output do not solve semantic correctness.

The initial request used a `response_format` shape accepted without schema
constraints by this runtime. Those preliminary outputs were all rejected. The
recorded evidence above was generated only after switching to the runtime's
explicit top-level `json_schema` contract and adding the field layout to the
prompt. Do not attribute the preliminary API-contract failure to model quality.

Next comparison: Qwen3 4B Q4_K_M, followed by real Windows and representative
hardware/longer-source evaluation if quality warrants it. No default runtime/model
or shipping hardware requirements have been selected.

## Qwen3 4B Q4_K_M — basic suite

Using the original benchmark at PR #476 head
`b3b645ae2f0771f78008f27ca16d32d06691553c`:

| Environment | Structural pass | Median per 5 questions | Model download | Peak child RSS |
| --- | --- | --- | --- | --- |
| Native Linux shared Xeon host, automated | 3/3 | 143.192 s | 2,497,280,256 bytes | 5,027,844 KiB |
| Real Windows 2025 GitHub runner, automated | 3/3 | 64.815 s | 2,497,280,256 bytes | Not measured |

These are different hardware/host environments, not an operating-system speed
comparison. One sample per fixture cannot establish latency variance or a p95.
The Windows artifact came from successful run 36847849375; its ZIP SHA-256 was
`7a0f61b427f25ac332b59ecf674f3d526976edcf9a6e8284331047c35808ad8f`.
Windows desktop regression 36847849298 also passed. Both use two CPU threads,
4096 context tokens, no GPU offload and one slot.

Assistant review of all 15 questions in each output found the selected answers,
explanations and page citations consistent with the synthetic source. Windows
multi-page questions 1 and 4 repeat the Aster container-capacity fact in different
wording; exact-string duplicate validation cannot catch this semantic repetition.
Linux multi-page question 5 revisits container materials already partly tested.
Neither run followed the quoted injection. This is encouraging small-fixture
evidence, not general prompt-injection resistance or launch-quality acceptance.

Decision: retain 4B Q4_K_M as an experimental candidate for extended testing.
Do not pick a default or advertise RAM/GPU requirements yet. The weights alone
are about 2.33 GiB; Linux peak child RSS was about 4.8 GiB before accounting for
Electron and other applications. Windows memory and consumer-device behavior
remain unmeasured. The 0.6B model remains rejected under the evaluated settings;
other prompts, quantizations or sampling settings have not been ruled out.

## Extended greedy evaluation — rejected

PR #477 head `14d2bb97a10f32ad0899c43726eae43d6e8bf9bf`, Windows run
36849658840, passed five of six structural cases but failed French distractor
uniqueness. The director-name question repeated “Léa Morel” in all four choices.
The same failure occurred on Linux even after clarifying that distractors may be
invented incorrect alternatives. The longer source and insufficient-source cases
passed. This candidate/prompt/sampling combination **does not pass the full gate**.

An earlier prompt made the model abstain on every fixture, including sufficient
notes (Windows run 36848769641). Clarifying that short notes can contain enough
facts fixed that behavior without relaxing any expected results. The remaining
French failure motivates evaluating the model publisher's recommended non-thinking
sampling settings; no acceptance check is disabled and no fixture is removed.

## Recommended non-thinking sampling — Linux extended screen

With temperature 0.7, top-p 0.8, top-k 20, min-p 0, presence penalty 1.5 and seed
42, all three extended Linux cases passed. Assistant review found all ten selected
answers, explanations and page citations correct, with distinct French distractors.
The insufficient-source fixture returned an empty quiz as required. The French
quiz's title remained English, so fully localized output is not yet established.

Request times were 190.479 s (French), 206.691 s (longer notes) and 4.723 s
(abstention). Peak child RSS was 5,259,436 KiB. The JSON records the exact benchmark
source SHA-256. This is one seeded screen, not evidence of a general correctness
rate; broader held-out material, multiple seeds and consumer hardware remain
necessary before selecting a default or enabling unattended deck creation.
