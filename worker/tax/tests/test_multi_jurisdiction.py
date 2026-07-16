"""Multi-jurisdiction checking: a row's Website PLUS any non-empty
Jurisdiction Link primary/secondary/tertiary columns must ALL be visited
and their results aggregated — not just Website, and not merely as a
fallback when Website fails (a single property can owe tax to more than
one taxing authority, e.g. county + a special assessment district).

Covers:
  - RowProcessor.process() fans out over every URL on the row and
    aggregates AccountRecords from all of them (canonical.aggregate_status
    is untouched — this only proves the orchestrator feeds it more inputs).
  - An exact-duplicate URL across two columns is checked exactly once.
  - A dead/blocked portal on one URL does not suppress checks on a
    DIFFERENT url for the same row (portal_dead resets per URL).
  - _group_jobs_by_shared_domain: the connected-components domain grouping
    that replaces the old single-domain-per-job dict in execute_run.
"""

from __future__ import annotations

import asyncio

import pytest

from pontus_tax.canonical import (
    DELINQUENT, PAID, UNPAID, AccountRecord,
)
from pontus_tax.config import Config
from pontus_tax.identifiers import AccountCandidates
from pontus_tax.intake import ColumnInfo, RowIntake, SheetIntake
from pontus_tax.orchestrator import (
    RowJob, RowProcessor, _group_jobs_by_shared_domain,
)
from pontus_tax.store import LocalStore


def _row(
    row_number=10,
    url=None,
    jurisdiction_link_primary=None,
    jurisdiction_link_secondary=None,
    jurisdiction_link_tertiary=None,
    account_raw="ACCT-1",
    county="Test",
    state="FL",
    address="1 Test St",
) -> RowIntake:
    return RowIntake(
        row_number=row_number,
        address=address,
        city="Testville",
        state=state,
        zip="00000",
        county=county,
        owner_entity="Pontus Test LLC",
        internal_id="PT0001",
        account_raw=account_raw,
        accounts=[AccountCandidates(display=account_raw, candidates=[account_raw])],
        tax_year="2025",
        url=url,
        jurisdiction_link_primary=jurisdiction_link_primary,
        jurisdiction_link_secondary=jurisdiction_link_secondary,
        jurisdiction_link_tertiary=jurisdiction_link_tertiary,
    )


def _sheet(rows: list[RowIntake]) -> SheetIntake:
    return SheetIntake(
        name="Property Tax",
        header_row=4,
        group_row=3,
        columns={},
        rows=rows,
        protected_columns=[],
        ambiguous=[],
        update_columns=[],
    )


def _job(row: RowIntake, sheet: SheetIntake, sheet_index=0) -> RowJob:
    from pontus_tax.store import row_key
    return RowJob(row_key(sheet_index, row.row_number), sheet_index, sheet, row)


def _make_processor(ptax_master_workbook) -> RowProcessor:
    store = LocalStore(ptax_master_workbook)
    cfg = Config()
    return RowProcessor(cfg, runner=None, playbooks=[], store=store, dry_run=False, today=__import__("datetime").date(2026, 7, 14))


# ---------------------------------------------------------------------------
# process() fans out over every url on the row
# ---------------------------------------------------------------------------


def test_process_checks_website_and_secondary_jurisdiction_link(
    ptax_master_workbook, monkeypatch,
):
    row = _row(
        url="https://county-a.example.com/tax",
        jurisdiction_link_secondary="https://district-b.example.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    calls: list[tuple[str, str]] = []

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        calls.append((url, group.display))
        if "county-a" in url:
            return AccountRecord(
                account_searched=group.display, status=PAID,
                confidence="HIGH", evidence="paid on county-a",
            ), False
        return AccountRecord(
            account_searched=group.display, status=UNPAID,
            confidence="HIGH", amount_due=250.0,
            evidence="owes on district-b",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)

    outcome = asyncio.run(processor.process(job))

    # Both URLs were actually visited.
    urls_visited = {u for u, _ in calls}
    assert urls_visited == {
        "https://county-a.example.com/tax",
        "https://district-b.example.com/tax",
    }
    assert len(outcome.accounts) == 2

    # One PAID + one UNPAID aggregates to UNPAID (existing severity rule in
    # canonical.aggregate_status — untouched by this feature).
    assert outcome.row_status == UNPAID

    # Each AccountRecord is traceable to the jurisdiction that produced it.
    labels = {r.jurisdiction_label for r in outcome.accounts}
    assert labels == {"Website", "Jurisdiction link secondary"}

    # Multi-url rows prefix the jurisdiction label into the evidence text.
    assert "[Website]" in outcome.evidence
    assert "[Jurisdiction link secondary]" in outcome.evidence


def test_process_checks_all_three_jurisdiction_links_plus_website(
    ptax_master_workbook, monkeypatch,
):
    row = _row(
        url="https://website.example.com/tax",
        jurisdiction_link_primary="https://primary.example.com/tax",
        jurisdiction_link_secondary="https://secondary.example.com/tax",
        jurisdiction_link_tertiary="https://tertiary.example.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    visited: list[str] = []

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        visited.append(url)
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    assert visited == [
        "https://website.example.com/tax",
        "https://primary.example.com/tax",
        "https://secondary.example.com/tax",
        "https://tertiary.example.com/tax",
    ]
    assert len(outcome.accounts) == 4
    assert outcome.row_status == PAID


# ---------------------------------------------------------------------------
# Exact-duplicate URL across columns is checked exactly once.
# ---------------------------------------------------------------------------


def test_duplicate_url_across_website_and_primary_checked_once(
    ptax_master_workbook, monkeypatch,
):
    shared_url = "https://same-portal.example.com/tax"
    row = _row(url=shared_url, jurisdiction_link_primary=shared_url)
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    call_count = 0

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        nonlocal call_count
        call_count += 1
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    assert call_count == 1
    assert len(outcome.accounts) == 1
    # Single-effective-url row → jurisdiction_label stays None (identical
    # to the pre-existing single-URL behavior/output).
    assert outcome.accounts[0].jurisdiction_label is None


# ---------------------------------------------------------------------------
# A dead/blocked portal on one URL must not suppress a DIFFERENT url's
# account checks for the same row — portal_dead resets per URL.
# ---------------------------------------------------------------------------


def test_portal_dead_on_website_does_not_skip_secondary_link(
    ptax_master_workbook, monkeypatch,
):
    row = _row(
        url="https://blocked-portal.example.com/tax",
        jurisdiction_link_secondary="https://working-portal.example.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        if "blocked-portal" in url:
            # Type-E block: portal_dead=True is returned to the caller.
            return AccountRecord(
                account_searched=group.display, status="NEEDS_REVIEW",
                confidence="LOW", evidence="portal blocked automated access",
            ), True
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    # Two records: the blocked Website account, and the secondary link's
    # account — the secondary link was NOT skipped by Website's
    # portal_dead flag.
    assert len(outcome.accounts) == 2
    by_label = {r.jurisdiction_label: r for r in outcome.accounts}
    assert by_label["Website"].status == "NEEDS_REVIEW"
    assert by_label["Jurisdiction link secondary"].status == PAID


def test_row_with_no_urls_at_all_and_no_county_stays_needs_review(
    ptax_master_workbook,
):
    # No Website, no jurisdiction links, no county to discover from —
    # preserve the exact existing NEEDS_REVIEW wording.
    row = _row(url=None, county=None)
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    outcome = asyncio.run(processor.process(job))
    assert outcome.row_status == "NEEDS_REVIEW"
    assert outcome.needs_review_reason == (
        "no portal URL in the sheet and no official portal found"
    )
    assert outcome.status_note == (
        "NEEDS REVIEW — no portal URL in the sheet and no official portal found"
    )


# ---------------------------------------------------------------------------
# _group_jobs_by_shared_domain: connected-components domain grouping.
# ---------------------------------------------------------------------------


def _plain_row(row_number, url=None, secondary=None, county=None, state=None):
    return _row(
        row_number=row_number, url=url,
        jurisdiction_link_secondary=secondary,
        county=county, state=state,
    )


def test_grouping_links_jobs_sharing_domain_via_secondary_and_website():
    # Job A's Website domain == Job B's secondary-link domain. They MUST
    # land in the same sequential bucket even though neither's Website
    # domain matches the other's Website domain.
    sheet = _sheet([])
    row_a = _plain_row(1, url="https://shared.example.com/tax")
    row_b = _plain_row(
        2,
        url="https://only-b.example.com/tax",
        secondary="https://shared.example.com/tax",
    )
    job_a = _job(row_a, sheet)
    job_b = _job(row_b, sheet)

    groups = _group_jobs_by_shared_domain([job_a, job_b])

    assert len(groups) == 1
    assert {j.key for j in groups[0]} == {job_a.key, job_b.key}


def test_grouping_keeps_disjoint_domain_jobs_in_separate_buckets():
    sheet = _sheet([])
    row_a = _plain_row(1, url="https://alpha.example.com/tax")
    row_b = _plain_row(2, url="https://beta.example.com/tax")
    job_a = _job(row_a, sheet)
    job_b = _job(row_b, sheet)

    groups = _group_jobs_by_shared_domain([job_a, job_b])

    assert len(groups) == 2
    all_keys = {j.key for g in groups for j in g}
    assert all_keys == {job_a.key, job_b.key}
    # Each bucket is a singleton — no accidental merge.
    assert all(len(g) == 1 for g in groups)


def test_grouping_buckets_discovery_placeholder_jobs_together():
    sheet = _sheet([])
    row_a = _plain_row(1, url=None, county="Duval", state="FL")
    row_b = _plain_row(2, url=None, county="Duval", state="FL")
    row_c = _plain_row(3, url=None, county="Orange", state="FL")
    job_a = _job(row_a, sheet)
    job_b = _job(row_b, sheet)
    job_c = _job(row_c, sheet)

    groups = _group_jobs_by_shared_domain([job_a, job_b, job_c])

    # Same discover:duval-fl placeholder → same bucket; Orange county is
    # a different placeholder domain → separate bucket.
    assert len(groups) == 2
    bucket_by_key = {j.key: idx for idx, g in enumerate(groups) for j in g}
    assert bucket_by_key[job_a.key] == bucket_by_key[job_b.key]
    assert bucket_by_key[job_c.key] != bucket_by_key[job_a.key]


# ---------------------------------------------------------------------------
# Regression (2026-07-16, real "with_urls" tracker run): a legitimately-
# real but blocked/inapplicable SUPPLEMENTARY jurisdiction link (a real
# second portal that hit a CAPTCHA, or genuinely doesn't recognize this
# property) must not drag an otherwise-good Website result down to
# NEEDS_REVIEW — that was observed for real on row 10 of the actual run
# ("1 Valpak Avenue": Website said PAID; Jurisdiction link primary
# pointed at a different, real domain that came back CAPTCHA-blocked;
# the row incorrectly reported NEEDS_REVIEW instead of PAID).
# ---------------------------------------------------------------------------


def test_blocked_supplementary_link_does_not_override_good_website_result(
    ptax_master_workbook, monkeypatch,
):
    row = _row(
        url="https://website.example-portal.com/tax",
        jurisdiction_link_primary="https://blocked.example-portal.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        if "blocked" in url:
            return AccountRecord(
                account_searched=group.display, status="NEEDS_REVIEW",
                confidence="LOW", evidence="portal blocked automated access",
            ), False
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid in full", amount_paid=100.0,
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    # The row reports PAID (Website's real result), not NEEDS_REVIEW —
    # the blocked supplementary link doesn't win the aggregation.
    assert outcome.row_status == PAID
    assert outcome.confidence == "HIGH"
    # Both records are still visible for audit — nothing is hidden.
    assert len(outcome.accounts) == 2
    # The blocked supplementary check is still visible in evidence.
    assert "portal blocked automated access" in outcome.evidence
    assert "[Jurisdiction link primary]" in outcome.evidence


def test_excluded_supplementary_record_does_not_contaminate_written_amounts(
    ptax_master_workbook, monkeypatch,
):
    # An excluded NEEDS_REVIEW supplementary record can still carry a
    # contradictory figure (e.g. validate.py's ultimate>0-with-PAID
    # cross-check) — it must not leak into write_amount_due /
    # write_ultimate_payment_due for a row whose STATUS ignored it.
    row = _row(
        url="https://website.example-portal.com/tax",
        jurisdiction_link_primary="https://blocked.example-portal.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        if "blocked" in url:
            return AccountRecord(
                account_searched=group.display, status="NEEDS_REVIEW",
                confidence="LOW",
                evidence="ultimate due $999 but reported PAID — flagged",
                ultimate_payment_due=999.0, amount_due=999.0,
            ), False
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid in full", amount_paid=100.0,
            date_paid="2026-01-01", ultimate_payment_due=0.0,
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    assert outcome.row_status == PAID
    # Website's own (real) ultimate_payment_due of 0 is written; the
    # excluded record's contradictory 999 must not be summed in.
    assert outcome.write_ultimate_payment_due == 0.0
    assert outcome.write_amount_due is None
    assert outcome.write_payment_amount == 100.0


def test_working_supplementary_link_still_wins_when_genuinely_worse(
    ptax_master_workbook, monkeypatch,
):
    # A REAL second jurisdiction that genuinely found a worse bill must
    # still win the aggregation — only a FAILED (NEEDS_REVIEW/UNREACHABLE)
    # supplementary link gets excluded, not a successful one.
    row = _row(
        url="https://website.example-portal.com/tax",
        jurisdiction_link_primary="https://district.example-portal.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        if "district" in url:
            return AccountRecord(
                account_searched=group.display, status=DELINQUENT,
                confidence="HIGH", amount_due=500.0,
                evidence="delinquent on special assessment",
            ), False
        return AccountRecord(
            account_searched=group.display, status=PAID, confidence="HIGH",
            evidence="paid in full",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    assert outcome.row_status == DELINQUENT


def test_website_failure_does_not_block_a_genuine_supplementary_finding(
    ptax_master_workbook, monkeypatch,
):
    row = _row(
        url="https://website.example-portal.com/tax",
        jurisdiction_link_primary="https://district.example-portal.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        if "district" in url:
            return AccountRecord(
                account_searched=group.display, status=UNPAID,
                confidence="HIGH", amount_due=250.0,
                evidence="owes on district",
            ), False
        return AccountRecord(
            account_searched=group.display, status="NEEDS_REVIEW",
            confidence="LOW", evidence="portal blocked automated access",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    # Website's own failure doesn't suppress a genuine, real finding from
    # a supplementary jurisdiction link.
    assert outcome.row_status == UNPAID


def test_all_urls_failing_still_reports_needs_review(
    ptax_master_workbook, monkeypatch,
):
    # Nothing usable anywhere — the fallback-to-everything path must
    # still report NEEDS_REVIEW, not silently drop to some default.
    row = _row(
        url="https://website.example-portal.com/tax",
        jurisdiction_link_primary="https://district.example-portal.com/tax",
    )
    sheet = _sheet([row])
    job = _job(row, sheet)
    processor = _make_processor(ptax_master_workbook)

    async def fake_check_account(
        self, job, group, url, domain, taxonomy, roll_type, playbook,
        multi_note, outcome,
    ):
        return AccountRecord(
            account_searched=group.display, status="NEEDS_REVIEW",
            confidence="LOW", evidence="portal blocked automated access",
        ), False

    monkeypatch.setattr(RowProcessor, "_check_account", fake_check_account)
    outcome = asyncio.run(processor.process(job))

    assert outcome.row_status == "NEEDS_REVIEW"
    assert len(outcome.accounts) == 2


def test_grouping_is_deterministic_across_repeated_calls():
    sheet = _sheet([])
    rows = [
        _plain_row(1, url="https://z-domain.example.com/tax"),
        _plain_row(2, url="https://a-domain.example.com/tax"),
        _plain_row(
            3, url="https://m-domain.example.com/tax",
            secondary="https://z-domain.example.com/tax",
        ),
    ]
    jobs = [_job(r, sheet) for r in rows]

    first = _group_jobs_by_shared_domain(jobs)
    second = _group_jobs_by_shared_domain(list(reversed(jobs)))

    def as_key_sets(groups):
        return sorted(tuple(sorted(j.key for j in g)) for g in groups)

    assert as_key_sets(first) == as_key_sets(second)
