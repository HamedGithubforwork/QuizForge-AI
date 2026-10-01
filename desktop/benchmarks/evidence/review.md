# Initial CPU evidence — not product acceptance

Environment: native Linux x86_64 shared execution host, Intel Xeon Platinum 8573C,
9 visible logical CPUs, approximately 9.7 GiB RAM; llama.cpp b11317, two inference
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
