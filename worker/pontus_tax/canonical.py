"""The universal extraction schema (CLAUDE.md §3) and row outcome shapes.

Whatever the portal looks like, every (row, account, tax year) resolves to
an AccountRecord. Fields that cannot be filled stay None — never invented.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

# Row/account statuses — §3
PAID = "PAID"
PARTIAL = "PARTIAL"
UNPAID = "UNPAID"
DELINQUENT = "DELINQUENT"
NEEDS_REVIEW = "NEEDS_REVIEW"
UNREACHABLE = "UNREACHABLE"

STATUSES = (PAID, PARTIAL, UNPAID, DELINQUENT, NEEDS_REVIEW, UNREACHABLE)

# Aggregation severity (§5.6): a row is PAID only if ALL accounts are paid;
# otherwise the row carries the worst account's status.
SEVERITY = {
    DELINQUENT: 5,
    UNPAID: 4,
    PARTIAL: 3,
    NEEDS_REVIEW: 2,
    UNREACHABLE: 1,
    PAID: 0,
}

HIGH = "HIGH"
MEDIUM = "MEDIUM"
LOW = "LOW"
CONFIDENCE_ORDER = {HIGH: 2, MEDIUM: 1, LOW: 0}


@dataclass
class AccountRecord:
    """Canonical per-account result — CLAUDE.md §3."""

    account_searched: str
    tax_year: str | None = None
    status: str = NEEDS_REVIEW
    amount_billed: float | None = None
    amount_paid: float | None = None
    amount_due: float | None = None
    date_paid: str | None = None
    receipt: str | None = None
    paid_by: str | None = None
    assessed_value: float | None = None
    next_due_date: str | None = None
    prior_year_balance: bool | None = None
    page_timestamp: str | None = None
    source_url: str | None = None
    evidence: str | None = None
    confidence: str = LOW

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RowOutcome:
    """Aggregated result for one spreadsheet row (may span several accounts)."""

    row_key: str
    sheet_name: str
    row_number: int
    accounts: list[AccountRecord] = field(default_factory=list)
    row_status: str = NEEDS_REVIEW
    status_note: str = ""
    confidence: str = LOW
    evidence: str = ""
    needs_review_reason: str | None = None
    skyvern_run_ids: list[str] = field(default_factory=list)
    recording_urls: list[str] = field(default_factory=list)
    app_urls: list[str] = field(default_factory=list)
    # Values to write into detected canonical columns (§10.2). Only set when
    # validation allowed them; write-back additionally refuses to erase.
    write_date_paid: str | None = None
    write_receipt: str | None = None
    write_assessed_value: float | None = None
    write_amount_due: float | None = None
    discovered_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["accounts"] = [a if isinstance(a, dict) else a for a in d["accounts"]]
        return d


def aggregate_status(statuses: list[str]) -> str:
    """§5.6 — PAID only if all paid; else the worst status wins."""
    if not statuses:
        return NEEDS_REVIEW
    if all(s == PAID for s in statuses):
        return PAID
    return max(statuses, key=lambda s: SEVERITY.get(s, 2))


def min_confidence(values: list[str]) -> str:
    if not values:
        return LOW
    return min(values, key=lambda c: CONFIDENCE_ORDER.get(c, 0))
