FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run JOB: each execution receives RUN_ID as an env override.
CMD ["python", "main.py"]
