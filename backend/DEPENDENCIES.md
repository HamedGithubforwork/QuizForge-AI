# Python dependency locking

QuizForge AI targets **Python 3.11.16** for backend development, CI, Docker, and Render configuration.

## Files

- `requirements.in` — direct production dependency intent.
- `requirements.lock` — exact resolved production constraints.
- `requirements.txt` — stable production install entrypoint; installs `requirements.in` under `requirements.lock` constraints.
- `requirements-dev.in` — direct development/test dependency intent.
- `requirements-dev.lock` — exact resolved development/test constraints, including production dependencies.
- `requirements-dev.txt` — stable development/test install entrypoint; installs `requirements-dev.in` under `requirements-dev.lock` constraints.

The `.lock` files are constraints rather than flat install lists. That preserves upstream environment markers, such as Linux-only `uvloop`, while still forcing every resolved package version to the tested version on platforms where that dependency applies.

Production systems, Docker, and local-stack CI should install `requirements.txt`. Backend test CI and local development should install `requirements-dev.txt`.

## Updating dependencies

Regenerate locks intentionally under **Python 3.11.16** in clean virtual environments. Do not update a transitive package in only one lock by hand.

### 1. Update production intent

Edit `requirements.in` only when a direct runtime dependency or its allowed range should change.

Create a clean environment, then resolve and freeze the production graph:

```bash
python -m venv .venv-lock-runtime
# Activate .venv-lock-runtime for your shell.
python -m pip install --upgrade pip
python -m pip install -r requirements.in
python -m pip freeze --exclude pip --exclude setuptools --exclude wheel > requirements.lock
python -m pip check
```

### 2. Update development intent

Edit `requirements-dev.in` when a direct test/development dependency should change.

Use a separate clean environment so unrelated local packages cannot leak into the lock:

```bash
python -m venv .venv-lock-dev
# Activate .venv-lock-dev for your shell.
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.in
python -m pip freeze --exclude pip --exclude setuptools --exclude wheel > requirements-dev.lock
python -m pip check
```

### 3. Validate before merging

From a fresh Python 3.11.16 environment:

```bash
python -m pip install -r requirements-dev.txt
python -m pip check
python -m pytest -q
```

Audit the exact production graph:

```bash
python -m pip install pip-audit
python -m pip_audit -r requirements.lock
```

When Docker-related dependency behavior changes, also verify from the `backend` directory:

```bash
docker build -t quizforge-backend .
```

The GitHub workflows repeat the constrained install, `pip check`, backend tests, and production dependency audit. A dependency update is complete only when the source `.in` file, corresponding `.lock` file, and validation results agree.
