"""Portal taxonomy — CLAUDE.md §4.

Thousands of county portals, a handful of SHAPES. A landing page is
classified into a type and the matching navigation path runs. Unknown
portals get the generic path plus a new playbook entry (§4.7).
"""

from __future__ import annotations

import re
from urllib.parse import urlparse, parse_qs

from .playbooks import Playbook

TYPE_A = "A"  # direct account/bill page (deep link)
TYPE_B = "B"  # search form
TYPE_C = "C"  # multi-step flow (disclaimer / roll-type choice first)
TYPE_D = "D"  # year/roll selector (year pinned or selectable)
TYPE_E = "E"  # blocked (login wall, CAPTCHA, paywall)
TYPE_F = "F"  # PDF-only / document-based bills
TYPE_G = "G"  # split assessor/collector sites

_DEEP_PARAMS = {
    "p", "a", "parcel", "parcelid", "parcel_id", "account", "accountno",
    "account_number", "acct", "folio", "propertyid", "property_id", "pid",
    "id", "taxid", "apn", "key", "strap",
}
_YEAR_PARAMS = {"y", "year", "taxyear", "tax_year", "rollyear"}


def classify_url(url: str | None, playbook: Playbook | None) -> str:
    """Pre-classification from the URL alone; the live page may still
    reclassify itself via the extraction's page_outcome."""
    if not url:
        return TYPE_B  # will be discovered, then searched
    parsed = urlparse(url)
    params = {k.lower() for k in parse_qs(parsed.query)}
    path = parsed.path.lower()

    if params & _YEAR_PARAMS:
        return TYPE_D  # year pinned in URL (St. Johns `y=2025`)
    if params & _DEEP_PARAMS:
        return TYPE_A
    # Long opaque tokens in the path (Grant Street base64 deep links)
    if re.search(r"/[A-Za-z0-9+/=_-]{24,}(/|$)", parsed.path):
        return TYPE_A
    if any(s in path for s in ("detail", "account", "bill", "parcel")):
        return TYPE_A
    if playbook is not None and not parsed.query and parsed.path in ("", "/"):
        # bare vendor root is a search page for every known vendor
        return TYPE_B
    if playbook is not None:
        return playbook.default_taxonomy
    return TYPE_B


def domain_of(url: str | None) -> str:
    if not url:
        return "no-portal"
    try:
        return urlparse(url).netloc.lower() or "no-portal"
    except ValueError:
        return "no-portal"
