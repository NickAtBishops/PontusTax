# CLAUDE.md — Pontus Property Tax Checker (Excel → County Portals → Excel)

> Build standards, stack rules, UI system, and vendor docs live in @Context/ —
> they are binding:
> - @Context/FullStack/pontus_internal_tools_template.txt — build standard
> - @Context/FullStack/pontus_ui_design_system.txt — UI standard
> - @Context/FullStack/pontus_stack_context_pack.txt — docs routing/precedence
> - @Context/Firebase/ · @Context/NextJS/ · @Context/SkyVern/ · @Context/Vercel/ —
>   vendor doc dumps (grep the *-full files, never read whole)
>
> THIS file is about the task. Read it completely before writing code.

---

## 1. THE TASK — in one paragraph

The user uploads an Excel property-tax tracker. For **every property row**,
the system must: (1) open the URL in the row's website column, (2) if it lands
on the property's account page, read it; if it lands on a **search page or a
multi-step flow**, use the row's identifying data (account number, parcel ID,
or street address) to reach the right account page, (3) determine the
**current tax status** — paid or owed, amounts, dates, receipt numbers — by
parsing whatever that portal shows, and (4) **write the findings back into the
same Excel file**, preserving its structure, for the user to download. That
loop — **Excel in → portal lookup per row → Excel out** — IS the product.

**Design constraint that governs everything: this must work for ANY state,
ANY county, ANY portal — including portals nobody has ever seen.** The Pontus
portfolio spans 15+ states. Florida is just the first workbook (and the worked
example in §9). Never hardcode Florida column letters, Florida tax rules, or
the five Florida vendors into core logic. Core logic is generic; jurisdiction
and vendor specifics are DATA and PLAYBOOKS layered on top.

---

## 2. INPUT HANDLING — assume nothing about the workbook

Workbooks vary by state (`Property Taxes- Florida.xlsx`,
`Property Taxes- California.xlsx`, `Property Taxes 3-13 Texas Pinaccle.xlsx`
already exist; more will come). Layouts differ. Therefore:

### 2.1 Column detection by header matching, never by letter
Scan the first ~5 rows for a header row (may be TWO stacked header rows —
Florida has a group row above the real header row). Map columns by
fuzzy/synonym matching, e.g.:

| Canonical field | Header synonyms to match (case-insensitive, partial) |
|---|---|
| address | address, property address, location, situs |
| city / state / zip | city; st, state; zip, zip code, postal |
| county | county, parish (LA!), borough (AK), taxing jurisdiction |
| owner_entity | owner, entity, owner entity, LLC |
| internal_id | pid (NOT the parcel — Pontus internal code like VP4601) |
| account_number | account, account #, acct, parcel, parcel id, apn, pin, folio, schedule, tax id, property id |
| assessed_value | assessed, assessment, assessed value, av |
| tax_year | year, tax year, year of assessment, roll year |
| installments | installment, # installments, payments |
| due_dates | due, due date, early bird, #1..#4 (date-typed) |
| amounts | amount, owed, #1..#4 (number-typed), early bird (amount) |
| total | total (if it contains a FORMULA, mark protected) |
| date_paid | date paid, paid date, paid on |
| confirmation | confirmation, receipt, paid confirmation |
| responsible_party | responsible, tenant, party |
| status_notes | update, notes, status (e.g. "April 2026 Update") |
| website | website, url, link, portal |

Rules: a field can be absent (degrade gracefully — e.g. no URL column → must
discover the portal, §4.6). Ambiguous matches → ask the user once, or mark the
run's mapping in the summary so it's auditable. **Cells containing formulas
are PROTECTED — never overwritten** (Florida's `Total` column W and its SUM
row). Multiple sheets per workbook → process each sheet that has a detectable
header row + at least one data row with a URL or account number.

### 2.2 Identifier hygiene (applies to every state)
Account/parcel values arrive dirty. Normalize into a candidate list and try
candidates in order:
- strip leading `#`, whitespace, trailing punctuation
- as-is → without dashes → without dots/spaces → without leading zeros
- **multiple IDs in one cell** split on `/ ; ,` (Florida row 4 has THREE
  accounts: `#T815151/#T813795/#R444958` — each must be looked up; row status
  aggregates: paid only if ALL paid; report each open one)
- trailing unit suffixes like `/0` — try with, then without
- APN formats vary by state (CA: `123-456-78`, TX: numeric, FL: long
  hyphenated) — don't validate against one shape; just try candidates.

---

## 3. THE UNIVERSAL EXTRACTION SCHEMA — what "done" means for a row

Whatever the portal looks like, the goal per row (per tax year, per account)
is this canonical record. Anything you can't fill stays null — never invented:

```
{
  tax_year,            // the year/roll being reported (see §5.1 — labels vary)
  status,              // PAID | PARTIAL | UNPAID | DELINQUENT | NEEDS_REVIEW | UNREACHABLE
  amount_billed,       // gross/total billed for the year, if shown
  amount_paid,         // what was actually paid (may be < billed: discounts)
  amount_due,          // live balance owed now (incl. penalties/interest)
  date_paid,           // payment posted date
  receipt,             // receipt/confirmation number
  paid_by,             // payer name if shown (cross-checks responsible party)
  assessed_value,      // if displayed
  next_due_date,       // next installment/deadline if unpaid
  prior_year_balance,  // true if ANY earlier year shows a balance — flag it
  page_timestamp,      // any "last updated" shown on the portal
  source_url,          // the final URL of the page actually read
  evidence,            // short trace: how the row was matched + key strings seen
  confidence           // HIGH | MEDIUM | LOW (see §7)
}
```

---

## 4. THE PORTAL TAXONOMY — classify ANY landing page, then run its path

There are thousands of county portals but only a handful of *shapes*. On
arrival, classify the page into one of these types and follow the path.
This is how unseen portals get handled.

### Type A — Direct account/bill page
The URL lands on the property itself (deep links: query params with parcel,
base64 tokens, path IDs). Verify ownership (§6.1), then extract (§5).
If a deep link errors, redirects to a search, or shows a different parcel →
the token/session is stale: fall back to Type B using the row's identifiers.

### Type B — Search form
A box like "Name, Address, Account Number". Input ladder, stop at first hit:
1. account/parcel candidates (§2.2, in order)
2. street address (+ city if the form supports it)
3. owner entity name (expect MULTIPLE results — disambiguate by address)
Then: results list → click the matching record (match account exact, else
address exact, else owner contains) → Type A handling.

### Type C — Multi-step flows
Disclaimer/terms page ("I agree") → search → results → detail; or separate
"real estate vs tangible vs business" roll selection before search. Accept
disclaimers (read-only browsing is fine), choose the correct roll type
(see §5.4), proceed to Type B/A.

### Type D — Year/roll selector
Some portals require choosing a tax year or show one pinned in the URL
(St. Johns pins `y=2025`). Always confirm the displayed year equals the
target year; navigate the selector if newer/correct years exist.

### Type E — Blocked: login wall, CAPTCHA, bot challenge, paywall
Skyvern handles many CAPTCHAs natively; let it try. If genuinely blocked
(account login required, subscription): status `NEEDS_REVIEW — portal
requires login`, record what was required. NEVER create accounts, never
bypass paywalls, never solve "are you a government employee" style gates
falsely.

### Type F — PDF-only or document-based bills
Some counties only expose bills as PDF downloads or TIF images. Download the
target-year bill PDF (allowed read-only artifact), extract text (OCR if
scanned), parse amounts/dates from it. If unparseable → NEEDS_REVIEW with the
PDF saved as evidence.

### Type G — Split assessor/collector sites
Assessed value often lives on the ASSESSOR/APPRAISAL site; bills/payments on
the TAX COLLECTOR site (Texas: appraisal district vs county tax office are
different orgs with different sites). If the row's URL answers only half the
schema, fill what it gives; only chase the other site if a link to it exists
on-page. Don't go hunting across the internet by default.

### 4.6 No URL at all (column empty or missing)
Construct a search: `"<county> county <state> tax collector property tax search"`
via web search; prefer official `.gov`/county domains; classify the landing
page by this taxonomy and proceed. Record the discovered URL in the output so
the spreadsheet gets fixed for next time. If no official portal can be found
→ NEEDS_REVIEW.

### 4.7 Unknown-vendor protocol (the "never seen this before" path)
1. Identify the platform: footer credits ("Powered by Grant Street Group",
   "© Aumentum Technologies", "Pacific Blue Software", Tyler Technologies,
   Beacon/Schneider Geospatial, DEVNET, GovTech…), URL patterns, page titles.
2. If it matches a known playbook (§8) → use it.
3. If not: classify by taxonomy type, run the generic path, and **write a new
   playbook entry** (vendor name, URL pattern, page type, where status/paid
   data lives, quirks) into the run summary so the library grows. The system
   must get smarter with every new portal it meets, not re-solve it each run.

---

## 5. EXTRACTION RULES — jurisdiction-agnostic core + variance awareness

### 5.1 Tax-year semantics vary BY STATE — detect, don't assume
- Florida: calendar-year bills (2025), mailed ~Nov, payable through Mar 31
  of the next year. A "2025 bill paid 03/2026" is normal.
- California: FISCAL year labels ("2025-2026"), secured roll, TWO
  installments (delinquent after Dec 10 / Apr 10). Prop 13 caps assessed
  growth — flat assessed values are normal, not stale data.
- Texas: bills out ~Oct, delinquent Feb 1, appraisal district ≠ tax office.
- Others vary further (some states bill in arrears, some semiannual, NJ-style
  flat-then-reset assessments, etc.).
**Rule:** the target year comes from the spreadsheet's tax_year column; match
the portal row whose label contains that year (handle "2025", "2025-26",
"2025/2026"). Never grab "the top row" or "the newest" blindly. The absence of
a NEXT year's bill is not an error if that jurisdiction hasn't issued it yet.

### 5.2 Paid amount ≠ billed amount is often CORRECT
Causes: early-payment discounts (FL: 4%/3%/2%/1% by month), installment
splits (partial payments are per-installment, not delinquency), exemptions
applied after billing, rounding. Validation must allow these (§7). Conversely
amount_due > amount_billed is normal when delinquent (penalties + interest
accrue monthly).

### 5.3 "Nothing owed" banners are not proof of payment
"Total Payable: $0.00" means no current balance — the PROOF (amount, date,
receipt) usually hides in a collapsed "Recently Paid Bills" (+ toggle), a
payment-history table, or a per-year bill list. Always expand/read it. If
payment details truly aren't exposed: status PAID with
`payment details unavailable` in evidence, confidence MEDIUM.

### 5.4 Roll/account types must match
real estate / secured ≠ tangible personal property / unsecured ≠ business.
One Pontus URL token decodes to `charlotte:tangible:…` — a tangible account.
Same address can have both types. Match the type the spreadsheet row intends
(default: real estate/secured unless the row or URL says otherwise) and never
mix amounts across types.

### 5.5 Dense bill pages: extraction priority
When a page shows dozens of numbers (per-authority ad-valorem lines, millage
rates, non-ad-valorem assessments, gross, totals, payments, refunds):
1. PAYMENTS table (posted date, receipt, paid-by, amount) = ground truth.
2. TOTAL / GROSS = amount_billed.
3. Per-authority lines, millage rates = ignore (they sum into gross).
4. REFUND sections: usually empty; if a refund exists, note it in evidence.

### 5.6 Multi-account rows aggregate
Status = PAID only if ALL the row's accounts are paid. Any open account →
the row reports that account + its balance explicitly.

---

## 6. VERIFICATION — never extract from the wrong property

### 6.1 Ownership check (mandatory before any extraction)
The account page should show an owner containing the row's owner entity or
"PONTUS" (e.g. `PONTUS EHC PALM BEACH LLC`). Names get mangled by county data
entry — accept fuzzy contains. **Exception:** recently acquired properties may
still show the SELLER's name; if owner doesn't match but parcel/account AND
address both match exactly, proceed with confidence MEDIUM and note the owner
mismatch in evidence. If neither owner nor address matches → wrong record:
back out, re-disambiguate; if unresolved → NEEDS_REVIEW. Never extract from
an unverified page.

### 6.2 Address/parcel cross-check
The page's situs address should resemble the row's address (normalize:
St/Street, Hwy/Highway, directionals, suite numbers). Parcel shown should
match one of the §2.2 candidates.

---

## 7. VALIDATION & CONFIDENCE — before any cell is written

- **Discount band:** paid within 0–5% below billed → normal (covers FL tiers
  and rounding). Paid far below billed without an installment explanation →
  don't write amounts; NEEDS_REVIEW.
- **Delinquent growth:** live amount_due ≥ the sheet's stale figure is
  expected; live amount LOWER than a known delinquency → suspicious (partial
  payment? wrong account?) → flag for review, still report what was seen.
- **No silent erasure:** a scraped $0/blank never overwrites a real existing
  value. Parse glitches must not delete data.
- **Date sanity:** dates ≤ today; payment date plausibly within the bill's
  payable window for that jurisdiction.
- **Year match:** extracted tax_year == row's target year (per §5.1 label
  handling).
- **Confidence:** HIGH = ownership verified + exact account match + payment
  details read. MEDIUM = fuzzy/indirect match or proof section unavailable.
  LOW = anything inferred — LOW results go to NEEDS_REVIEW, not into the
  sheet's data columns (status note only).
- **Existing typos in sheets** ("Paud in full", impossible future dates like
  a payment dated a year ahead): write clean values; when the portal
  contradicts the sheet, correct in the status column with a note
  (`sheet said 11/13/2026; portal receipt shows 11/13/2025`).

---

## 8. KNOWN-VENDOR PLAYBOOK LIBRARY (grows over time — add entries every run)

National platforms to recognize on sight (footer/URL):
- **Grant Street Group** — `county-taxes.net`, "BillExpress". Deep links use
  base64 tokens decoding to `county:roll_type:parents:<uuid>`; bare roots are
  search pages; per-year Annual Bill lists with Paid/$/date/Receipt.
- **PublicAccessNow** — `*.publicaccessnow.com`. Deep link
  `Account.aspx?p=<parcel>&a=<acct>`; "Total Payable" banner; collapsed
  "Recently Paid Bills" (+) holds the proof.
- **ptaxweb / Pacific Blue Software** — `…/ptaxweb/editPropertySearch2.action`.
  Either deep `action=detail&propertyId=…` or bare search form. Dense bill
  detail: per-authority table, NON AD VALOREM, GROSS, PAYMENTS, REFUND.
- **Aumentum Technologies** — footer credit; same banner + collapsed paid
  section pattern as PublicAccessNow.
- **Tyler Technologies (iTax/Eagle/EnerGov), Beacon/Schneider Geospatial
  (beacon.schneidercorp.com), DEVNET, GovTechTaxPro, Qualia-style assessors** —
  common elsewhere in the country; classify by taxonomy on first contact and
  add a playbook entry.

When a NEW vendor is met, §4.7 applies: solve it generically, document it.

---

## 9. WORKED EXAMPLE — the Florida workbook (first real input; patterns recur)

Sheet `Florida Prop Tax`: two header rows (group row + field row), data rows
3–25, totals row 26 with a SUM formula (protected). Columns A–AE map to the
canonical fields per §2.1 (H "PID" = internal ID, I "Account #" = the real
search key, W Total = FORMULA, AB/AC = monthly status-note columns, AD =
Website). 23 properties across 13 FL counties on 5 portal systems. Known
cases the generic engine must reproduce:
- Broward ×3 rows share one bare search URL — column I disambiguates.
- Row 4 (Pinellas): three accounts in one cell; aggregate per §5.6.
- Row 9 (Broward): known delinquency $120,802.06, live figure will be higher
  (§7 delinquent-growth rule); status text e.g.
  `DELINQUENT — $<live> owed as of <date>`.
- Putnam detail page: GROSS $5,128.33, paid $4,974.48 on 12/29/2025 = 3% Dec
  discount (normal per §5.2); Paid By "Robert Machin Jr" → capture, it
  cross-checks Responsible Party.
- Charlotte row: tangible roll (§5.4).
- St. Johns: year pinned in URL (§ Type D).

---

## 10. WRITE-BACK SPEC

1. Load/save with openpyxl preserving everything: formatting, widths, merged
   header rows, hyperlinks, images, ALL formulas.
2. Write only into detected canonical columns: amounts owed (if unpaid),
   date_paid, receipt/confirmation, assessed_value (if newly seen) — and a
   **NEW status column** following the workbook's own naming pattern (Florida
   uses "<Month> <Year> Update" → add e.g. `June 2026 Update`). One
   human-readable line per row:
   `Paid in full $4,974.48 on 12/29/2025 (Receipt N12292025P015431, paid by Robert Machin Jr)` /
   `DELINQUENT — $123,456.78 owed as of 6/9/2026` /
   `NEEDS REVIEW — account not found`.
3. Unverified rows keep old values + a NEEDS_REVIEW note. **No row is ever
   silently skipped.**
4. Output = copy with suffix (`… — checked 2026-06-09.xlsx`) to the download
   path; the original upload is never modified.
5. Produce a run summary: counts by status, the column mapping used, any new
   vendor playbook entries (§4.7), rows needing human review and why.

---

## 11. HARD RULES

- **ABSOLUTE READ-ONLY on portals.** These are payment sites. Never add to
  cart, never checkout/pay, never enroll (installment plans, e-billing),
  never create accounts, never log in to payment accounts, never falsely
  affirm eligibility gates. Downloading a bill/receipt PDF is the only
  permitted artifact. Humans pay bills; this system only reads.
- One row's failure never aborts the run — resumable, per-row try/except,
  everything logged (resumability rules:
  @Context/FullStack/pontus_internal_tools_template.txt §12).
- Rate-limit politely; several rows share the same portal — reuse the session,
  don't hammer.
- Pontus only. No GGC code, data, or patterns — separate firms, fully walled.
- Scraping tool: Skyvern (workflows parameterized by URL + identifiers —
  see @Context/SkyVern/skyvern-complete-reference.md). One workflow per
  TAXONOMY TYPE (§4), specialized by vendor playbook (§8) — never one bespoke
  script per property.
- This task = Excel in/out. Dashboard, Firestore persistence, alerts, appeals
  are later phases.

---

## 12. IMPLEMENTATION STATE (for the next session — system built 2026-06-10)

**Session defaults are AUTOMATIC**: `.claude/settings.json` pins
`model: claude-fable-5` + `effortLevel: xhigh` (≡ `/model claude-fable-5` +
`/effort max`). Do not downgrade either for this project.

§1–§11 above are the binding spec and are now FULLY IMPLEMENTED:

| Piece | Where |
|---|---|
| Web app (upload → live runs dashboard → run detail → download) | `app/`, `components/`, `lib/` — Next.js 16 at repo ROOT, Vercel-targeted |
| API routes (create/list/download/cancel/retry, Bearer-verified) | `app/api/runs/**` |
| Engine: intake §2 / schema §3 / taxonomy §4 / extraction §5 / verify §6 / validate §7 / playbooks §8 / write-back §10 | `worker/pontus_tax/` (intake, identifiers, taxonomy, playbooks, prompts, extraction_schema, skyvern_runner, verify, validate, writeback, store, orchestrator) |
| Tests (36; synthetic Florida workbook + dry-run pipeline) | `worker/tests/` → `npm run worker:test` |
| Firestore: `tax_checker_runs/{id}/rows+events`, `tax_checker_playbooks`, `tax_checker_scrape_state` | rules deny-by-default; deploy with `npm run deploy:rules` |

Live facts:
- Firebase project **pontustax** (Blaze). Bucket `pontustax.firebasestorage.app`.
  Admin key = `./serviceAccount.json` via `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`
  (gitignored; on Vercel paste the JSON one-line into
  `FIREBASE_SERVICE_ACCOUNT_KEY` instead).
- `scripts/firebase-status.js` = project health check + `.env.local` autofill.
  `scripts/deploy-rules.js` = rules deploy via Rules API (the admin-SDK SA
  cannot call serviceusage, so plain `firebase-tools deploy` 403s — use the
  script).
- Uploads stay **queued** until the Cloud Run JOB exists: deploy with
  `gcloud run jobs deploy tax-checker-worker --source worker …` then set
  `CLOUD_RUN_JOB`/`CLOUD_RUN_REGION` (.env.local + Vercel). Manual processing:
  `cd worker && .venv/bin/python main.py --run-id <id>`; no-cloud dev:
  `--local-xlsx file.xlsx [--dry-run]`.
- `MAX_CONCURRENCY` = concurrent PORTALS (same-portal rows stay sequential +
  polite — never raise the per-domain rate). Currently 10 in `.env.local`.

**FAST-MODE PIVOT (2026-06-10, user decision — overrides §3/§5 detail):**
the product question is ONE number per property — “amount left to pay now.”
The Skyvern schema/prompts extract only amount_due_now (+ owner/situs/parcel
for §6 verification + delinquency flag); receipts, payment history, per-year
bills, dates, payers, assessed values are NOT collected (too slow on real
portals). Statuses collapse to PAID / UNPAID / DELINQUENT / NEEDS_REVIEW /
UNREACHABLE. Read-only guardrails and wrong-property verification are
unchanged and non-negotiable. Do not re-add the rich extraction without the
user asking.

Engineering invariants learned the hard way — keep them:
- NEVER import firebase-admin/auth — its jwks-rsa→jose chain dies on Vercel
  (ERR_REQUIRE_ESM). ID tokens are verified with jose in lib/server-auth.ts.
- Cloud executions are SERIALIZED (claim_next_queued exits if a run is
  active) and MAX_CONCURRENCY=2: the Skyvern plan's browser-session cap
  mass-fails sessions (connect_over_cdp timeouts) at ~6 concurrent. Raising
  concurrency requires a Skyvern plan upgrade, not a code change.
- Job executions start ARGUMENT-FREE and claim the oldest queued run
  (roles/run.invoker only covers plain run.jobs.run — overrides need more).
- tax_checker/ in the Storage bucket is working state — console deletions
  there killed live runs once (2026-06-10; recovered via 7-day soft delete).
- The user's Vercel has had TWO projects; the real one is tax-project-qso5
  (env vars live there, marked Sensitive = not CLI-pullable). Deploy with
  `npx vercel deploy --prod` from the repo root (linked via .vercel/).
- Row-doc IDs are zero-padded (`s00_r0003`) so `documentId()` order == sheet
  order; the UI sorts by it. NO composite indexes by design — query
  single-field, filter in code (`store.pending_keys`).
- Column formula-protection is proportional (≥50% of non-empty cells), so a
  totals-row SUM doesn't freeze a column; `_safe_write` guards per-cell.
- A prior-year bill with a balance is DELINQUENT even if partially paid;
  PARTIAL is only for current-cycle installments (§5.2/§7 interplay).
- shadcn CLI is v4-style now: `init -b radix -p vega` (no `-b neutral`).
- The UI design doc referenced in the header does NOT exist in Context/ —
  UI rules come from the tools template §10 + its Aesthetic block.

Housekeeping: `web/` + `python/` at root are dead Supabase-era dirs
(gitignored — safe to delete); prototype preserved at
`legacy/tax_retriever.py`. SECURITY: the service-account key was pasted into
a chat transcript on 2026-06-10 — if `scripts/firebase-status.js` shows the
key still valid and no rotation happened yet, prompt the user to rotate
(console → new key → replace `./serviceAccount.json` → delete old key id
`31383e0c…` in GCP IAM).
