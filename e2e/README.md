# QuizForge Playwright E2E Tests

These tests exercise QuizForge from the browser using Playwright.

The suite currently covers:

- Successful email/password login
- Invalid-login error handling
- PDF file selection and processing
- Quiz generation
- Answer submission and scoring
- Explanation and source-page display
- Saving a result to quiz history
- Loading the saved result in history
- Generating weak-area practice

External services are mocked at the browser network layer. The tests do not call the real OpenAI API or production Supabase/Render services, which keeps CI deterministic and avoids API cost.

## Run locally

Install the normal frontend dependencies first:

```bash
npm ci --prefix frontend
```

Install the E2E package:

```bash
npm install --prefix e2e
```

Install Chromium:

```bash
npx --prefix e2e playwright install chromium
```

Run the suite:

```bash
npm --prefix e2e test
```

For a visible browser:

```bash
npm --prefix e2e run test:headed
```

Playwright starts a Vite development server automatically with test-only Supabase and API URLs. Network requests to those URLs are intercepted by the tests.
