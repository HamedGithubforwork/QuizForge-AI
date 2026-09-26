FROM python:3.11.16-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY scripts/production/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY scripts/production/*.py scripts/production/*.sql scripts/production/rds-ca.pem ./
USER 10001:10001
# Deploying the image is not authorization to run a migration or bootstrap.
CMD ["python", "-c", "raise SystemExit('Choose an explicit reviewed operations command')"]
