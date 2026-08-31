# QuizForge Playwright E2E Tests

QuizForge uses Playwright at three different boundaries: deterministic browser E2E, real local-stack integration, and an authenticated production canary. They intentionally serve different purposes rather than sharing one environment.

## Standard browser E2E

The default suite lives in `e2e/tests/` and runs through `playwright.config.ts`.

It currently covers:

- `quizforge.spec.ts` — authentication UI, PDF selection/processing, quiz generation, answering/scoring, explanations and source pages, save/history, weak-area practice, and invalid-login handling
- `short-answer-history.spec.ts` — short-answer grading/history persistence and stable document identity behavior
- `source-page-cache.spec.ts` — lazy source retrieval and bounded frontend source-cache behavior
- `accessibility.spec.ts` — keyboard/semantic assertions plus axe WCAG A/AA scans of signed-out and authenticated states

External services are mocked at the browser network layer. The browser and frontend behavior are real, but the suite does **not** call the production Supabase/Render services or the OpenAI API. This keeps normal CI deterministic, fast, and free of provider cost.

## Real local-stack integration

The integration suite lives in `e2e/integration-tests/` and runs through `playwright.integration.config.ts`.

It verifies the browser against a real isolated local stack consisting of:

- local Supabase Auth/PostgreSQL
- the production-style FastAPI application
- Redis
- a Vite frontend started by Playwright

The suite exercises real authenticated browser sessions, protected backend requests, Row Level Security behavior, migrations/seeded integration data, and Redis document-cache miss/hit behavior. The local-stack workflow recreates the isolated database for each run; retries are intentionally disabled because the tests mutate that disposable local state.

The GitHub Actions workflow `.github/workflows/local-stack-integration.yml` owns the complete service startup, seeding, browser run, Redis verification, diagnostics, and teardown sequence.

Once the required local services and `INTEGRATION_SUPABASE_PUBLISHABLE_KEY` are configured, the Playwright portion can be run with:

```bash
npm --prefix e2e run test:integration
```

## Authenticated production canary

The deployed canary lives in `e2e/canary-tests/` and uses `playwright.canary.config.ts`.

It signs in through the deployed Vercel UI using dedicated GitHub Actions canary credentials, reads the real Supabase browser session, and verifies that the deployed Render backend accepts that authenticated session on a protected request. The request deliberately uses a nonexistent valid document SHA and expects the protected API's expired/unavailable-document response, so the canary proves the Vercel → Supabase Auth → Render authentication/CORS boundary without uploading a PDF, generating a quiz, calling OpenAI, or writing quiz-history data.

The workflow is `.github/workflows/authenticated-canary.yml`. It can be dispatched manually and also runs automatically after a successful automatic deployment smoke check on `main`.

Required repository secrets are:

```text
QUIZFORGE_CANARY_EMAIL
QUIZFORGE_CANARY_PASSWORD
```

## Run the standard suite locally

Install frontend dependencies:

```bash
npm ci --prefix frontend
```

Install E2E dependencies:

```bash
npm ci --prefix e2e
```

Install Chromium:

```bash
npx --prefix e2e playwright install chromium
```

Run the standard mocked suite:

```bash
npm --prefix e2e test
```

For a visible browser:

```bash
npm --prefix e2e run test:headed
```

Playwright starts the Vite development server automatically for the standard suite with test-only Supabase/API URLs, and the tests intercept requests to those URLs.

## CI ownership

- **CI → Playwright E2E** runs the deterministic mocked browser suite on relevant changes.
- **Local stack integration** runs the real isolated browser + Supabase + FastAPI + Redis integration boundary.
- **Authenticated deployment canary** verifies the deployed browser-authenticated backend boundary after production smoke succeeds.

These layers complement one another: mocked E2E protects fast user-flow regressions, the local stack protects real service integration, and the canary protects the deployed authenticated boundary.