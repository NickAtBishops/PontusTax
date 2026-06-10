#!/bin/bash
# Allow the web app's Firebase service account to start executions of the
# tax-checker-worker Cloud Run job (this is what makes uploads auto-start).
# Grants roles/run.invoker on this ONE job only — no project-wide access.
set -euo pipefail

gcloud run jobs add-iam-policy-binding tax-checker-worker \
  --region us-west1 \
  --member "serviceAccount:firebase-adminsdk-fbsvc@pontustax.iam.gserviceaccount.com" \
  --role roles/run.invoker

echo
echo "✓ Done — uploads will now start their own Cloud Run execution."
