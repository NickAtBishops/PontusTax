"""Type F — PDF-only portals (CLAUDE.md §4F).

Downloading the target-year bill PDF is the one permitted artifact. Text is
extracted with pypdf and parsed best-effort; scanned/unparseable documents
become NEEDS_REVIEW with the PDF kept as evidence.
"""

from __future__ import annotations

import io
import logging
import re
from typing import Any

import httpx

log = logging.getLogger("pontus_tax.pdf")

_MONEY = r"\$?\s*([\d,]+\.\d{2})"


def _to_float(s: str) -> float:
    return float(s.replace(",", "").replace("$", "").strip())


async def fetch_pdf(url: str) -> bytes | None:
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.content
    except httpx.HTTPError as exc:
        log.warning("PDF fetch failed: %s", exc)
        return None


def parse_bill_pdf(data: bytes, target_year: str | None) -> dict[str, Any] | None:
    """Extract a minimal bills[] extraction from PDF text. Returns None when
    the document has no usable text (scanned image → NEEDS_REVIEW)."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as exc:  # noqa: BLE001
        log.warning("PDF parse failed: %s", exc)
        return None
    if len(text.strip()) < 40:
        return None

    year = None
    if target_year and re.search(rf"\b{re.escape(target_year)}\b", text):
        year = target_year
    else:
        m = re.search(r"\b(20\d{2})\b", text)
        year = m.group(1) if m else None
    if year is None:
        return None

    def find_money(*labels: str) -> float | None:
        for label in labels:
            m = re.search(label + r"[^\d$]{0,40}" + _MONEY, text, re.IGNORECASE)
            if m:
                return _to_float(m.group(1))
        return None

    amount_due = find_money(
        r"total\s+amount\s+due", r"amount\s+due", r"balance\s+due",
        r"total\s+due", r"please\s+pay",
    )
    amount_billed = find_money(
        r"total\s+tax(?:es)?", r"combined\s+tax", r"gross\s+tax", r"total\s+billed",
    )
    amount_paid = find_money(r"amount\s+paid", r"total\s+paid", r"paid\s+amount")
    date_paid = None
    m = re.search(r"paid[^\d]{0,30}(\d{1,2}/\d{1,2}/\d{2,4})", text, re.IGNORECASE)
    if m:
        date_paid = m.group(1)
    receipt = None
    m = re.search(r"receipt\s*(?:no\.?|number|#)?\s*[:\s]\s*([A-Z0-9-]{4,})",
                  text, re.IGNORECASE)
    if m:
        receipt = m.group(1)

    if amount_due is None and amount_paid is None and amount_billed is None:
        return None

    paid_in_full = amount_due is not None and amount_due <= 0.005
    return {
        "page_outcome": "account_found",
        "page_type_observed": "pdf_document",
        "vendor_footer": None,
        "owner_on_page": _first_match(text, r"owner[^\n:]*[:\s]+([^\n]{3,60})"),
        "situs_address_on_page": None,
        "parcel_or_account_on_page": _first_match(
            text, r"(?:parcel|account|folio)\s*(?:no\.?|number|#|id)?\s*[:\s]\s*([A-Z0-9./-]{4,})"
        ),
        "roll_type_on_page": "unknown",
        "assessed_value": find_money(r"assessed\s+value"),
        "page_timestamp": None,
        "final_url": None,
        "bills": [{
            "year_label": year,
            "status_text": "paid" if paid_in_full else None,
            "amount_billed": amount_billed,
            "amount_paid": amount_paid,
            "amount_due": amount_due,
            "date_paid": date_paid,
            "receipt": receipt,
            "paid_by": None,
            "next_due_date": None,
        }],
        "candidate_matches": [],
        "notes": "parsed from downloaded bill PDF",
    }


def _first_match(text: str, pattern: str) -> str | None:
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(1).strip() if m else None
