# Staging-only AI generation allowance

This intentionally disposable, cost-capped staging environment is **not** production. It uses a separate user pool, private Valkey, and an OpenAI loopback guard. Production generation quotas and its API key are unchanged.

## Starting allowance

New full staging sessions initialize **10 upstream AI attempts** in Valkey. The automated staging browser test usually spends one, leaving nine for manual testing if no additional retries occur. Every upstream attempt (including a provider error or a validation retry) consumes one slot. Cached quizzes do not spend another upstream attempt. Existing staging sessions created under the old two-request cap remain unchanged until the operator manually refills them.

The guarded model remains \`gpt-5.6-luna\`, with a maximum of 4,096 output tokens and 32,768 request-body bytes per call. This caps requests, not the exact dollar cost of each attempt.

## Check or refill a running staging environment without redeploying

1. Open the [Staging AI allowance workflow](../.github/workflows/aws-staging-ai-budget.yml).
2. Select **Run workflow**, branch **main**, operation **status**, and inspect the completed workflow summary: “Requests remaining: N / 10.”
3. If desired, repeat with operation **refill**. It atomically sets **remaining** to 10 (not *adds* 10), preserving the lifetime count of upstream requests.
4. Refresh the website if the deployed frontend includes the allowance indicator. The current website may still use an older API/frontend image until a separately reviewed staging application rollout.

The workflow fails closed if the main branch/repository or exact operation is wrong, the owned Terraform state or staging resources do not match, the private Redis allowance is absent/invalid/expired, or the single scoped probe task fails. It runs at most one **disposable ECS probe task** and does not create or redeploy any server/service, mutate Terraform, change authentication, or invoke the OpenAI API itself. The status/refill tasks incur ordinary short-lived AWS compute charges. The additional OpenAI bill only occurs if more AI generation attempts are actually used.

Multiple manual refills can permit more than ten *lifetime* attempts, but no single refill sets more than ten remaining requests. This is deliberately operator-controlled, not a background reset. No hourly reset is enabled. The production environment does not inherit this behavior.

## Web UI and errors

The staging-only API route \`GET /api/staging/ai-budget\` requires an authenticated user and returns only non-sensitive numeric remaining/allowance values. On production the route is intentionally a 404. The staging frontend displays “Staging AI requests remaining: N / 10” plus a refresh action when its backend and frontend revisions are deployed.

When the staging loopback guard returns an authenticated exact budget-exhausted marker, the revised backend displays “Staging AI request allowance exhausted” with instructions to refill. Other provider 429/5xx failures remain generic rather than being incorrectly labeled budget exhaustion. This error and website counter require **a separately reviewed API/frontend application deployment**; merging the budget-operations PR or refilling the existing Valkey key alone does **not** update already-running application images.

## Operational guardrails

- Never copy real credentials, PDFs, or personal data into diagnostic logs.
- Do not turn on Google sign-in in production just because a staging budget operation worked.
- Run the existing **manual Stop** operation after testing to avoid ongoing RDS/ECS/ALB/cache charges.
- A refill does not reset quiz history, Cognito accounts, user rate limits, or the model's upstream request counter.
