# Cloud Run worker image. Stateless service: receives xlsx + write
# parameters, returns modified xlsx. Knows nothing about tenants or
# quarters; that lives in the Next.js side.

FROM python:3.12-slim

WORKDIR /app

# Install dependencies first so the layer can be cached across code
# edits. Drop pytest and httpx from the deployed image to keep it
# slim — the test deps are only needed locally.
COPY requirements.txt .
RUN pip install --no-cache-dir \
      fastapi==0.115.6 \
      "uvicorn[standard]==0.32.1" \
      openpyxl==3.1.5 \
      python-multipart==0.0.19

# Application code.
COPY excel_writer.py main.py ./

# Cloud Run passes the listening port via $PORT (default 8080 locally).
ENV PORT=8080
EXPOSE 8080

# `exec` so signals (SIGTERM from Cloud Run on shutdown) reach uvicorn.
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
