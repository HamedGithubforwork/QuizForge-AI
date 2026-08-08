# QuizForge AI

[![CI](https://github.com/HamedGithubforwork/QuizForge-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/HamedGithubforwork/QuizForge-AI/actions/workflows/ci.yml)

AI-powered study quiz generator that turns PDF study material into interactive practice quizzes with explanations, source-page references, performance analytics, and personalized weak-area practice.

🌐 **Live Demo:** https://quiz-forge-ai-nine.vercel.app  
⚙️ **Backend API:** https://quizforge-ai-api.onrender.com  
✅ **API Health:** https://quizforge-ai-api.onrender.com/api/health

---

## Overview

QuizForge AI is a full-stack web application that allows users to upload PDF study material and generate AI-powered quizzes based directly on the document content.

The application tracks quiz performance over time and uses previous mistakes to generate targeted practice quizzes for weak areas.

The project includes authentication, persistent quiz history, automated testing, CI/CD, Docker-based development, API authentication, rate limiting, and production deployment.

---

## Features

- PDF upload and text extraction
- AI-generated quizzes from uploaded study material
- Multiple Choice questions
- True / False questions
- Short Answer questions
- Mixed question types
- Easy, Medium, and Hard difficulty levels
- 5, 10, or 15-question quizzes
- AI-generated answer explanations
- Source-page references for questions
- View Source functionality
- Quiz scoring and question-type breakdown
- Question navigation
- Retry Incorrect Questions
- Smart short-answer matching
- Quiz history stored per user
- Performance analytics
- Weak-area detection
- Targeted weak-area practice quizzes
- Mastery progress tracking
- Email/password authentication
- Email confirmation
- Forgot Password / password reset
- Secure authenticated backend API
- Per-user quiz generation rate limiting
- Automated backend tests
- Frontend linting and production build checks
- GitHub Actions CI
- Docker development environment
- Production deployment

---

## Tech Stack

### Frontend

- React
- TypeScript
- Vite
- Supabase JavaScript Client
- HTML / CSS

### Backend

- Python
- FastAPI
- Pydantic
- PyMuPDF
- OpenAI API
- HTTPX

### Database & Authentication

- Supabase
- PostgreSQL
- Supabase Auth
- Row Level Security (RLS)

### Testing & DevOps

- pytest
- GitHub Actions
- Docker
- Docker Compose
- Git / GitHub

### Deployment

- Vercel — frontend
- Render — FastAPI backend
- Supabase — authentication and database

---

## Architecture

```text
                         User
                           │
                           ▼
              ┌────────────────────────┐
              │     React + Vite       │
              │        Vercel          │
              └───────────┬────────────┘
                          │
                 Authenticated API
                      Requests
                          │
                          ▼
              ┌────────────────────────┐
              │        FastAPI         │
              │         Render         │
              └──────┬──────────┬──────┘
                     │          │
                     │          │
                     ▼          ▼
               OpenAI API    Supabase
                             Auth + DB
                     │
                     ▼
                PDF Processing
                  PyMuPDF
```

The React frontend authenticates users through Supabase and sends the user's access token with protected API requests.

FastAPI verifies the Supabase access token before allowing PDF processing or quiz generation.

OpenAI is accessed only through the backend so the API key is never exposed to the browser.

---

## Quiz Generation

Users can configure:

- Number of questions: 5, 10, or 15
- Difficulty: Easy, Medium, or Hard
- Question type:
  - Multiple Choice
  - True / False
  - Short Answer
  - Mixed

Quiz questions include:

- Correct answer
- Explanation
- Source page
- Question type

---

## Personalized Practice

QuizForge AI analyzes previous quiz performance to identify weak areas.

Users can generate targeted practice quizzes based on:

- Incorrect answers
- Weak source pages
- Weak question types
- Historical quiz performance

The application also tracks mastery progress by comparing targeted-practice performance against the user's previous baseline.

---

## Authentication & Security

QuizForge AI uses Supabase Authentication.

Supported authentication features include:

- Account creation
- Email confirmation
- Login
- Logout
- Forgot password
- Password reset

The FastAPI backend also includes:

- Supabase access-token verification
- Protected PDF upload endpoints
- Protected quiz-generation endpoints
- Configurable CORS
- Security response headers
- Per-user quiz-generation rate limiting
- Server-side OpenAI API credentials

Sensitive environment variables are never committed to GitHub.

---

## Database Security

Quiz history is stored in Supabase PostgreSQL.

Row Level Security policies ensure users can only access their own quiz history.

---

## Automated Testing

Backend tests can be run with:

```bash
cd backend
python -m pytest -q
```

The backend test suite covers areas including:

- API health
- Authentication requirements
- PDF validation
- PDF text extraction
- Scanned-PDF detection
- Quiz configuration validation
- Weak-area parsing
- Invalid request handling

Frontend checks:

```bash
cd frontend
npm run lint
npm run build
```

---

## Continuous Integration

GitHub Actions automatically runs on pushes and pull requests to `main`.

The CI pipeline performs:

```text
Backend
└── Python tests

Frontend
├── npm install
├── lint
└── production build
```

This helps prevent broken code from being deployed.

---

## Local Development

### 1. Clone the repository

```bash
git clone https://github.com/HamedGithubforwork/QuizForge-AI.git
cd QuizForge-AI
```

### 2. Backend setup

```bash
cd backend
python -m venv .venv
```

Activate the environment on Windows:

```powershell
.\.venv\Scripts\Activate.ps1
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Create:

```text
backend/.env
```

Use `backend/.env.example` as the template.

Start FastAPI:

```bash
uvicorn main:app --reload
```

Backend:

```text
http://127.0.0.1:8000
```

### 3. Frontend setup

```bash
cd frontend
npm install
```

Create:

```text
frontend/.env.local
```

Use `frontend/.env.example` as the template.

Start Vite:

```bash
npm run dev
```

Frontend:

```text
http://localhost:5173
```

---

## Docker Development

The full application can also be started with Docker Compose.

From the project root:

```bash
docker compose up --build
```

This starts:

```text
Frontend → http://localhost:5173
Backend  → http://localhost:8000
```

Stop the containers with:

```bash
docker compose down
```

---

## Environment Variables

### Backend

```env
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
ALLOWED_ORIGINS=
QUIZ_RATE_LIMIT=
QUIZ_RATE_WINDOW_SECONDS=
```

### Frontend

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_API_URL=
```

See the included `.env.example` files for safe configuration templates.

---

## Deployment

The production application uses a split deployment architecture.

### Frontend

Hosted on Vercel:

https://quiz-forge-ai-nine.vercel.app

Vercel automatically builds and redeploys the React frontend when changes are pushed to GitHub.

### Backend

Hosted on Render:

https://quizforge-ai-api.onrender.com

Render deploys the FastAPI application from the `backend` directory.

### Database & Authentication

Supabase provides:

- PostgreSQL
- Authentication
- Email confirmation
- Password recovery
- Row Level Security

> Note: the free Render backend may sleep after periods of inactivity, so the first request can take longer while the service wakes up.

---

## Screenshots

Add screenshots here showing:

1. Login / account creation
2. PDF upload
3. Quiz configuration
4. Generated quiz
5. Quiz results
6. Quiz history
7. Weak-area practice
8. Mastery progress

---

## Project Status

QuizForge AI is feature-complete and deployed.

Current production functionality includes the complete flow from account creation and PDF upload through AI quiz generation, persistent history, analytics, targeted practice, and password recovery.

---

## Author

**Hamed Vasheghani Farahani**

Computer Science student at Concordia University.

GitHub: https://github.com/HamedGithubforwork
