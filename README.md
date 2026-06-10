# Pontus Property Tax Checker

**Excel in → county portal lookup per row → Excel out.** Upload a
property-tax tracker; every row is looked up on its county portal
(any state, any vendor — including portals nobody has seen before); findings
are written back into a copy of the same workbook, structure preserved.

The task spec is `CLAUDE.md`; build standards live in `Context/`.

## Architecture

```
Browser (Next.js on Vercel, Firebase Auth)
   │  upload .xlsx                      live progress (Firestore onSnapshot)
   ▼
Next.js API routes (Admin SDK) ──────► Firestore  tax_checker_runs/{run}/rows
   │  store upload in GCS                          tax_checker_playbooks
   │  start Cloud Run JOB execution                tax_checker_scrape_state
   ▼
worker/ (Python, Cloud Run Job)
   intake (§2) → per-row portal lookup via Skyvern (§4–§6) → validation (§7)
   → openpyxl write-back (§10) → checked copy in GCS + run summary
```

- **Web app** (repo root): Next.js App Router + Tailwind v4 + shadcn/ui +
  Geist. Light mode, neutral-50 background, single blue-600 accent.
- **Worker** (`worker/`): the engine. Cloud Run **Job** (the template's
  Python escape hatch — justified by openpyxl + multi-hour Skyvern runs).
  Same engine runs locally without any cloud (`--local-xlsx`).
- **Firestore** namespacing: everything under the `tax_checker_*` prefix.
  Clients get read-only access when signed in; all writes go through the
  Admin SDK (API routes / worker). `firestore.rules` is deny-by-default.

## Run lifecycle

`queued → running → writing_back → done | done_with_errors | failed | canceled`

- Every row gets a `tax_checker_scrape_state` doc (deterministic ID
  `tax_check__<run>__<rowKey>`) — a crashed/re-executed job **resumes**,
  never restarts.
- One row's failure never aborts the run; failed rows become
  `NEEDS REVIEW — portal unreachable (…)` lines in the output.
- **Retry failed rows** (UI button) re-queues technical failures only;
  deliberate `NEEDS_REVIEW` outcomes are human work, not retried.
- Cancel stops after the current row; already-checked rows still get
  written back, untouched rows get `NOT CHECKED — …`.
- Portals are never written to: read-only guardrails are baked into every
  Skyvern prompt (no cart/pay/enroll/account-creation; downloading a bill
  PDF is the only artifact).

## Local development

```bash
# Web app
cp .env.example .env.local        # fill the Firebase blocks (see Setup below)
npm install
npm run dev                       # http://localhost:3000

# Worker — full local mode, no cloud needed:
cd worker
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py --local-xlsx "Property Taxes- Florida.xlsx"           # real check
.venv/bin/python main.py --local-xlsx tracker.xlsx --dry-run                   # no portals
.venv/bin/python main.py --local-xlsx tracker.xlsx --max-rows 2               # first 2 rows

# Worker against a queued cloud run (CLOUD_RUN_JOB unset → runs stay queued):
.venv/bin/python main.py --run-id <runId>

# Tests
npm run worker:test               # 36 engine tests
npm run build                     # web typecheck + build
```

Local mode needs `SKYVERN_API_KEY` (and optionally `ANTHROPIC_API_KEY`) in
the repo-root `.env` — already present from the prototype era.

## One-time Firebase setup (console)

1. [console.firebase.google.com](https://console.firebase.google.com) →
   create project (or reuse the Pontus internal-tools project).
2. **Add a Web App** → copy the config into `.env.local`
   (`NEXT_PUBLIC_FIREBASE_*`).
3. **Build → Firestore Database** → Create database (production mode).
4. **Build → Storage** → Get started (note the bucket name →
   `FIREBASE_STORAGE_BUCKET` / `STORAGE_BUCKET`).
5. **Build → Authentication** → Sign-in method → enable **Google**.
6. **Project settings → Service accounts → Generate new private key** →
   save the downloaded file as `./serviceAccount.json` (gitignored) and set
   `FIREBASE_SERVICE_ACCOUNT_KEY_FILE=./serviceAccount.json`. (Vercel has no
   filesystem — there you paste the JSON as ONE line into
   `FIREBASE_SERVICE_ACCOUNT_KEY`; generate it with
   `node -e "console.log(JSON.stringify(require('./serviceAccount.json')))" | pbcopy`.)
7. Deploy rules:

```bash
npm run deploy:rules      # uses ./serviceAccount.json — no firebase login needed
```

(`npm run deploy:firebase` is the firebase-tools equivalent; it requires
`npx firebase-tools login` with an owner account first.)

`node scripts/firebase-status.js` checks the project state (Firestore,
Auth, web app) and auto-fills the `NEXT_PUBLIC_*` block in `.env.local`.

## Deploy

**Web → Vercel.** Push to GitHub, import the repo in Vercel (auto-detects
Next.js). Set env vars in the dashboard: all `NEXT_PUBLIC_FIREBASE_*`,
`FIREBASE_SERVICE_ACCOUNT_KEY`, `FIREBASE_STORAGE_BUCKET`,
`NEXT_PUBLIC_APP_URL` (the deployed URL), `CLOUD_RUN_JOB`,
`CLOUD_RUN_REGION`, and optionally `ALLOWED_EMAIL_DOMAINS`.

**Worker → Cloud Run Jobs** (same Google project as Firestore):

```bash
gcloud config set project <project-id>
gcloud run jobs deploy tax-checker-worker \
  --source worker --region us-west1 \
  --task-timeout 6h --memory 1Gi \
  --set-env-vars "STORAGE_BUCKET=<bucket>,SKYVERN_API_KEY=<key>,ANTHROPIC_API_KEY=<key>"

# Let the web app's service account start executions:
gcloud run jobs add-iam-policy-binding tax-checker-worker --region us-west1 \
  --member "serviceAccount:<sa-email-from-the-json>" --role roles/run.developer
```

On Cloud Run the Admin SDK uses the ambient service account — don't set
`FIREBASE_SERVICE_ACCOUNT_KEY` there; grant the job's runtime service account
Firestore + Storage access (default compute SA usually has it).

## Write-back guarantees (CLAUDE.md §10)

- Output is a **copy**: `<name> — checked YYYY-MM-DD.xlsx`; the upload is
  never modified.
- One new status column per sheet, named by the workbook's own pattern
  (`June 2026 Update`) or `Checked YYYY-MM-DD`, appended after the last
  used column.
- Data cells (`Date Paid`, confirmation #, assessed value, single
  amount-owed column) are written **only** when verified (HIGH/MEDIUM
  confidence), the cell holds no formula, and nothing non-empty would be
  overwritten. Sheet-vs-portal contradictions become notes
  (`sheet said 11/13/2026; portal receipt shows 11/13/2025`).
- Installment grids (multiple amount columns) are never written into.
- No row is ever silently skipped.

## Repo layout

```
app/, components/, lib/      Next.js app (Vercel)
firestore.rules|indexes, storage.rules, firebase.json
worker/                      Python engine + Cloud Run Job
  pontus_tax/                intake · identifiers · taxonomy · playbooks ·
                             prompts · extraction_schema · skyvern_runner ·
                             verify · validate · writeback · store · orchestrator
  tests/                     36 pytest cases incl. a full dry-run pipeline
legacy/tax_retriever.py      the proven single-property prototype (reference)
Context/                     binding build standards + vendor doc dumps
```

> `web/` and `python/` at the root are dead Supabase-era leftovers
> (gitignored). Their secrets were backed up to `legacy/.env.local`.
> Delete both directories whenever convenient.
