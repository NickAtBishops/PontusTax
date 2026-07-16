"""Run orchestration — Excel in → portal lookup per row → Excel out.

One row's failure never aborts the run (per-row try/except, resumable
scrape_state). Rows sharing a portal run sequentially on a shared browser
session with polite delays; distinct portals run concurrently up to
MAX_CONCURRENCY.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime as dt
import logging
import os
import tempfile
import traceback
from dataclasses import dataclass
from typing import Any

from .canonical import (
    DELINQUENT, NEEDS_REVIEW, PARTIAL, UNPAID, UNREACHABLE,
    HIGH, MEDIUM, LOW,
    AccountRecord, RowOutcome, aggregate_status, min_confidence,
)
from .config import Config
from .discovery import discover_portal
from .extraction_schema import EXTRACTION_SCHEMA
from .identifiers import AccountCandidates
from .intake import RowIntake, SheetIntake, parse_workbook
from .playbooks import Playbook, draft_playbook, match_playbook
from .prompts import PromptContext, build_prompt
from .skyvern_runner import SkyvernRunner, coerce_output
from .playwright_engine.runner import PlaywrightRunner

# Default engine when the run doc has no `engine` field (back-compat
# for runs created before the field existed). Skyvern is the safe
# default because every recipe-shaped path has a Skyvern fallback in
# the sense that the analyst can re-upload with engine="skyvern".
DEFAULT_ENGINE = "skyvern"
from .store import RunStore, row_key
from .taxonomy import TYPE_A, TYPE_B, TYPE_D, classify_url, domain_of
from .validate import build_account_record, build_row_note
from .verify import MatchVerdict, adjudicate_with_claude, assess_match
from .writeback import output_filename, write_output
from . import pdf_bill

log = logging.getLogger("pontus_tax.orchestrator")

# How often the cancel watcher polls the run's cancel_requested flag while
# rows are in flight. On cancel it aborts the in-flight Skyvern tasks
# immediately (not at the next row boundary), so a cancel lands within this
# window plus the few seconds write-back takes.
CANCEL_POLL_SECONDS = 5.0


@dataclass
class RowJob:
    key: str
    sheet_index: int
    sheet: SheetIntake
    row: RowIntake


def _roll_type_for(row: RowIntake) -> str:
    """§5.4 — default real estate/secured unless the row or URL says
    otherwise. Grant Street deep-link tokens decode to
    county:roll_type:parents:<uuid>."""
    url = row.url or ""
    if "tangible" in url.lower():
        return "tangible"
    for segment in url.split("/"):
        if len(segment) < 16:
            continue
        try:
            decoded = base64.b64decode(segment + "=" * (-len(segment) % 4)).decode(
                "utf-8", errors="ignore"
            )
        except Exception:  # noqa: BLE001
            continue
        if ":tangible" in decoded:
            return "tangible"
        if ":business" in decoded:
            return "business"
    return "real_estate"


def _job_domains(job: "RowJob") -> list[str]:
    """Every portal domain this row's job could touch this run: the
    Website domain plus each non-empty Jurisdiction Link domain, or the
    §4.6 discovery placeholder domain (`discover:{county}-{state}`) when
    the row has no URL at all. Used by `_group_jobs_by_shared_domain` so
    two rows sharing a domain — even when it's only a SECONDARY/TERTIARY
    link on one of them, not its primary Website — still get bucketed
    into the same sequential, one-session-at-a-time group (CLAUDE.md §11:
    "several rows share the same portal; reuse the session, don't
    hammer")."""
    urls = job.row.check_urls()
    if not urls:
        return [
            f"discover:{(job.row.county or 'unknown').lower()}-"
            f"{(job.row.state or '').lower()}"
        ]
    domains = {domain_of(url) for _, url in urls}
    return sorted(domains)


def _group_jobs_by_shared_domain(jobs: list["RowJob"]) -> list[list["RowJob"]]:
    """Connected-components grouping: two jobs are linked if they share ANY
    domain (from `_job_domains` — the row's FULL url-list domains, not just
    its Website). All jobs in the same connected component become one
    sequential bucket, so a portal domain that appears as row A's Website
    AND row B's Jurisdiction link secondary is never scheduled on two
    concurrent sessions at once.

    Buckets are returned in a stable, deterministic order (sorted by each
    bucket's smallest domain string, mirroring the previous
    `sorted(by_domain.items())` determinism); jobs within a bucket keep
    their relative order from the input `jobs` list."""
    parent: dict[int, int] = {}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(len(jobs)):
        parent[i] = i

    domain_owner: dict[str, int] = {}
    for i, job in enumerate(jobs):
        for domain in _job_domains(job):
            if domain in domain_owner:
                union(domain_owner[domain], i)
            else:
                domain_owner[domain] = i

    components: dict[int, list[int]] = {}
    for i in range(len(jobs)):
        components.setdefault(find(i), []).append(i)

    def bucket_key(indices: list[int]) -> str:
        return min(
            (d for i in indices for d in _job_domains(jobs[i])),
            default="",
        )

    ordered = sorted(components.values(), key=bucket_key)
    return [[jobs[i] for i in indices] for indices in ordered]


def _needs_review_record(account: str, reason: str) -> AccountRecord:
    return AccountRecord(
        account_searched=account,
        status=NEEDS_REVIEW,
        evidence=reason,
        confidence=LOW,
    )


def _unreachable_record(account: str, reason: str) -> AccountRecord:
    return AccountRecord(
        account_searched=account,
        status=UNREACHABLE,
        evidence=reason,
        confidence=LOW,
    )


class RowProcessor:
    def __init__(
        self,
        cfg: Config,
        runner: SkyvernRunner | PlaywrightRunner,
        playbooks: list[Playbook],
        store: RunStore,
        dry_run: bool,
        today: dt.date,
    ):
        self.cfg = cfg
        self.runner = runner
        self.playbooks = playbooks
        self.store = store
        self.dry_run = dry_run
        self.today = today
        self.new_playbooks: list[str] = []
        self.discovered_urls: list[str] = []

    # ------------------------------------------------------------------
    async def process(self, job: RowJob) -> RowOutcome:
        row = job.row
        outcome = RowOutcome(
            row_key=job.key,
            sheet_name=job.sheet.name,
            row_number=row.row_number,
        )

        if self.dry_run:
            outcome.row_status = NEEDS_REVIEW
            outcome.status_note = "NEEDS REVIEW — dry run, portal not contacted"
            outcome.confidence = LOW
            return outcome

        # ---- portal URL list (§4.6: discover Website when the cell is
        # empty; the Jurisdiction Link columns are reference-only and are
        # NEVER independently discovered — an empty link cell just means
        # nothing to check there). A property can owe tax to more than one
        # taxing authority, so every non-empty URL on the row is checked,
        # not merely as a fallback when Website fails.
        urls = row.check_urls()
        if not row.url:
            if row.county:
                discovered = await discover_portal(row.county, row.state)
                if discovered:
                    outcome.discovered_url = discovered
                    self.discovered_urls.append(
                        f"{job.sheet.name} row {row.row_number}: discovered {discovered}"
                    )
                    # Insert at the front, mirroring Website's normal slot,
                    # but dedupe against any jurisdiction link that already
                    # carries the exact same URL.
                    if discovered not in {u for _, u in urls}:
                        urls = [("Website", discovered)] + urls

        if not urls:
            outcome.row_status = NEEDS_REVIEW
            outcome.needs_review_reason = (
                "no portal URL in the sheet and no official portal found"
            )
            outcome.status_note = f"NEEDS REVIEW — {outcome.needs_review_reason}"
            outcome.confidence = LOW
            return outcome

        multi_url = len(urls) > 1
        records: list[AccountRecord] = []
        for label, url in urls:
            url_label = label if multi_url else None
            records.extend(await self._process_url(job, url, url_label, outcome))

        # ---- aggregate (§5.6) — across ALL urls checked -----------------
        # A supplementary jurisdiction link (anything but Website) that
        # came back NEEDS_REVIEW/UNREACHABLE is excluded from the STATUS
        # aggregation: a reference URL that's stale, wrong, or simply
        # doesn't apply to this property shouldn't drag an otherwise-good
        # Website result down to NEEDS_REVIEW. It's still fully visible in
        # outcome.accounts/evidence — this only changes what decides the
        # row's status/confidence/note. Website's own result always
        # counts regardless of status; a WORKING supplementary link (a
        # real second jurisdiction with its own bill) still participates
        # normally, including winning the row via the usual worst-status
        # rule when it's genuinely worse than Website's. Single-URL rows
        # are unaffected (every record's jurisdiction_label is None here,
        # so all of them land in `primary`).
        primary = [r for r in records if r.jurisdiction_label in (None, "Website")]
        supplementary_ok = [
            r for r in records
            if r.jurisdiction_label not in (None, "Website")
            and r.status not in (NEEDS_REVIEW, UNREACHABLE)
        ]
        aggregatable = primary + supplementary_ok
        if not aggregatable:
            aggregatable = records  # nothing usable — report what we have

        outcome.accounts = records
        outcome.row_status = aggregate_status([r.status for r in aggregatable])
        outcome.confidence = min_confidence([r.confidence for r in aggregatable])
        outcome.evidence = " | ".join(
            (f"[{r.jurisdiction_label}] " if r.jurisdiction_label else "")
            + f"{r.account_searched}: {r.evidence}"
            for r in records if r.evidence
        )[:3000]
        if outcome.row_status in (NEEDS_REVIEW, UNREACHABLE):
            outcome.needs_review_reason = next(
                (r.evidence for r in aggregatable if r.status in (NEEDS_REVIEW, UNREACHABLE)),
                None,
            )
        outcome.status_note = build_row_note(
            aggregatable, outcome.row_status, self.today
        )
        if outcome.discovered_url:
            outcome.status_note += f" | portal: {outcome.discovered_url}"
        skipped = row.check_urls_skipped()
        if skipped:
            outcome.status_note += " | " + "; ".join(skipped)

        # ---- the Amount Due cell (gated by §7: verified rows only) ------
        # Summed from `aggregatable`, not the full `records` — an excluded
        # supplementary record (see above) may still carry a contradictory
        # figure (e.g. the ultimate_payment_due>0-with-PAID cross-check in
        # validate.py) even while flagged NEEDS_REVIEW; it must not leak
        # into the written amounts for a row whose STATUS ignored it.
        if outcome.confidence != LOW and outcome.row_status not in (
            NEEDS_REVIEW, UNREACHABLE,
        ):
            dues = [r.amount_due for r in aggregatable if r.amount_due]
            if outcome.row_status in (UNPAID, PARTIAL, DELINQUENT) and dues:
                outcome.write_amount_due = round(sum(dues), 2)

            # ---- PTAX_Master structured cells (S–V) — aggregated from
            # the per-account records the same way the live amount-due
            # is aggregated. PAID rows are valid here too: a paid bill
            # has ultimate=0 and a posted payment date/amount worth
            # writing into the template.
            uds = [r.ultimate_payment_due for r in aggregatable
                   if r.ultimate_payment_due is not None]
            if uds:
                outcome.write_ultimate_payment_due = round(sum(uds), 2)
            paid_amts = [r.amount_paid for r in aggregatable if r.amount_paid is not None]
            if paid_amts:
                outcome.write_payment_amount = round(sum(paid_amts), 2)
            # Most recent posted payment date wins (max ISO string).
            paid_dates = sorted(r.date_paid for r in aggregatable if r.date_paid)
            if paid_dates:
                outcome.write_payment_date = paid_dates[-1]
            # Earliest upcoming deadline wins (min ISO string), pulling
            # from each account's next_due_date and due_dates[*].
            upcoming: list[str] = []
            for r in aggregatable:
                if r.next_due_date:
                    upcoming.append(r.next_due_date)
                upcoming.extend(r.due_dates or [])
            if upcoming:
                outcome.write_next_due_date = min(upcoming)

        return outcome

    # ------------------------------------------------------------------
    async def _process_url(
        self,
        job: RowJob,
        url: str,
        url_label: str | None,
        outcome: RowOutcome,
    ) -> list[AccountRecord]:
        """Run the full per-URL body — playbook match, taxonomy
        classification, roll-type/domain resolution, and the row's account
        ladder — against ONE portal URL. Returns the AccountRecords produced
        (one per account group on the row).

        `url_label` is the jurisdiction label ("Website", "Jurisdiction
        link secondary", …) when the row has more than one URL to check;
        None for the common single-URL case, so a single-URL row's records
        get `jurisdiction_label=None` — identical to before this method
        existed.

        `portal_dead` (a Type-E block/login-wall discovered mid-ladder) is
        scoped to THIS url only: a dead Website portal must not skip a
        different jurisdiction link's account checks for the same row.
        """
        row = job.row
        playbook = match_playbook(url, self.playbooks)
        taxonomy = classify_url(url, playbook)
        roll_type = _roll_type_for(row)
        domain = domain_of(url)

        groups = row.accounts or [
            AccountCandidates(display=row.address or "property", candidates=[])
        ]
        multi_note = None
        if len(groups) > 1:
            ids = ", ".join(g.display for g in groups)
            multi_note = (
                f"This spreadsheet row covers {len(groups)} separate accounts "
                f"({ids}). THIS task is about ONE of them only — see the "
                "search value."
            )

        records: list[AccountRecord] = []
        portal_dead = False

        for group in groups:
            if portal_dead:
                rec = _needs_review_record(
                    group.display, "portal blocked earlier in this row"
                )
                rec.jurisdiction_label = url_label
                records.append(rec)
                continue
            rec, dead = await self._check_account(
                job, group, url, domain, taxonomy, roll_type, playbook,
                multi_note, outcome,
            )
            rec.jurisdiction_label = url_label
            records.append(rec)
            portal_dead = dead

        return records

    # ------------------------------------------------------------------
    async def _check_account(
        self,
        job: RowJob,
        group: AccountCandidates,
        url: str,
        domain: str,
        taxonomy: str,
        roll_type: str,
        playbook: Playbook | None,
        multi_note: str | None,
        outcome: RowOutcome,
    ) -> tuple[AccountRecord, bool]:
        """Run the attempt ladder for ONE account. Returns
        (record, portal_dead)."""
        row = job.row

        def _log_fail(reason: str) -> None:
            # Durable trail for "why did this row fail" — the terminal
            # evidence text only keeps the LAST reason, but every
            # attempt's real reason (including a Playwright recipe's
            # actual exception, once `notes` is populated) lands in
            # the run's Firestore event log as it happens, so a failed
            # row can be diagnosed after the fact without re-running it.
            self.store.log_event("warning", reason, job.key)

        # §4B input ladder: account candidates → street address → owner.
        terms: list[tuple[str, str]] = [
            ("account/parcel number", c) for c in group.candidates[:3]
        ]
        street = (row.address or "").split(",")[0].strip()
        if street:
            terms.append(("street address", street))
        if row.owner_entity:
            terms.append(("owner entity name", row.owner_entity))
        if not terms:
            return (
                _needs_review_record(group.display, "row has no account, address or owner to search by"),
                False,
            )
        terms = terms[: self.cfg.max_attempts_per_account + 1]

        current_type = taxonomy
        switched_after_search = False
        last_reason = "no attempt succeeded"
        idx = 0
        calls = 0

        while idx < len(terms) and calls <= self.cfg.max_attempts_per_account:
            label, value = terms[idx]
            ctx = PromptContext(
                url=url,
                address=row.full_address,
                county=row.county,
                state=row.state,
                owner_entity=row.owner_entity,
                roll_type=roll_type,
                search_label=label,
                search_value=value,
                other_candidates=[c for c in group.candidates if c != value],
                playbook=playbook,
                multi_account_note=multi_note,
            )
            prompt = build_prompt(current_type, ctx)
            title = f"{row.county or domain} · {group.display} · {label}"
            self.store.log_event(
                "info",
                f"attempt {calls + 1}: type {current_type}, {label}={value!r}",
                job.key,
            )
            calls += 1
            try:
                attempt = await self.runner.run_attempt(
                    domain, url, prompt, EXTRACTION_SCHEMA, title,
                    # Skyvern ignores `row`/`group_candidates`/`row_key`;
                    # Playwright recipes drive their search ladder from
                    # `group_candidates` (THIS account's candidates only
                    # — never the whole row's, see CLAUDE.md §9 Pinellas
                    # multi-account-cell case) and scope their result
                    # cache by `row_key` + the candidate set so two
                    # different account groups on one row, or two
                    # different rows sharing one bare search URL
                    # (CLAUDE.md §9 Broward case), never collide.
                    row=row,
                    group_candidates=group.candidates,
                    row_key=job.key,
                )
            except Exception as exc:  # noqa: BLE001 — transport/SDK error
                last_reason = f"runner error: {exc}"
                log.warning("[%s] %s", job.key, last_reason)
                _log_fail(last_reason)
                continue

            if attempt.run_id:
                outcome.skyvern_run_ids.append(attempt.run_id)
            if attempt.recording_url:
                outcome.recording_urls.append(attempt.recording_url)
            if attempt.app_url:
                outcome.app_urls.append(attempt.app_url)

            if attempt.status in ("failed", "terminated", "timed_out", "canceled"):
                last_reason = (
                    f"skyvern run {attempt.status}: {attempt.failure_reason or ''}"
                ).strip()
                _log_fail(last_reason)
                continue

            extraction = coerce_output(attempt.output)
            page_outcome = extraction.get("page_outcome", "error")

            if page_outcome == "login_required":
                reason = "portal requires an account login — humans only (§ Type E)"
                _log_fail(reason)
                return _needs_review_record(group.display, reason), True
            if page_outcome == "blocked":
                notes = (extraction.get("notes") or "").strip()
                reason = "portal blocked automated access (CAPTCHA/WAF held)"
                _log_fail(f"{reason}: {notes}" if notes else reason)
                return _needs_review_record(group.display, reason), True
            if page_outcome == "pdf_only":
                rec = await self._pdf_path(job, group, url, domain)
                return rec, False

            if page_outcome == "landed_on_search" and current_type in (TYPE_A, TYPE_D):
                # Stale deep link/token (§ Type A) → re-run as a search.
                current_type = TYPE_B
                if not switched_after_search:
                    switched_after_search = True
                    continue  # same term, search path
                idx += 1
                continue

            if page_outcome in ("no_matching_property", "error"):
                # `notes` carries the real failure (e.g. a Playwright
                # RecipeError message) when the runner has one. Prefer
                # it over the generic "(searched X = Y)" template,
                # which is misleading whenever this attempt was a
                # cache replay rather than a fresh search (the
                # Playwright generic navigator resolves a whole
                # account group in one browser session, so attempts
                # 2+ for the same group are cache hits — see
                # playwright_engine/runner.py's cache-key note — and
                # the "searched {label}" text then names a term that
                # was never actually searched).
                notes = (extraction.get("notes") or "").strip()
                last_reason = (
                    f"{page_outcome}: {notes}" if notes
                    else f"{page_outcome} (searched {label} = {value!r})"
                )
                _log_fail(last_reason)
                idx += 1
                continue

            if page_outcome == "ambiguous_multiple_matches":
                last_reason = f"multiple results for {label}={value!r}"
                _log_fail(last_reason)
                idx += 1
                continue

            # ---- account_found → verify before extracting (§6) ----------
            verdict = assess_match(
                group.candidates, row.owner_entity, row.address, extraction
            )
            if not verdict.matched and self.cfg.anthropic_api_key:
                claude = await adjudicate_with_claude(
                    self.cfg.anthropic_api_key,
                    self.cfg.anthropic_model,
                    {
                        "address": row.full_address,
                        "owner_entity": row.owner_entity,
                        "account_candidates": group.candidates,
                        "county": row.county,
                    },
                    extraction,
                )
                if claude is not None and claude.matched:
                    verdict = claude
            if not verdict.matched:
                last_reason = f"wrong record: {verdict.reason or verdict.basis}"
                _log_fail(last_reason)
                idx += 1
                continue

            rec = build_account_record(group.display, extraction, verdict)
            return rec, False

        # Technical failures (transport / browser errors on either
        # engine) are UNREACHABLE — the Retry button re-queues them.
        # NEEDS_REVIEW is reserved for business outcomes a human must
        # look at. The two error prefixes here are the historical
        # "skyvern error:" wording (kept for back-compat with the
        # status-note matcher) and the new engine-agnostic
        # "runner error:" wording the orchestrator now emits.
        if last_reason.startswith("skyvern") or last_reason.startswith("runner"):
            return _unreachable_record(group.display, last_reason), False
        return _needs_review_record(group.display, last_reason), False

    # ------------------------------------------------------------------
    async def _pdf_path(
        self,
        job: RowJob,
        group: AccountCandidates,
        url: str,
        domain: str,
    ) -> AccountRecord:
        # (kept signature minimal — fast mode needs no page extraction here)
        """§4F — bill exists only as a PDF: download it (the one permitted
        artifact), parse the amount due, NEEDS_REVIEW when unparseable."""
        row = job.row
        goal = (
            f"Download the {row.tax_year or 'most recent'} property tax bill "
            f"PDF for the property at {row.full_address} "
            f"(account {group.display}). READ-ONLY: never click Pay/Add to "
            "Cart, never enter payment information."
        )
        try:
            result = await self.runner.download_bill_pdf(domain, url, goal)
        except Exception as exc:  # noqa: BLE001
            return _needs_review_record(group.display, f"PDF download failed: {exc}")
        if result.run_id:
            self.store.log_event("info", f"pdf download run {result.run_id}", job.key)

        file_url = None
        for f in result.downloaded_files or []:
            file_url = (
                getattr(f, "url", None)
                or getattr(f, "presigned_url", None)
                or (f.get("url") if isinstance(f, dict) else None)
                or (f.get("presigned_url") if isinstance(f, dict) else None)
                or (f if isinstance(f, str) else None)
            )
            if file_url:
                break
        if not file_url:
            return _needs_review_record(
                group.display, "portal is PDF-only and no bill PDF could be downloaded"
            )

        data = await pdf_bill.fetch_pdf(file_url)
        parsed = pdf_bill.parse_bill_pdf(data, row.tax_year) if data else None
        if parsed is None:
            return _needs_review_record(
                group.display,
                f"bill PDF unparseable (likely scanned) — saved as evidence: {file_url}",
            )

        bill = (parsed.get("bills") or [{}])[0]
        fast_extraction = {
            "page_outcome": "account_found",
            "amount_due_now": bill.get("amount_due"),
            "includes_delinquency": None,
            "owner_on_page": parsed.get("owner_on_page"),
            "situs_address_on_page": parsed.get("situs_address_on_page"),
            "parcel_or_account_on_page": parsed.get("parcel_or_account_on_page"),
            "final_url": file_url,
        }
        verdict = assess_match(
            group.candidates, row.owner_entity, row.address, fast_extraction
        )
        if not verdict.matched:
            verdict = MatchVerdict(
                matched=True,
                basis="bill PDF downloaded via portal search for this account",
                owner_mismatch=False,
                confidence_hint=MEDIUM,
            )
        rec = build_account_record(group.display, fast_extraction, verdict)
        rec.evidence = (rec.evidence or "") + f"; PDF: {file_url}"
        if rec.confidence == HIGH:
            rec.confidence = MEDIUM
        return rec

    # ------------------------------------------------------------------
    def _learn_vendor(self, url: str, extraction: dict[str, Any], taxonomy: str) -> None:
        """§4.7 — unseen vendor solved generically → grow the library."""
        footer = extraction.get("vendor_footer")
        if match_playbook(url, self.playbooks, footer) is not None:
            return
        if not footer and not url:
            return
        pb = draft_playbook(
            vendor_footer=footer,
            url=url,
            taxonomy=taxonomy,
            observations=(
                f"First seen on {domain_of(url)}; page type "
                f"{extraction.get('page_type_observed')}; bills shown as "
                f"{len(extraction.get('bills') or [])} per-year entries."
            ),
        )
        if self.store.upsert_playbook(pb):
            self.playbooks.append(pb)
            self.new_playbooks.append(f"{pb.key} ({pb.vendor_name})")
            self.store.log_event("info", f"new vendor playbook: {pb.key}")


# ===========================================================================
# Run driver
# ===========================================================================

def build_summary(
    sheets: list[SheetIntake],
    outcomes: dict[str, RowOutcome],
    new_playbooks: list[str],
    headers_added: dict[str, dict[str, str]],
    discovered_urls: list[str],
    canceled: bool,
) -> dict[str, Any]:
    counts: dict[str, int] = {}
    review_rows = []
    for oc in outcomes.values():
        counts[oc.row_status] = counts.get(oc.row_status, 0) + 1
        if oc.row_status in (NEEDS_REVIEW, UNREACHABLE):
            review_rows.append({
                "sheet": oc.sheet_name,
                "row": oc.row_number,
                "reason": oc.needs_review_reason or oc.status_note,
            })
    mapping_notes = [n for s in sheets for n in s.ambiguous]
    notes = list(discovered_urls)
    if discovered_urls:
        notes.append("add the discovered portal URLs to the spreadsheet for next time")
    if canceled:
        notes.append("run was canceled — unprocessed rows are marked NOT CHECKED")
    first = next(iter(headers_added.values()), {})
    return {
        "status_counts": counts,
        "new_playbooks": new_playbooks,
        "review_rows": review_rows,
        "mapping_notes": mapping_notes,
        "status_column_header": first.get("status"),
        "amount_column_header": first.get("amount"),
        "notes": notes,
    }


async def execute_run(
    store: RunStore,
    cfg: Config,
    resume: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    today = dt.date.today()
    meta = store.claim_run()
    log.info("run %s: %s", store.run_id, meta.get("file_name"))

    local_input = store.fetch_input()
    intake = parse_workbook(local_input)
    if not intake.sheets:
        store.fail_run(
            "no processable sheet found (need a detectable header row plus "
            "at least one data row with a URL or account number)"
        )
        raise RuntimeError("workbook has no processable sheets")

    jobs: list[RowJob] = []
    planned = []
    for s_idx, sheet in enumerate(intake.sheets):
        for row in sheet.rows:
            key = row_key(s_idx, row.row_number)
            jobs.append(RowJob(key, s_idx, sheet, row))
            planned.append((key, s_idx, row, sheet))
    store.save_intake(intake.sheets, planned)
    store.log_event(
        "info",
        f"intake: {len(intake.sheets)} sheet(s), {len(jobs)} rows planned",
    )

    pending = store.pending_keys(resume)
    todo = [j for j in jobs if j.key in pending]
    log.info("%d/%d rows pending", len(todo), len(jobs))

    # ---- Engine selection ------------------------------------------------
    # `engine` rides on the run document (`tax_checker_runs/{id}.engine`)
    # set at upload time from the UI's engine tab. The two engines
    # implement the same SkyvernRunner-shaped surface, so the rest of
    # this function does not branch.
    engine = (meta.get("engine") or DEFAULT_ENGINE).lower()
    if engine not in ("skyvern", "playwright"):
        log.warning("unknown engine %r in run doc; falling back to %s",
                    engine, DEFAULT_ENGINE)
        engine = DEFAULT_ENGINE
    runner: SkyvernRunner | PlaywrightRunner
    if engine == "playwright":
        runner = PlaywrightRunner(cfg)
        log.info("engine: playwright (recipes + Claude Haiku extraction)")
    else:
        runner = SkyvernRunner(cfg)
        log.info("engine: skyvern (vision agent)")
    store.log_event("info", f"engine: {engine}")
    playbooks = store.load_playbooks()
    processor = RowProcessor(cfg, runner, playbooks, store, dry_run, today)

    # Reap any browser sessions left over from a prior killed/crashed
    # execution before opening new ones — runs are serialized, so anything
    # still open now is orphaned and is eating the plan's session quota.
    if not dry_run:
        reaped = await runner.reap_orphaned_sessions()
        if reaped:
            store.log_event(
                "info", f"reaped {reaped} orphaned browser session(s) at startup"
            )

    # Group by shared portal domain — same portal: one session, sequential,
    # polite. A row can now touch MULTIPLE domains (its Website's domain
    # plus each non-empty Jurisdiction Link's domain), so this is a
    # connected-components grouping rather than a single-domain-per-job
    # dict: two jobs land in the same sequential bucket if they share ANY
    # domain, even when that shared domain is only a secondary/tertiary
    # link on one of them — otherwise two different rows could be
    # scheduled concurrently against the same live portal.
    domain_groups = _group_jobs_by_shared_domain(todo)

    sem = asyncio.Semaphore(max(1, cfg.max_concurrency))
    canceled = False

    async def run_domain(domain_jobs: list[RowJob]) -> None:
        async with sem:
            for job in domain_jobs:
                if canceled:
                    return
                store.mark_in_progress(job.key)
                try:
                    outcome = await processor.process(job)
                    store.save_outcome(job.key, outcome)
                except asyncio.CancelledError:
                    # Cancel requested mid-row: abort on the spot. The row
                    # keeps its in_progress state and gets no outcome, so
                    # write-back reports it NOT CHECKED (retryable).
                    raise
                except Exception as exc:  # noqa: BLE001 — never abort the run
                    err = f"{type(exc).__name__}: {exc}"
                    log.error("[%s] row failed: %s\n%s", job.key, err,
                              traceback.format_exc(limit=4))
                    oc = RowOutcome(
                        row_key=job.key,
                        sheet_name=job.sheet.name,
                        row_number=job.row.row_number,
                        accounts=[_unreachable_record(
                            job.row.account_raw or job.row.address or "?", err
                        )],
                        row_status=UNREACHABLE,
                        status_note=f"NEEDS REVIEW — portal unreachable ({err[:200]})",
                        confidence=LOW,
                        needs_review_reason=err[:500],
                    )
                    store.mark_failed(job.key, err, oc)

    work = asyncio.gather(*(run_domain(js) for js in domain_groups))

    async def watch_cancel() -> None:
        # Poll the cancel flag while rows run; on cancel, abort the in-flight
        # tasks immediately rather than waiting for them to finish.
        nonlocal canceled
        while not work.done():
            if store.cancel_requested():
                canceled = True
                log.info("cancel requested — aborting %d in-flight row(s)",
                         cfg.max_concurrency)
                work.cancel()
                return
            await asyncio.sleep(CANCEL_POLL_SECONDS)

    watcher = asyncio.ensure_future(watch_cancel())
    try:
        await work
    except asyncio.CancelledError:
        canceled = True
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watcher
        await runner.close_all()

    # Rows aborted mid-flight by an on-the-spot cancel are left in_progress;
    # flip them back to pending so they read NOT CHECKED and stay retryable.
    if canceled:
        n = store.reset_in_progress()
        if n:
            log.info("cancel: reset %d in-flight row(s) to pending", n)

    # ---- write-back (§10): every planned row gets a line ----------------
    store.set_status("writing_back")
    outcomes = store.collect_outcomes()
    out_name = output_filename(
        meta.get("file_name") or os.path.basename(local_input), today
    )
    out_local = os.path.join(tempfile.mkdtemp(prefix="taxout_"), out_name)
    headers_added = write_output(intake, outcomes, today, out_local)
    output_path = store.put_output(out_local, out_name)

    summary = build_summary(
        intake.sheets, outcomes, processor.new_playbooks,
        headers_added, processor.discovered_urls, canceled,
    )
    failed_rows = sum(
        1 for oc in outcomes.values()
        if oc.row_status in (NEEDS_REVIEW, UNREACHABLE)
    )
    unprocessed = len(jobs) - len(outcomes)
    store.finish(
        summary,
        output_path,
        out_name,
        failed=(failed_rows > 0 or unprocessed > 0),
        canceled=canceled,
    )
    log.info(
        "run %s finished: %s (%d rows need review, %d not processed)",
        store.run_id, summary["status_counts"], failed_rows, unprocessed,
    )
    return summary
