FROM python:3.11.16-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY scripts/rds_rehearsal/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY scripts/production/*.py scripts/production/*.sql scripts/rds_rehearsal/rds-ca.pem ./
COPY scripts/rds_rehearsal/history_transfer.py /rds_rehearsal/history_transfer.py
USER 10001:10001
# Deploying the image is not authorization to run a migration or bootstrap.
CMD ["python", "-c", "raise SystemExit('Choose an explicit reviewed operations command')"]
