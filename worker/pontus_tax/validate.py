"""Validation — FAST MODE.

One number per account: the amount still owed now. Verified $0.00 → PAID;
verified balance → UNPAID (DELINQUENT when the page says any of it is past
due); no figure / no verification → NEEDS_REVIEW. Nothing reaches a
spreadsheet cell except through here.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from .canonical import (
    PAID, PARTIAL, UNPAID, DELINQUENT, NEEDS_REVIEW, UNREACHABLE,
    LOW,
    AccountRecord,
)
from .verify import MatchVerdict

_DATE_FORMATS = (
    "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%B %d, %Y", "%b %d, %Y",
    "%m-%d-%Y", "%d-%b-%Y", "%Y/%m/%d",
)


def parse_money(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("$", "").replace(",", "")
    s = re.sub(r"\s", "", s)
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    if not s or not re.fullmatch(r"-?\d+(\.\d+)?", s):
        return None
    val = float(s)
    return -val if neg else val


def parse_date(v: Any) -> dt.date | None:
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()
    for fmt in _DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        mm, dd, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if yy < 100:
            yy += 2000
        try:
            return dt.date(yy, mm, dd)
        except ValueError:
            return None
    return None


def fmt_money(v: float | None) -> str:
    return f"${v:,.2f}" if v is not None else "$—"


def fmt_date(d: dt.date | None) -> str:
    return f"{d.month}/{d.day}/{d.year}" if d else "—"


def _parse_iso_date(v: Any) -> str | None:
    """Coerce assorted date strings into ISO yyyy-mm-dd; return None on fail."""
    d = parse_date(v)
    return d.isoformat() if d else None


def _parse_due_dates(raw: Any) -> list[str]:
    """Accept list[str|date] (preferred) or a single string; drop unparseables."""
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[str] = []
    for item in items:
        iso = _parse_iso_date(item)
        if iso:
            out.append(iso)
    return out


def _round_money_or_none(raw: Any) -> float | None:
    m = parse_money(raw)
    return round(m, 2) if m is not None else None


def cross_check_ultimate_due(rec: AccountRecord) -> tuple[str, str | None]:
    """Reconcile rec.ultimate_payment_due with rec.status.

    Returns (new_status, evidence_note_or_None). The caller is responsible
    for applying the new_status and appending the note.

    Rules (spec):
    - ultimate_payment_due > 0 with status PAID → NEEDS_REVIEW
      (contradiction; cannot trust a $0-due claim when the bill still owes)
    - ultimate_payment_due ≈ 0 with non-null date_paid or amount_paid
      and current status UNPAID/PARTIAL → upgrade to PAID
      (payment evidence backs a zero balance; the live amount was stale)
    - Otherwise, no change.
    """
    if rec.ultimate_payment_due is None:
        return rec.status, None

    if rec.ultimate_payment_due > 0.005 and rec.status == PAID:
        note = (
            f"contradiction: ultimate due {fmt_money(rec.ultimate_payment_due)}"
            " but status PAID"
        )
        return NEEDS_REVIEW, note

    if (
        rec.ultimate_payment_due <= 0.005
        and rec.status in (UNPAID, PARTIAL)
        and (rec.date_paid or rec.amount_paid is not None)
    ):
        note = "ultimate due $0 with payment evidence → upgraded to PAID"
        return PAID, note

    return rec.status, None


def build_account_record(
    account_display: str,
    extraction: dict[str, Any],
    verdict: MatchVerdict,
) -> AccountRecord:
    """Map a verified fast extraction onto the canonical record."""
    rec = AccountRecord(
        account_searched=account_display,
        source_url=extraction.get("final_url"),
    )
    bits = [f"matched by {verdict.basis}"]
    if verdict.owner_mismatch:
        bits.append("owner on page differs (possible recent sale)")

    due = parse_money(extraction.get("amount_due_now"))
    if due is None:
        rec.status = NEEDS_REVIEW
        rec.confidence = LOW
        bits.append("no amount-due figure found on the page")
    elif due <= 0.005:
        rec.status = PAID
        rec.amount_due = 0.0
        rec.confidence = verdict.confidence_hint
    else:
        rec.amount_due = round(due, 2)
        rec.status = (
            DELINQUENT if extraction.get("includes_delinquency") else UNPAID
        )
        rec.confidence = verdict.confidence_hint

    # Structured payment fields layer on top of the status decision. Skyvern
    # may return them under the spec's external names (payment_date /
    # payment_amount) — map onto the canonical date_paid / amount_paid so
    # downstream code keeps reading the existing field names.
    rec.ultimate_payment_due = _round_money_or_none(
        extraction.get("ultimate_payment_due")
    )
    rec.amount_paid = _round_money_or_none(extraction.get("payment_amount"))
    pay_date = _parse_iso_date(extraction.get("payment_date"))
    if pay_date:
        rec.date_paid = pay_date
    rec.due_dates = _parse_due_dates(extraction.get("due_dates"))

    new_status, note = cross_check_ultimate_due(rec)
    if note:
        rec.status = new_status
        bits.append(note)
        # A NEEDS_REVIEW from contradiction is uncertain by definition;
        # never let it ride at HIGH confidence into the dashboard.
        if new_status == NEEDS_REVIEW:
            rec.confidence = LOW

    rec.evidence = "; ".join(bits)
    return rec


# --------------------------------------------------------------------------
# Status line for the workbook (§10.2, fast form)
# --------------------------------------------------------------------------

def account_phrase(rec: AccountRecord, as_of: dt.date) -> str:
    if rec.status == PAID:
        return "Paid — $0.00 due"
    if rec.status == DELINQUENT:
        return f"DELINQUENT — {fmt_money(rec.amount_due)} owed as of {fmt_date(as_of)}"
    if rec.status == UNPAID:
        return f"OWES {fmt_money(rec.amount_due)} as of {fmt_date(as_of)}"
    if rec.status == UNREACHABLE:
        return "NEEDS REVIEW — portal unreachable"
    return f"NEEDS REVIEW — {rec.evidence or 'could not verify'}"


def build_row_note(
    records: list[AccountRecord],
    row_status: str,
    as_of: dt.date,
) -> str:
    """One short line per row. Multi-account rows still report every open
    account explicitly (§5.6)."""
    if not records:
        return "NEEDS REVIEW — row could not be checked"
    if len(records) == 1:
        return account_phrase(records[0], as_of)
    if row_status == PAID:
        return f"All {len(records)} accounts paid — $0.00 due"
    total = sum(r.amount_due or 0 for r in records)
    parts = [f"{r.account_searched}: {account_phrase(r, as_of)}" for r in records]
    return f"{fmt_money(total)} owed across {len(records)} accounts — " + "; ".join(parts)
