"""Run orchestration — Excel in → portal lookup per row → Excel out.

One row's failure never aborts the run (per-row try/except, resumable
scrape_state). Rows sharing a portal run sequentially on a shared browser
session with polite delays; distinct portals run concurrently up to
MAX_CONCURRENCY.
"""

from __future__ import annotations

import asyncio
import base64
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
from .store import RunStore, row_key
from .taxonomy import TYPE_A, TYPE_B, TYPE_D, classify_url, domain_of
from .validate import build_account_record, build_row_note
from .verify import MatchVerdict, adjudicate_with_claude, assess_match
from .writeback import output_filename, write_output
from . import pdf_bill

log = logging.getLogger("pontus_tax.orchestrator")


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
        runner: SkyvernRunner,
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

        # ---- portal URL (§4.6: discover when the cell is empty) --------
        url = row.url
        if not url:
            if row.county:
                url = await discover_portal(row.county, row.state)
            if url:
                outcome.discovered_url = url
                self.discovered_urls.append(
                    f"{job.sheet.name} row {row.row_number}: discovered {url}"
                )
            else:
                outcome.row_status = NEEDS_REVIEW
                outcome.needs_review_reason = (
                    "no portal URL in the sheet and no official portal found"
                )
                outcome.status_note = f"NEEDS REVIEW — {outcome.needs_review_reason}"
                outcome.confidence = LOW
                return outcome

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
                records.append(
                    _needs_review_record(group.display, "portal blocked earlier in this row")
                )
                continue
            rec, dead = await self._check_account(
                job, group, url, domain, taxonomy, roll_type, playbook,
                multi_note, outcome,
            )
            records.append(rec)
            portal_dead = dead

        # ---- aggregate (§5.6) ------------------------------------------
        outcome.accounts = records
        outcome.row_status = aggregate_status([r.status for r in records])
        outcome.confidence = min_confidence([r.confidence for r in records])
        outcome.evidence = " | ".join(
            f"{r.account_searched}: {r.evidence}" for r in records if r.evidence
        )[:3000]
        if outcome.row_status in (NEEDS_REVIEW, UNREACHABLE):
            outcome.needs_review_reason = next(
                (r.evidence for r in records if r.status in (NEEDS_REVIEW, UNREACHABLE)),
                None,
            )
        outcome.status_note = build_row_note(
            records, outcome.row_status, self.today
        )
        if outcome.discovered_url:
            outcome.status_note += f" | portal: {outcome.discovered_url}"

        # ---- the Amount Due cell (gated by §7: verified rows only) ------
        if outcome.confidence != LOW and outcome.row_status not in (
            NEEDS_REVIEW, UNREACHABLE,
        ):
            dues = [r.amount_due for r in records if r.amount_due]
            if outcome.row_status in (UNPAID, PARTIAL, DELINQUENT) and dues:
                outcome.write_amount_due = round(sum(dues), 2)

        return outcome

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
                    domain, url, prompt, EXTRACTION_SCHEMA, title
                )
            except Exception as exc:  # noqa: BLE001 — transport/SDK error
                last_reason = f"skyvern error: {exc}"
                log.warning("[%s] %s", job.key, last_reason)
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
                continue

            extraction = coerce_output(attempt.output)
            page_outcome = extraction.get("page_outcome", "error")

            if page_outcome == "login_required":
                return (
                    _needs_review_record(
                        group.display,
                        "portal requires an account login — humans only (§ Type E)",
                    ),
                    True,
                )
            if page_outcome == "blocked":
                return (
                    _needs_review_record(
                        group.display,
                        "portal blocked automated access (CAPTCHA/WAF held)",
                    ),
                    True,
                )
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
                last_reason = (
                    f"{page_outcome} (searched {label} = {value!r})"
                )
                idx += 1
                continue

            if page_outcome == "ambiguous_multiple_matches":
                last_reason = f"multiple results for {label}={value!r}"
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
                idx += 1
                continue

            rec = build_account_record(group.display, extraction, verdict)
            return rec, False

        # Technical failures (Skyvern transport/browser errors) are
        # UNREACHABLE — the Retry button re-queues them. NEEDS_REVIEW is
        # reserved for business outcomes a human must look at.
        if last_reason.startswith("skyvern"):
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

    runner = SkyvernRunner(cfg)
    playbooks = store.load_playbooks()
    processor = RowProcessor(cfg, runner, playbooks, store, dry_run, today)

    # Group by portal domain — same portal: one session, sequential, polite.
    by_domain: dict[str, list[RowJob]] = {}
    for job in todo:
        domain = domain_of(job.row.url) if job.row.url else (
            f"discover:{(job.row.county or 'unknown').lower()}-{(job.row.state or '').lower()}"
        )
        by_domain.setdefault(domain, []).append(job)

    sem = asyncio.Semaphore(max(1, cfg.max_concurrency))
    canceled = False

    async def run_domain(domain: str, domain_jobs: list[RowJob]) -> None:
        nonlocal canceled
        async with sem:
            for job in domain_jobs:
                if canceled or store.cancel_requested():
                    canceled = True
                    return
                store.mark_in_progress(job.key)
                try:
                    outcome = await processor.process(job)
                    store.save_outcome(job.key, outcome)
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

    try:
        await asyncio.gather(*(
            run_domain(d, js) for d, js in sorted(by_domain.items())
        ))
    finally:
        await runner.close_all()

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
