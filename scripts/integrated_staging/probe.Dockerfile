FROM python:3.11.16-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY scripts/rds_rehearsal/requirements.lock ./
COPY scripts/integrated_staging/redis.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock -r redis.lock
COPY scripts/rds_rehearsal/schema.sql scripts/rds_rehearsal/identity_schema.sql scripts/rds_rehearsal/rds-ca.pem ./
COPY scripts/rds_rehearsal/probe.py ./probe_fixtures.py
COPY scripts/integrated_staging/probe.py scripts/integrated_staging/generation_guard.py ./
USER 10001:10001
CMD ["python", "probe.py", "seed"]
