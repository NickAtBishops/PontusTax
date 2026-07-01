#!/usr/bin/env bash
# Deploy BOTH halves of the tax checker in one shot.
#
# 1) Cloud Run worker (Python + Playwright). This is the half that
#    actually runs the tax-portal lookups. Without it, the Playwright
#    tab in the UI does nothing on the worker side.
# 2) Vercel frontend (Next.js). The UI + API routes.
#
# Run BOTH for the engine selector to work end-to-end. The Cloud Run
# deploy takes ~4 minutes (image build + push); the Vercel deploy takes
# ~2 minutes. They are sequential here because Vercel needs the worker
# to be in place when the first run-with-engine=playwright triggers it.
#
# Usage:  bash scripts/deploy-all.sh
# Run from the project root.

set -euo pipefail

# Pinned values. These MUST match the linked project, not whatever
# gcloud's active config is set to right now. Your gcloud may be on
# another project (e.g. ggc-test-...) for unrelated work; --project
# below forces the correct one.
GCP_PROJECT="pontustax"
REGION="us-west1"
JOB_NAME="tax-checker-worker"
WORKER_DIR="worker/tax"

cd "$(dirname "$0")/.."

echo "Active gcloud account:"
gcloud auth list --filter=status:ACTIVE --format="value(account)"
echo "Will deploy to GCP project: ${GCP_PROJECT}  (region ${REGION})"
echo

echo
echo "──────────────────────────────────────────────────────────────"
echo "STEP 1 / 2  ·  Deploying Cloud Run worker (Python + Playwright)"
echo "             Job:    ${JOB_NAME}"
echo "             Region: ${REGION}"
echo "──────────────────────────────────────────────────────────────"
echo

# --source rebuilds the container image from the worker/tax/ folder
# using its Dockerfile (now on the Microsoft Playwright Python base
# image — Chromium ships pre-installed).
gcloud run jobs deploy "${JOB_NAME}" \
  --source "${WORKER_DIR}" \
  --region "${REGION}" \
  --project "${GCP_PROJECT}"

echo
echo "──────────────────────────────────────────────────────────────"
echo "STEP 2 / 2  ·  Deploying Vercel frontend (Next.js)"
echo "──────────────────────────────────────────────────────────────"
echo

# --prod pushes to the production alias (tax-project-qso5 on Vercel).
# The build command in vercel.json runs `next build` against the
# linked project; .vercel/project.json is already in the repo.
npx vercel deploy --prod

echo
echo "──────────────────────────────────────────────────────────────"
echo "DONE. Both halves deployed."
echo
echo "Next:"
echo "  1. Open the Vercel URL."
echo "  2. Upload a workbook from the Tax Checker page."
echo "  3. Select the Playwright tab BEFORE clicking Check."
echo "  4. Watch the run-detail page."
echo
echo "Today's recipe library: county-taxes.net (Grant Street family)."
echo "Other vendor URLs will land in Needs Review with a clear reason;"
echo "re-upload that workbook with the Skyvern tab for full coverage"
echo "(needs Skyvern credits)."
echo "──────────────────────────────────────────────────────────────"
