# Handoff Summary — Pontus Property Tax Checker

Written 2026-07-01. This is a continuity document for a fresh Claude
session picking up mid-project with no other context. Read this whole
file before doing anything.

## Project overview

Pontus Capital owns properties across 15+ US states. Every quarter,
someone has to check each property's county tax portal for payment
status. This tool automates it: upload a spreadsheet, the tool visits
each property's portal, reads the bill status, hands back the same
spreadsheet with the numbers filled in.

**Stack:** Next.js frontend on Vercel (`tax-project-qso5` project,
alias `pontusautomation.vercel.app`) + Python worker on Google Cloud
Run (job `tax-checker-worker`, project `pontustax`, region `us-west1`)
+ Firestore for run state + Firebase Storage for files.

**The tool has TWO engines**, selectable per upload via a UI tab:
- **Skyvern** (`engine: "skyvern"`) — the original, a paid vision-AI
  browser agent. Works on any portal, costs ~$0.20-0.30/property.
  **Currently out of Skyvern credits** — this was the original
  problem that kicked off everything below, and is still unresolved
  (billing decision for the user, unrelated to any of this session's
  code work).
- **Playwright** (`engine: "playwright"`) — built this session to cut
  cost. Was originally going to be "hand-write a recipe per vendor
  family," but pivoted (see Key Decisions) to a generic, LLM-driven
  navigator that works on ANY vendor without per-vendor code.

## Current state — what's done and working right now

1. **Playwright engine exists as a parallel option to Skyvern**, not a
   replacement. Engine tabs on the upload UI, `engine` field on the
   run doc, orchestrator picks the right runner. This part is
   deployed and has been live-tested successfully in production.

2. **Bright Data ISP residential proxy is wired in and functional.**
   Required because Cloud Run's datacenter IP gets blocked/challenged
   by Cloudflare on these portals (confirmed via real production
   logs). Config: `BRIGHT_DATA_CUSTOMER_ID`, `BRIGHT_DATA_ZONE`,
   `BRIGHT_DATA_ZONE_PASSWORD` env vars (see Gotchas for the current
   values / where to find them). One fresh sticky IP session per
   property visit, US-targeted.

3. **One hand-written recipe exists: Grant Street** (`county-taxes.net`
   / `*.county-taxes.com`), in
   `worker/tax/pontus_tax/playwright_engine/recipes/grant_street.py`.
   Verified working end-to-end in a real production run: 9 properties
   came back Paid with correct dollar amounts, 0 Unreachable.

4. **A generic, LLM-driven navigator is built and verified working
   locally, but NOT YET DEPLOYED to Cloud Run.** This is the most
   important unfinished piece — see "In progress" below. It replaces
   "write a new recipe per vendor" with an AI decision loop that
   figures out navigation on any portal. Verified end-to-end against
   a real, previously-unseen vendor (Aumentum/PublicAccessNow, Palm
   Beach property) — correctly extracted parcel number, owner name,
   and a full payment history record with receipt number and dollar
   amount, using zero vendor-specific code.

5. **57/57 tests pass.** Run with `cd worker/tax && .venv/bin/python -m
   pytest tests/ -q`.

## Key decisions — don't relitigate these

- **Skyvern stays as a parallel option, never removed.** The Playwright
  engine was added alongside it via a UI toggle, not a replacement.
  Rationale: zero risk to the working path, easy A/B comparison, easy
  rollback.

- **Cost math on "Playwright is cheaper than Skyvern" is now murkier
  than originally pitched.** The original research assumed free
  datacenter egress; that assumption was wrong (Cloudflare blocks it),
  so a paid residential proxy is required, which eats into the
  savings. Still cheaper than Skyvern, but not the 5-10x originally
  projected — more like 2-4x, and that's before accounting for the
  proxy's own reliability problems (see Gotchas).

- **Pivoted from "write a recipe per vendor" to "one generic AI
  navigator."** After Grant Street (one recipe, ~1 day of work
  including live debugging) worked, testing against 2 more vendors
  (Aumentum, mptsweb) immediately hit "no recipe for this vendor" —
  confirming recipe-per-vendor doesn't scale against a portfolio with
  8-10+ distinct vendor families. The user explicitly asked for and
  approved building a generic LLM-driven navigator instead. This is
  now the primary path forward for anything that isn't Grant Street.

- **The generic navigator uses `aria_snapshot(mode="ai")`, not
  screenshots.** Playwright's accessibility-tree snapshot returns a
  compact, indented outline of every clickable/fillable element with
  a short ref like `[ref=e5]`. Verified directly (not assumed) that
  it auto-traverses into iframes, prefixing nested refs as `f1e5`,
  `f2e5`, etc. Chosen over vision/screenshots because every portal
  encountered so far (Grant Street, Aumentum) is plain government
  HTML — no complex visuals, so text is enough and far cheaper in
  tokens than images.

- **Cross-frame ref interaction: `page.locator(f"aria-ref={ref}")`
  called directly on the PAGE object works for refs inside iframes
  too** — Playwright resolves the frame internally. An earlier design
  manually tracked which Frame object each ref came from and tried to
  interact through that frame's own locator — this was WRONG and
  unnecessarily complex; verified via live testing with a local
  2-iframe HTML page that the simple page-level approach is correct.
  Don't reintroduce manual frame-tracking.

- **Navigation decisions use Claude Sonnet (`claude-sonnet-4-6`),
  extraction uses Haiku (`claude-haiku-4-5`, unchanged from before).**
  Navigation requires real judgment about page structure/intent;
  extraction is simpler (read clearly-labeled numbers off a settled
  page).

- **Bright Data product choice: ISP proxy, not Residential or
  Datacenter.** Datacenter is the same category of IP that's already
  getting blocked. Residential requires KYC approval before it works
  reliably for browser automation (per Bright Data's own docs). ISP
  is the pragmatic middle ground — residential IP reputation, no KYC
  wait. This is a real limitation (see Gotchas — ISP has shown real
  reliability problems); Residential + KYC is the fallback to
  consider if ISP keeps being flaky.

- **`gcloud run jobs update --set-env-vars` REPLACES the entire plain
  env var list; `--update-env-vars` MERGES.** Learned this the hard
  way — used `--set-env-vars` to add Bright Data credentials and it
  silently wiped `STORAGE_BUCKET` and `MAX_CONCURRENCY`, causing a
  full run failure. Always use `--update-env-vars` for incremental
  changes to Cloud Run job env vars.

## File and code structure

### Backend (Python worker) — `worker/tax/`

```
pontus_tax/
├── orchestrator.py          Run orchestration. Reads run.engine, picks
│                            SkyvernRunner or PlaywrightRunner. One call
│                            site to the runner (~line 300s in
│                            _check_account), passes row=row,
│                            group_candidates=group.candidates,
│                            row_key=job.key.
├── config.py                All env-var-sourced config. Bright Data
│                            fields + bright_data_enabled property near
│                            the Anthropic config block.
├── skyvern_runner.py         Unchanged Skyvern path. run_attempt() gained
│                            a keyword-only row/group_candidates/row_key
│                            (accepted, ignored) for call-site parity.
├── store.py                  LocalStore gained an `engine` param for
│                            --local-xlsx testing.
├── writeback.py, validate.py, verify.py, intake.py  Unchanged by this
│                            session's work (except an unrelated
│                            writeback.py fix from before this session
│                            that was also deployed).
│
└── playwright_engine/        NEW package, this session's work.
    ├── browser.py             Playwright Chromium lifecycle. ONE shared
    │                          browser per worker process. Bright Data
    │                          proxy settings built per-page-visit with
    │                          a fresh random session ID (sticky IP for
    │                          that one visit). Bot-detection-safe route
    │                          handler for image blocking.
    ├── extractor.py           Claude Haiku call that reads structured
    │                          fields off a rendered page's text. Used
    │                          by BOTH the hand-written recipes AND
    │                          (indirectly, via generic_navigator's own
    │                          separate flow) — actually note: the
    │                          generic navigator does NOT call this
    │                          Extractor; it returns FetchResult and
    │                          runner.py's existing extraction step
    │                          (self.extractor.extract(...)) is what
    │                          runs afterward for EITHER a recipe or the
    │                          navigator's output. Same as before.
    ├── generic_navigator.py   NEW, NOT YET DEPLOYED. The LLM-driven
    │                          navigator. GenericNavigator class,
    │                          .fetch(browser, url, ctx) -> FetchResult,
    │                          same shape as a Recipe. Decision loop:
    │                          snapshot page -> ask Claude Sonnet what
    │                          to do -> execute -> repeat, max 8 steps.
    ├── runner.py              PlaywrightRunner. Routes by URL: matched
    │                          recipe if one exists, else
    │                          self.generic_navigator (constructed in
    │                          __init__). Cache key scoped to
    │                          (domain, url, row_key, group_candidates)
    │                          — NOT just (domain, url), to avoid
    │                          cross-account/cross-row cache collisions.
    └── recipes/
        ├── __init__.py        ALL_RECIPES list + match(url) function.
        │                      Add new recipes here.
        ├── base.py            Recipe ABC, RowContext, RecipeError,
        │                      FetchResult, _domain_of helper.
        └── grant_street.py    The one hand-written recipe. Handles
                               county-taxes.net's iframe-based bill
                               pages (iframe URL contains
                               "iframe-taxsys" or "govhub"). Has its
                               own stability-polling wait logic
                               (_wait_for_bill_frame, 45s timeout —
                               was 20s, raised because proxy roughly
                               doubles page-settle time vs direct).
```

### Frontend (Next.js) — repo root

```
lib/types.ts                  TAX_ENGINES, TaxEngine, DEFAULT_TAX_ENGINE,
                               RunDoc.engine field.
app/api/tax/runs/route.ts     Accepts + validates `engine` form field on
                               upload, persists to run doc.
components/upload-card.tsx    Engine selector tabs (Skyvern / Playwright).
components/runs-table.tsx     Shows a "Playwright" badge on runs using
                               that engine.
```

### Deploy tooling

```
scripts/deploy-all.sh         Deploys BOTH halves: gcloud run jobs deploy
                               (Cloud Run worker) + npx vercel deploy --prod
                               (frontend). Run from repo root.
worker/tax/Dockerfile         python:3.12-slim base + explicit
                               `playwright install --with-deps chromium`.
                               NOT the Microsoft playwright/python image
                               (see Gotchas for why).
```

### Reference docs saved locally

`Context/Playwright/page-api.html` — Playwright's Page API docs, saved
for offline reference. `Context/SkyVern/`, `Context/Firebase/`, etc. —
pre-existing vendor doc dumps from before this session.

## In progress / unfinished

1. **The generic navigator is NOT deployed.** It exists in the local
   working tree (`generic_navigator.py` is untracked/new,
   `runner.py`/`config.py` changes are uncommitted modifications) and
   was only verified via local test scripts calling the classes
   directly with env vars set in the shell — never through an actual
   Cloud Run execution. **The currently-deployed worker image predates
   this feature.** A user test just minutes before this handoff
   (`Property Taxes- California.xlsx`, engine=playwright) still showed
   6/6 Needs Review because the live worker doesn't have this code yet.

2. **No automated tests exist for `generic_navigator.py`.** All
   verification was live/manual (local test scripts against real
   portals). Worth adding at least a mocked unit test for the JSON
   parsing / action-dispatch logic.

3. **Grant Street's proxy connection is intermittently unreliable**
   (see Gotchas). Not something more code fixes — it's a proxy
   reliability issue that may or may not have settled by the time you
   read this.

4. **Bright Data's "government site" policy block** hit one specific
   domain (Solano) outright. Unclear if this affects other portals in
   the full portfolio — only discovered by hitting it directly, not
   systematically checked against the whole spreadsheet.

## Next steps, in priority order

1. **Deploy the generic navigator to Cloud Run.**
   ```
   cd "Tax Project/New Tax Project"
   gcloud run jobs deploy tax-checker-worker --source worker/tax \
     --region us-west1 --project pontustax
   ```
   No Vercel redeploy needed — nothing in the frontend changed this
   session beyond what's already live.

2. **Run a real production test** with `engine=playwright` against a
   workbook containing a mix of Grant Street + Aumentum + other
   vendor properties, and read the actual Cloud Run logs (not just
   the UI) to see how the navigator performs at scale, not just on
   one hand-picked property. Log lines to watch for:
   `pontus_tax.playwright.generic_navigator` and
   `pontus_tax.playwright.runner`.

3. **Decide what to do about proxy reliability.** Options discussed:
   wait for Cloudflare reputation to cool down, escalate to full
   Residential proxy (needs Bright Data KYC approval), or reduce
   request pacing. No decision made yet.

4. **Consider adding automated tests** for `generic_navigator.py`
   (mock the Anthropic client, verify action dispatch / JSON parsing
   / the `wait` action loop).

5. **Longer-term, not urgent:** consider whether Skyvern credits
   should be topped up as a fallback for whatever the generic
   navigator can't handle (bot-challenges, sites the navigator gives
   up on) — this was the original problem and is still unresolved,
   independent of everything built this session.

## Gotchas and constraints

- **`gcloud run jobs update --set-env-vars` replaces the whole env var
  list; use `--update-env-vars` to merge.** Already bit us once (wiped
  `STORAGE_BUCKET`/`MAX_CONCURRENCY`). Current full correct env var
  set is: `SKYVERN_API_KEY`, `ANTHROPIC_API_KEY` (both Secret Manager
  references), `BRIGHT_DATA_CUSTOMER_ID`, `BRIGHT_DATA_ZONE`,
  `BRIGHT_DATA_ZONE_PASSWORD` (plain values), `STORAGE_BUCKET`,
  `MAX_CONCURRENCY` (plain values). Verify with:
  ```
  gcloud run jobs describe tax-checker-worker --region=us-west1 \
    --project=pontustax --format="value(spec.template.spec.template.spec.containers[0].env[].name)"
  ```

- **Bright Data proxy credentials** — customer ID `hl_ebd903e9`, zone
  name `isp_proxy1` (ISP tier, pay-per-GB). Zone password is stored in
  the Cloud Run job's env vars (plain value, not a secret reference —
  worth migrating to Secret Manager at some point) — retrieve it with
  `gcloud run jobs describe ... --format="yaml(spec.template.spec.template.spec.containers[0].env)"`
  rather than assuming a copy here is current. Server:
  `brd.superproxy.io:33335`. Username format:
  `brd-customer-{id}-zone-{zone}-country-us-session-{random}`.

- **Docker base image must NOT be `mcr.microsoft.com/playwright/python`.**
  That image's Python version doesn't satisfy `skyvern`'s minimum
  (`>=3.11`) — confirmed the image ships Python 3.10 via a live Cloud
  Build probe. Use `python:3.12-slim` + `RUN playwright install
  --with-deps chromium` instead (already done in the current
  Dockerfile). If you ever see `ERROR: No matching distribution found
  for skyvern` during a build, this is why.

- **Playwright version must exactly match what's installed.**
  `requirements.txt` pins `playwright==1.61.0`. If you bump this,
  nothing else needs to change since the Dockerfile installs Chromium
  explicitly (not relying on a vendor image's pre-baked browser) —
  version drift here is now much less risky than before.

- **`aria_snapshot(mode="ai")` and cross-frame refs**: take ONE
  snapshot on the page object (not per-frame), and always interact
  via `page.locator(f"aria-ref={ref}")` using the exact ref string
  given (including any `f1`/`f2` prefix). Don't manually track which
  Frame object a ref belongs to — Playwright handles this internally
  and manual tracking was verified to be both unnecessary and,
  in one attempted implementation, actively broken.

- **Claude must always return valid JSON, even when uncertain** — an
  earlier version of the navigator's system prompt let Claude drift
  into explaining its reasoning in prose when a page was mid-render
  ("Loading..." placeholders). Fixed by adding an explicit `wait`
  action to the schema and reinforcing "JSON only, no exceptions, even
  when uncertain" in the prompt. If you see `generic navigator: model
  returned non-JSON` in logs, this is the failure mode — check whether
  the page was actually in a legitimate transitional state.

- **Grant Street's iframe takes ~2x longer to settle through the proxy
  than direct** — confirmed live: ~6-8s direct, ~18.7s through Bright
  Data. `_SETTLE_TIMEOUT_S` in `grant_street.py` is set to 45s (was
  20s) to give real headroom. If you tune this down, retest through
  the actual proxy, not a direct connection — they behave very
  differently.

- **The proxy has shown genuine, confirmed intermittent failures** —
  the SAME URL, same session pattern, succeeded and failed on
  back-to-back attempts within minutes, verified via both raw `curl`
  and bare Playwright (not just application code). This is a real
  infrastructure reliability characteristic of the current Bright Data
  ISP zone today, not a bug to chase in this codebase.

- **Bright Data has an outright policy block on some domains classified
  as "Government"** (confirmed via `curl -v` showing
  `x-brd-err-code: policy_20000`, "classified as Government"). Hit
  this on `ca-solano.publicaccessnow.com` specifically. Did NOT hit it
  on `pbctax.publicaccessnow.com` (same vendor, different domain) or
  `county-taxes.net`. Domain-specific, not a vendor-wide or blanket
  rule — but be aware it exists when debugging a hard 403.

- **Local Python venv has a stale pip shebang** (`worker/tax/.venv/bin/pip`
  points at an old pre-rename project path and will error). Use
  `.venv/bin/python -m pip` instead of `.venv/bin/pip` directly —
  confirmed this works fine.

- **Real Anthropic API key for local testing** lives in the repo
  root's `.env` file (not `.env.local`) — read it into a shell var
  without echoing/printing it if you need to run a live test locally:
  ```
  export ANTHROPIC_API_KEY=$(grep "^ANTHROPIC_API_KEY=" "../../.env" | head -1 | cut -d= -f2-)
  ```
  (path relative to `worker/tax/`). Never print or log this value.

- **Skyvern is still out of credits** (`402: Credits exhausted`) —
  completely separate, pre-existing issue from before this session.
  Any run using `engine=skyvern` will fail until the user tops up
  their Skyvern account. Not something to fix in code.

- **The web UI's engine tab defaults to Skyvern** — a user testing the
  Playwright path needs to explicitly click the Playwright tab before
  uploading, every time. Easy to forget (happened at least once this
  session, causing confusion about a "regression" that was actually
  just the wrong engine being selected).
