# On-demand AWS functional validation

After the baseline Valkey-enabled staging start and stop have passed, dispatch
**AWS staging environment** from `main` with `operation=start` and
`functional_validation=true`.

The existing Terraform, health, authenticated canary, and PING/SET/GET/EVAL
checks still run. The optional validation then exercises:

- rejection of missing and invalid bearer tokens;
- a small, synthetic, one-page PDF upload and repeat upload;
- processed document and source-page retrieval, including a missing page;
- one five-question multiple-choice quiz and a repeat request for its cache;
- one semantic answer review and rejection of an invalid review payload;
- the normal API generation limit and `Retry-After`, using invalid settings
  for requests that must never call OpenAI;
- application-created document, quiz and source-page cache entries and TTLs
  read from a separate Fargate task over TLS;
- shared metrics and timing samples persisted in Valkey;
- the unmodified quiz/review rate limits across independent Redis connections;
- eight competing lock acquisitions, exactly one owner, TTL, rejection of an
  incorrect owner token, owner-safe Lua release and reacquisition.

This validation expects a fresh staging cache and exclusive use of the dedicated
canary account during the run. It does not change application limits, use local
fallbacks as proof of distributed behavior, or flush the cache. Synthetic lock
and rate-limit keys are uniquely named and explicitly deleted.

The runner obtains canary credentials from existing GitHub secrets. The bearer
token remains in runner memory. The private probe receives only test identifiers
and a digest; credentials are not placed in ECS command/environment overrides.
The target check permits only the temporary QuizForge ALB in `ca-central-1`.
The current ALB is HTTP-only, as in the existing staging canary; this is not a
production endpoint. HTTPS remains required before production cutover.

Cost: this mode deliberately performs one real quiz-generation request and one
real answer-review request. A repeated quiz request tests the cache. The backend
can internally retry an invalid model response under its existing policy. The
rest of the calls do not need OpenAI. ALB, Fargate and Valkey incur their normal
temporary usage charges while validation runs, including one additional brief
Fargate probe task. No NAT Gateway or permanent service is added.

The probe task is stopped in `finally`. The workflow destroys staging after
functional validation whether it succeeds or fails. The normal manual `stop`
operation and daily safety shutdown remain available. Check the destruction logs
before reporting that the environment is off; a green test alone is insufficient.

The frontend/backend application and production configuration are unchanged by
the validation tooling. In particular, this is not the quiz-history migration:
that change needs a separate tested PR and a deployment decision because Render
currently deploys backend changes from `main` when checks pass.

## Test an unmerged application PR

Dispatch `AWS staging environment` from `main` with `operation=start`,
`backend_pr=85` (or another same-repository PR), and `history_validation=true`.
The PR must target main and have successful backend, frontend, browser,
local-stack, container-build, and required-gate checks on its exact commit.
The build runs without AWS credentials; a separate main-branch OIDC job pushes
that artifact under a staging tag and pins its digest only in staging state.
Production image selection and Render/Vercel deployment settings are unchanged.

PR previews require an automatic-cleanup validation mode. The history mode
checks authenticated reads, ownership, cursor behavior when data exists,
invalid input, and CORS through the AWS ALB. It performs no history database
writes and makes no OpenAI requests. Save/delete behavior and cross-user RLS
are exercised against isolated Supabase by the required local-stack check.
The workflow destroys staging after success or failure. The ordinary `main` /
`stop` operation and daily safety shutdown still use the same staging state.
