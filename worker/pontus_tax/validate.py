"""Validation & confidence — CLAUDE.md §7 — plus the human-readable status
line per §10.2. Nothing reaches a spreadsheet cell except through here.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from .canonical import (
    PAID, PARTIAL, UNPAID, DELINQUENT, NEEDS_REVIEW, UNREACHABLE,
    HIGH, MEDIUM, LOW,
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


def year_label_matches(target_year: str | None, label: str | None) -> bool:
    """'2025' must match portal labels '2025', '2025-26', '2025/2026',
    '2025-2026' (§5.1) — but NOT '2024-2025' (that's the prior fiscal year)."""
    if not target_year or not label:
        return False
    t = str(target_year).strip()
    candidate_years = re.findall(r"(?:19|20)\d{2}", str(label))
    if not candidate_years:
        return False
    return candidate_years[0] == t


def _bill_years(label: str) -> int | None:
    m = re.search(r"(19|20)\d{2}", str(label))
    return int(m.group(0)) if m else None


def choose_bill(
    bills: list[dict[str, Any]],
    target_year: str | None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Pick the bill for the row's target year (§5.1 — never 'the top row').
    Returns (bill, note). When the target year isn't issued yet, the newest
    issued bill is reported with a note; with no target year, newest wins."""
    if not bills:
        return None, None
    labeled = [(b, _bill_years(b.get("year_label", ""))) for b in bills]
    if target_year:
        for b, _ in labeled:
            if year_label_matches(target_year, b.get("year_label")):
                return b, None
        years = [y for _, y in labeled if y is not None]
        if years and target_year.isdigit() and int(target_year) > max(years):
            newest = max(labeled, key=lambda t: t[1] or 0)[0]
            return newest, (
                f"{target_year} bill not issued yet — reporting "
                f"{newest.get('year_label')}"
            )
        return None, f"no bill labeled {target_year} found on the portal"
    newest = max(labeled, key=lambda t: t[1] or 0)[0]
    return newest, None


def prior_year_balance(
    bills: list[dict[str, Any]],
    chosen_label: str | None,
) -> list[str]:
    """Any EARLIER year showing a balance gets flagged (§3)."""
    chosen_year = _bill_years(chosen_label or "") or 10_000
    flags = []
    for b in bills:
        y = _bill_years(b.get("year_label", ""))
        due = parse_money(b.get("amount_due"))
        if y is not None and y < chosen_year and due is not None and due > 0.005:
            flags.append(f"{b.get('year_label')} owes {fmt_money(due)}")
    return flags


_DELINQUENT_WORDS = re.compile(
    r"delinquen|past\s*due|overdue|certificate|tax\s*sale|redeem", re.IGNORECASE
)
_PAID_WORDS = re.compile(r"\bpaid\b|redeemed|closed|\$0\.00", re.IGNORECASE)


def build_account_record(
    account_display: str,
    extraction: dict[str, Any],
    verdict: MatchVerdict,
    target_year: str | None,
    sheet_stale_amount: float | None,
    sheet_date_paid: Any,
    today: dt.date,
) -> tuple[AccountRecord, list[str]]:
    """Map a verified extraction onto the canonical record, applying every
    §7 gate. Returns (record, correction_notes)."""
    corrections: list[str] = []
    bills = [b for b in (extraction.get("bills") or []) if isinstance(b, dict)]
    bill, year_note = choose_bill(bills, target_year)

    rec = AccountRecord(
        account_searched=account_display,
        source_url=extraction.get("final_url"),
        page_timestamp=extraction.get("page_timestamp"),
        assessed_value=parse_money(extraction.get("assessed_value")),
    )
    evidence_bits: list[str] = [f"matched by {verdict.basis}"]
    if verdict.owner_mismatch:
        evidence_bits.append(
            f"owner on page '{extraction.get('owner_on_page')}' does not "
            "contain the entity (possible recent acquisition)"
        )
    if year_note:
        evidence_bits.append(year_note)
    if extraction.get("notes"):
        evidence_bits.append(str(extraction["notes"]))

    if bill is None:
        rec.status = NEEDS_REVIEW
        rec.confidence = MEDIUM if verdict.confidence_hint == HIGH else LOW
        rec.evidence = "; ".join(evidence_bits)
        priors = prior_year_balance(bills, None)
        if priors:
            rec.prior_year_balance = True
            rec.status = DELINQUENT
            rec.amount_due = sum(
                parse_money(b.get("amount_due")) or 0.0 for b in bills
            ) or None
            rec.evidence += "; PRIOR-YEAR BALANCE: " + "; ".join(priors)
        return rec, corrections

    rec.tax_year = bill.get("year_label")
    rec.amount_billed = parse_money(bill.get("amount_billed"))
    rec.amount_paid = parse_money(bill.get("amount_paid"))
    rec.amount_due = parse_money(bill.get("amount_due"))
    rec.receipt = (str(bill.get("receipt")).strip() or None) if bill.get("receipt") else None
    rec.paid_by = (str(bill.get("paid_by")).strip() or None) if bill.get("paid_by") else None
    rec.next_due_date = bill.get("next_due_date")
    status_text = str(bill.get("status_text") or "")

    # ---- date sanity (§7): dates ≤ today; future dates are typos/errors --
    portal_date = parse_date(bill.get("date_paid"))
    if portal_date and portal_date > today:
        evidence_bits.append(
            f"portal shows payment dated {fmt_date(portal_date)} which is in "
            "the future — not written"
        )
        portal_date = None
    rec.date_paid = fmt_date(portal_date) if portal_date else None

    # ---- sheet-vs-portal contradictions (§7 'existing typos') ----------
    sheet_date = parse_date(sheet_date_paid)
    if sheet_date and portal_date and sheet_date != portal_date:
        corrections.append(
            f"sheet said {fmt_date(sheet_date)}; portal receipt shows "
            f"{fmt_date(portal_date)}"
        )

    due = rec.amount_due
    paid = rec.amount_paid

    # ---- status derivation ---------------------------------------------
    if due is not None and due > 0.005:
        if _DELINQUENT_WORDS.search(status_text):
            rec.status = DELINQUENT
        elif (
            target_year
            and target_year.isdigit()
            and int(target_year) < today.year
        ):
            rec.status = DELINQUENT
        elif paid is not None and paid > 0.005:
            rec.status = PARTIAL
        else:
            rec.status = UNPAID
    elif due is not None:  # 0.00 — paid in full
        rec.status = PAID
    elif _PAID_WORDS.search(status_text) and not _DELINQUENT_WORDS.search(status_text):
        rec.status = PAID
    elif _DELINQUENT_WORDS.search(status_text):
        rec.status = DELINQUENT
    else:
        rec.status = NEEDS_REVIEW
        evidence_bits.append("no amount-due figure and no status text")

    # ---- §5.3: '$0.00' banner needs proof; PAID without proof = MEDIUM --
    proofless = rec.status == PAID and not (rec.date_paid or rec.receipt or paid)
    if proofless:
        evidence_bits.append("payment details unavailable")

    # ---- §7 discount band: 0–5% below billed is normal (FL tiers) -------
    if (
        rec.status == PAID
        and paid is not None
        and rec.amount_billed
        and rec.amount_billed > 0
    ):
        ratio = paid / rec.amount_billed
        if ratio < 0.95:
            rec.status = NEEDS_REVIEW
            evidence_bits.append(
                f"paid {fmt_money(paid)} is {100 * (1 - ratio):.1f}% below "
                f"billed {fmt_money(rec.amount_billed)} with no installment "
                "explanation — amounts not written"
            )
        elif ratio < 1.0:
            evidence_bits.append(
                f"paid {fmt_money(paid)} vs billed "
                f"{fmt_money(rec.amount_billed)} — early-payment discount, normal"
            )

    # ---- §7 delinquent growth: live figure should be ≥ the stale sheet --
    if (
        rec.status == DELINQUENT
        and due is not None
        and sheet_stale_amount
        and sheet_stale_amount > 0
        and due < sheet_stale_amount * 0.98
    ):
        evidence_bits.append(
            f"live amount {fmt_money(due)} is LOWER than the sheet's "
            f"{fmt_money(sheet_stale_amount)} — partial payment or wrong "
            "account? flagged for review"
        )

    priors = prior_year_balance(bills, rec.tax_year)
    rec.prior_year_balance = bool(priors)
    if priors:
        evidence_bits.append("PRIOR-YEAR BALANCE: " + "; ".join(priors))
        if rec.status == PAID:
            rec.status = DELINQUENT  # current year paid but older year owes

    # ---- confidence (§7) -------------------------------------------------
    conf = verdict.confidence_hint
    if proofless or verdict.owner_mismatch or year_note:
        conf = MEDIUM if conf == HIGH else conf
    if rec.status == NEEDS_REVIEW:
        conf = LOW if conf == LOW else MEDIUM
    rec.confidence = conf

    rec.evidence = "; ".join(b for b in evidence_bits if b)
    return rec, corrections


# --------------------------------------------------------------------------
# Status line for the workbook (§10.2)
# --------------------------------------------------------------------------

def account_phrase(rec: AccountRecord, as_of: dt.date) -> str:
    if rec.status == PAID:
        bits = [f"Paid in full {fmt_money(rec.amount_paid or rec.amount_billed)}"]
        if rec.date_paid:
            bits.append(f"on {rec.date_paid}")
        extras = []
        if rec.receipt:
            extras.append(f"Receipt {rec.receipt}")
        if rec.paid_by:
            extras.append(f"paid by {rec.paid_by}")
        phrase = " ".join(bits)
        if extras:
            phrase += f" ({', '.join(extras)})"
        if not (rec.date_paid or rec.receipt or rec.amount_paid):
            phrase = "Paid in full (payment details unavailable on portal)"
        return phrase
    if rec.status == DELINQUENT:
        return (
            f"DELINQUENT — {fmt_money(rec.amount_due)} owed as of "
            f"{fmt_date(as_of)}"
        )
    if rec.status == UNPAID:
        phrase = f"UNPAID — {fmt_money(rec.amount_due)} due"
        if rec.next_due_date:
            phrase += f" by {rec.next_due_date}"
        return phrase
    if rec.status == PARTIAL:
        return (
            f"PARTIAL — {fmt_money(rec.amount_paid)} paid, "
            f"{fmt_money(rec.amount_due)} still due"
            + (f" (next due {rec.next_due_date})" if rec.next_due_date else "")
        )
    if rec.status == UNREACHABLE:
        return "NEEDS REVIEW — portal unreachable"
    reason = rec.evidence or "could not verify"
    return f"NEEDS REVIEW — {reason}"


def build_row_note(
    records: list[AccountRecord],
    row_status: str,
    corrections: list[str],
    as_of: dt.date,
) -> str:
    """One human-readable line per row (§10.2). Multi-account rows report
    every open account explicitly (§5.6)."""
    if not records:
        return "NEEDS REVIEW — row could not be checked"
    if len(records) == 1:
        note = account_phrase(records[0], as_of)
    else:
        parts = [
            f"{r.account_searched}: {account_phrase(r, as_of)}" for r in records
        ]
        prefix = (
            f"All {len(records)} accounts paid"
            if row_status == PAID
            else f"{row_status.replace('_', ' ')} across {len(records)} accounts"
        )
        note = f"{prefix} — " + "; ".join(parts)
    for c in corrections:
        note += f" | NOTE: {c}"
    return note
