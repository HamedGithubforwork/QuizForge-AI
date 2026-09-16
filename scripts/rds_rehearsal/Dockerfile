FROM python:3.11.16-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY probe.py api_profile.py api_canary.py schema.sql rds-ca.pem ./
USER 10001:10001
CMD ["python", "probe.py", "seed"]
