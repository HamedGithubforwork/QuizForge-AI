# QuizForge AI

[![CI](https://github.com/HamedGithubforwork/QuizForge-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/HamedGithubforwork/QuizForge-AI/actions/workflows/ci.yml)

**QuizForge AI is a deployed full-stack study platform that turns PDF notes into source-grounded practice quizzes, tracks performance over time, and generates targeted practice from a learner's weak areas.**

[Live Demo](https://quiz-forge-ai-nine.vercel.app) · [Backend API](https://quizforge-ai-api.onrender.com) · [API Health](https://quizforge-ai-api.onrender.com/api/health)

> Production workflow verified end to end: sign in → upload PDF → process text → generate quiz → answer → score → save → history/analytics → weak-area practice.

---

## Why this project

QuizForge AI started as a PDF-to-quiz application and grew into a production-oriented full-stack project. It demonstrates more than an AI API call: authentication, structured AI output, deterministic validation and grading, persistent user history, targeted learning analytics, Redis-backed caching and rate limiting, automated tests, CI, Docker development, and cloud deployment.

### Engineering highlights

- **Grounded AI generation** — quiz questions, answers, explanations, and source pages are generated from the uploaded PDF rather than general model knowledge.
- **Structured validation** — FastAPI/Pydantic schemas and deterministic validators reject malformed quiz or grading data before it reaches the UI.
- **Adaptive practice** — saved attempts are analyzed by question type and source page to create new weak-area quizzes instead of simply repeating missed questions.
- **Production caching** — Redis caches extracted documents and generated quizzes to reduce repeated work and external AI requests.
- **Per-user protection** — authenticated endpoints, Redis-backed rate limiting, Supabase Row Level Security, configurable CORS, and security response headers.
- **Automated quality gates** — backend tests, frontend grading/analytics tests, linting, production builds, dependency audit, and Playwright E2E run in GitHub Actions.
- **Privacy-conscious observability** — structured logs record operational metadata without PDF text, user IDs, Redis keys, raw provider errors, or client IP access logs.

---

## Product flow

1. **Authenticate** with Supabase email/password authentication.
2. **Upload a PDF** and extract selectable text with PyMuPDF.
3. **Configure a quiz** with 5, 10, or 15 questions, difficulty, and question type.
4. **Generate** a source-grounded quiz through the FastAPI/OpenAI backend.
5. **Answer and review** multiple-choice, true/false, and short-answer questions with explanations and source-page references.
6. **Save results** to Supabase PostgreSQL.
7. **Analyze progress** using quiz history, score trends, mastery tracking, weak question types, and weak source pages.
8. **Practice weak areas** with a new targeted quiz that focuses on recent mistakes without repeating the original missed questions.

---

## Screenshots

### Upload and configure

![QuizForge PDF upload and quiz settings](docs/screenshots/upload-and-settings.png)

### Generated quiz

![QuizForge generated quiz](docs/screenshots/generated-quiz.png)

### Weak-area practice

![QuizForge weak-area practice](docs/screenshots/weak-area-practice.png)

### Quiz history and analytics

![QuizForge quiz history](docs/screenshots/quiz-history.png)

---

## Features

### Quiz generation

- PDF upload and text extraction
- Scanned/image-based PDF detection
- 5, 10, or 15 questions
- Easy, Medium, and Hard difficulty
- Multiple Choice, True / False, Short Answer, or Mixed modes
- AI-generated explanations
- Source-page references and **View Source** support
- Prompt-injection-resistant instructions that treat PDF content as data rather than commands
- Retry validation when AI output does not satisfy the quiz schema or grading rules

### Quiz experience

- Question navigator
- Unanswered-question detection
- Overall score and per-type score breakdown
- Retry Incorrect
- Generate New Quiz
- Deterministic short-answer grading with concept, exact, and numeric modes
- Compatible numeric-unit conversion for common mass, length, volume, time, percentage, and temperature answers
- Optional AI review for borderline short-answer paraphrases

### Personalized learning

- Persistent quiz history
- Performance analytics
- Recent score trends
- Weak question-type detection
- Weak source-page detection
- Targeted weak-area practice
- Avoidance of previously missed question text when generating follow-up practice
- Mastery tracking based on multiple recent attempts rather than a single high score

### Authentication and account flows

- Sign up and sign in
- Email confirmation
- Sign out
- Forgot password
- Password recovery/reset
- Supabase bearer-session authentication for protected backend requests
- Automatic session refresh/retry for expired frontend API requests

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, HTML/CSS |
| Backend | Python, FastAPI, Pydantic, HTTPX |
| PDF processing | PyMuPDF |
| AI | OpenAI API with structured responses |
| Database | PostgreSQL via Supabase |
| Authentication | Supabase Auth |
| Caching / rate limiting | Redis |
| Frontend deployment | Vercel |
| Backend deployment | Render |
| Testing | pytest, Node-based TypeScript tests, Playwright |
| CI / DevOps | GitHub Actions, Docker, Docker Compose |

---

## Architecture

```mermaid
flowchart TD
    USER[User / Browser]
    FE[React + TypeScript<br/>Vercel]
    API[FastAPI<br/>Auth • PDF orchestration • validation<br/>Render]

    AUTH[Supabase Auth]
    DB[(PostgreSQL<br/>Quiz History + RLS)]
    PDF[PyMuPDF<br/>PDF Extraction]
    REDIS[(Redis<br/>Cache • Rate Limits • Metrics)]
    AI[OpenAI API<br/>Quiz Generation + Answer Review]

    USER --> FE
    FE --> AUTH
    FE --> DB
    FE --> API

    API --> AUTH
    API --> PDF
    API --> REDIS
    API --> AI
    API --> FE
```

### How the pieces connect

- **React on Vercel** handles the interface, deterministic grading, analytics, and weak-area selection.
- **Supabase Auth** manages user sessions. FastAPI verifies the same bearer session before protected PDF/AI operations.
- **Supabase PostgreSQL** stores quiz history. The frontend accesses it through the Supabase client, while Row Level Security restricts users to their own rows.
- **FastAPI on Render** owns authentication checks, PDF orchestration, server-side secrets, AI requests, and deterministic validation of generated quiz data before it reaches the frontend.
- **PyMuPDF** extracts selectable text and page boundaries from uploaded PDFs.
- **Redis** provides document caching, quiz caching, per-user rate limiting, and operational metrics.
- **OpenAI** generates structured quiz data and can review borderline short answers.

### Main request paths

| Flow | Path |
| --- | --- |
| Sign in | Browser → Supabase Auth |
| Upload / generate quiz | Browser → FastAPI → PyMuPDF / Redis / OpenAI |
| Verify protected request | FastAPI → Supabase Auth |
| Save / load history | Browser → Supabase PostgreSQL under RLS |
| Weak-area practice | Browser analytics → FastAPI → new grounded quiz |

---

## Redis caching and rate limiting

Quiz generation can involve PDF extraction and an external AI request, so QuizForge uses Redis for two independent caches:

- **Document cache** — reuses extracted PDF pages for the same authenticated user/document.
- **Quiz cache** — reuses an already generated quiz for an identical eligible request.

Default TTLs:

```text
Document cache: 86400 seconds (24 hours)
Quiz cache:      3600 seconds (1 hour)
```

Quiz-generation traffic is also protected by a Redis-backed per-user limiter. The default is:

```text
10 quiz-generation requests per 600 seconds
```

If the Redis rate-limit backend is unavailable, QuizForge falls back to an in-memory limiter rather than removing protection entirely.

---

## Security and production engineering

QuizForge treats authentication, AI output, uploaded documents, external providers, and production logs as separate trust boundaries. The goal is not to assume any one layer is safe by default, but to validate and constrain data at each boundary.

| Area | Implementation |
| --- | --- |
| Authentication | Protected FastAPI routes require a Supabase bearer token. The backend verifies the token server-side against Supabase Auth before accepting PDF or AI work. Invalid/expired sessions return `401`; authentication-provider failures fail closed with `503`. |
| Data isolation | Quiz history is accessed through Supabase PostgreSQL with Row Level Security so authenticated users are restricted to their own rows. The privileged RLS helper function is not executable through the public/authenticated Data API roles. |
| Secret handling | OpenAI credentials remain server-side and are loaded from environment variables. The browser never receives the OpenAI API key. Example environment files contain placeholders only. |
| CORS / browser boundary | Backend CORS uses an explicit environment-controlled origin allowlist, permits only `GET`/`POST`, accepts only `Authorization` and `Content-Type`, and does not enable cross-origin credentials. |
| Security headers | API responses include `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` disabling camera, microphone, and geolocation access. |
| PDF / request validation | Uploads must be `application/pdf`, are capped at 15 MB, and are parsed by PyMuPDF. Quiz generation rejects likely scanned/image-only documents, excessive extracted text, invalid counts/difficulty/types, nonexistent focus pages, and malformed weak-area input. |
| AI trust boundary | PDF text is explicitly treated as untrusted study material rather than instructions. OpenAI output must parse into the Pydantic schema and pass deterministic question-count, type, rubric, numeric-unit, answer-consistency, and source-page validation before being returned. Invalid output is retried once and then rejected. |
| Abuse protection | Quiz generation uses a shared Redis-backed per-user rate limiter with `429` + `Retry-After`. If Redis is unavailable, protection falls back to a process-local in-memory limiter rather than disappearing. |
| Cache isolation | Document and quiz cache fingerprints are scoped using the authenticated user plus document/request identity. Cache keys and document identifiers are not written to application logs. |
| Admin surface | `/api/admin/metrics` requires both a valid authenticated session and membership in the configured `ADMIN_USER_IDS`; other authenticated users receive `403`. |
| Observability / privacy | Structured logs contain operational fields such as event, route, status, duration, cache result, question count, and random request ID. Application logging avoids bearer tokens, user IDs, PDF text, Redis keys, and raw provider exception messages. Production Uvicorn access logging is disabled so client IP addresses are not written by the default access logger. |

### Failure behavior

Production dependencies are expected to fail occasionally, so the backend uses explicit degradation and error boundaries:

- **Supabase Auth unavailable** → protected requests fail closed with a generic `503` rather than bypassing authentication.
- **Redis rate-limit backend unavailable** → rate limiting falls back to in-memory enforcement.
- **Redis cache unavailable** → cache operations degrade to misses; quiz/PDF processing can continue without exposing Redis error details to the client.
- **OpenAI/provider error** → the server logs only the exception class and returns a generic `502` message.
- **Malformed AI output** → deterministic validation rejects it; one regeneration attempt is allowed before returning a generic `502`.
- **Unexpected request failure** → structured observability records request ID, route, duration, and exception type without logging request bodies or raw exception text.

### Production privacy hardening

The production Render process starts with:

```bash
uvicorn main_redis:app --host 0.0.0.0 --port $PORT --no-access-log
```

This keeps Uvicorn's default IP-bearing access log disabled while QuizForge's own structured request middleware still records method, route, status, duration, and a random request ID for debugging and operational metrics.

---

## Testing and CI

QuizForge uses multiple test layers instead of relying on a single browser happy-path test. GitHub Actions runs all three CI jobs on every push and pull request targeting `main`.

| Layer | CI job | What it protects | Runtime |
| --- | --- | --- | --- |
| Backend API / infrastructure | **Backend tests** | API behavior, authentication requirements, PDF validation, document identity, Redis caching/rate limiting, metrics, answer review, quiz validation | Python 3.11 + Redis 7 |
| Frontend domain logic | **Frontend checks** | grading, numeric-unit handling, history grading, fallback logic, document identity, weak-area analytics, mastery analytics, quiz-generation policy, lint/build integrity | Node 22 |
| Browser workflow | **Playwright E2E** | sign-in UI, PDF processing, quiz generation, answering/scoring, source references, saving/history, weak-area practice | Chromium |

### Backend tests

The backend suite contains dedicated pytest modules for the API, Redis integration, document caching, document identity, observability, admin metrics, answer review, and generated-quiz validation.

CI starts a disposable `redis:7-alpine` service and exposes it only through `TEST_REDIS_URL`, so the real-Redis integration tests exercise actual Redis behavior without touching production data.

Key areas include:

- API health and authentication requirements
- PDF MIME/size/text validation and extraction behavior
- document SHA-256 identity
- document-cache hit/miss behavior
- Redis-backed quiz caching and rate limiting
- Redis failure/fallback paths
- structured observability and admin metrics
- AI answer-review response handling
- generated question, rubric, numeric-unit, and source-page validation

### Frontend logic checks

The frontend CI job runs eight focused TypeScript test files directly under Node before linting and building the production bundle:

```text
shortAnswerGrader.test.ts
numericUnitGrading.test.ts
historyQuestionGrader.test.ts
answerFallback.test.ts
documentIdentity.test.ts
weakAreaAnalytics.test.ts
masteryAnalytics.test.ts
quizGenerationPolicy.test.ts
```

The same job also runs:

- `npm audit --omit=dev --audit-level=low`
- `npm run lint`
- `npm run build`

This makes the production build and production dependency audit part of the CI gate rather than separate manual checks.

### Playwright E2E

Two Playwright specs exercise the application from Chromium:

- `quizforge.spec.ts` — authentication UI, upload/process/generate, answering and scoring, explanations/source pages, save/history, weak-area practice, and invalid-login handling
- `short-answer-history.spec.ts` — short-answer scoring/history persistence behavior and document identity flow

External services are intentionally mocked at the browser network layer in this suite. CI therefore does **not** spend OpenAI credits or depend on live Supabase/Render availability, which keeps the browser tests reproducible.

On E2E failure, GitHub Actions uploads the Playwright report as an artifact for 7 days.

### Production smoke testing

Deterministic CI is complemented by a separate live-production smoke test. The deployed Vercel/Render/Supabase application has been verified through the real browser flow:

```text
sign in → upload PDF → process → generate → answer → results
→ save → history/analytics → weak-area practice
```

This live smoke test is intentionally separate from CI: CI stays reproducible with mocked external services, while the smoke test validates that the actual deployed services work together.

### Run the checks locally

```bash
# Backend
cd backend
pip install -r requirements-dev.txt
python -m pytest -q

# Frontend
cd ../frontend
npm ci
node --experimental-strip-types src/lib/shortAnswerGrader.test.ts
node --experimental-strip-types src/lib/numericUnitGrading.test.ts
node --experimental-strip-types src/lib/historyQuestionGrader.test.ts
node --experimental-strip-types src/lib/answerFallback.test.ts
node --experimental-strip-types src/lib/documentIdentity.test.ts
node --experimental-strip-types src/lib/weakAreaAnalytics.test.ts
node --experimental-strip-types src/lib/masteryAnalytics.test.ts
node --experimental-strip-types src/lib/quizGenerationPolicy.test.ts
npm run lint
npm run build

# E2E (from repository root)
npm ci --prefix e2e
npx --prefix e2e playwright install chromium
npm --prefix e2e test
```

The CI implementation is in `.github/workflows/ci.yml`, and the browser-suite details are documented in `e2e/README.md`.

---

## Local development

### Prerequisites

- Git
- Python 3.11+ recommended
- Node.js 22+
- Redis, or Docker Desktop
- Supabase project
- OpenAI API key

### Option 1 — Docker Compose

Clone the repository:

```bash
git clone https://github.com/HamedGithubforwork/QuizForge-AI.git
cd QuizForge-AI
```

Create local environment files from the included templates:

```text
backend/.env.example  → backend/.env
frontend/.env.example → frontend/.env.local
```

Fill in your Supabase/OpenAI values, then start the stack:

```bash
docker compose up --build
```

Local services:

```text
Frontend  http://localhost:5173
Backend   http://localhost:8000
Redis     internal Docker service
```

Stop the stack with:

```bash
docker compose down
```

### Option 2 — Run services manually

Backend:

```bash
cd backend
python -m venv .venv
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
source .venv/bin/activate
```

Install and run:

```bash
pip install -r requirements.txt
uvicorn main_redis:app --reload
```

When Redis is running directly on your machine rather than through Docker, use a local URL such as:

```env
REDIS_URL=redis://127.0.0.1:6379/0
```

Frontend, in another terminal:

```bash
cd frontend
npm ci
npm run dev
```

---

## Environment variables

Use the committed example files as the source of truth.

### Backend

```env
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
REDIS_URL=redis://redis:6379/0

QUIZ_RATE_LIMIT=10
QUIZ_RATE_WINDOW_SECONDS=600
QUIZ_CACHE_TTL_SECONDS=3600
QUIZ_CACHE_VERSION=v1
DOCUMENT_CACHE_TTL_SECONDS=86400
DOCUMENT_CACHE_MAX_BYTES=1500000
DOCUMENT_CACHE_VERSION=v1
LOG_LEVEL=INFO
```

### Frontend

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_API_URL=http://127.0.0.1:8000
```

Never commit real secret values.

---

## Production deployment

QuizForge uses a split cloud architecture:

- **Frontend — Vercel:** https://quiz-forge-ai-nine.vercel.app
- **Backend — Render:** https://quizforge-ai-api.onrender.com
- **Database/Auth — Supabase:** PostgreSQL, Auth, and RLS
- **Cache/Rate limiting — Redis:** production Redis-compatible service

Render starts the production API with:

```bash
uvicorn main_redis:app --host 0.0.0.0 --port $PORT --no-access-log
```

The `--no-access-log` flag prevents Uvicorn from writing client IP addresses to application logs; QuizForge's structured request logs retain only operational fields such as method, route, status, duration, and a random request ID.

> The free Render web service can cold-start after inactivity, so the first backend request may take longer than subsequent requests.

---

## Current status

QuizForge AI is deployed and supports the complete production workflow from authentication and PDF upload through quiz generation, deterministic grading, persistent history, analytics, and targeted weak-area practice.

Current limitations include:

- image-only/scanned PDFs are detected but OCR is not implemented yet
- AI generation requires an external provider request on cache miss/bypass
- the free backend tier may cold-start after inactivity

---

## Repository structure

```text
QuizForge-AI/
├── backend/              FastAPI API, PDF processing, Redis integration, tests
├── frontend/             React + TypeScript application
├── e2e/                  Playwright end-to-end tests
├── docs/screenshots/     README product screenshots
├── supabase/migrations/  Database/RLS migrations
├── .github/workflows/    GitHub Actions CI
├── docker-compose.yml    Local full-stack development
└── render.yaml           Render production configuration
```

---

## Author

**Hamed Vasheghani Farahani**  
Computer Science student at Concordia University.

GitHub: https://github.com/HamedGithubforwork