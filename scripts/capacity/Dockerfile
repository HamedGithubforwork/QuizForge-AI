# Synthetic capacity laboratory only. Never deploy this test image.
FROM python:3.11.16-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata OMP_THREAD_LIMIT=1 \
    PYTHONPATH=/app/backend:/app/scripts/capacity:/app/scripts/production
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng postgresql-17 redis-server nginx openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY preview-source/backend/requirements* ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY preview-source/backend/ ./
COPY scripts/production/schema.sql scripts/production/generation_budget.sql scripts/production/generation_guard.py /app/scripts/production/
COPY scripts/capacity/ /app/scripts/capacity/
RUN touch /capacity-test-image && mkdir /results && chown postgres:postgres /results
USER postgres
ENTRYPOINT ["python", "/app/scripts/capacity/run.py"]
