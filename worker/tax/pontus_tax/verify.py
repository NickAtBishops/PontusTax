"""Verification — never extract from the wrong property (CLAUDE.md §6).

Deterministic fuzzy checks run first (owner contains / address resemblance /
parcel candidate match). When they are inconclusive AND an Anthropic key is
configured, a forced-tool-call Claude adjudication breaks the tie. Anything
still unresolved is NEEDS_REVIEW — never extracted.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from .identifiers import account_matches

log = logging.getLogger("pontus_tax.verify")

_ABBREV = {
    "street": "st", "avenue": "ave", "boulevard": "blvd", "drive": "dr",
    "highway": "hwy", "road": "rd", "lane": "ln", "court": "ct",
    "circle": "cir", "place": "pl", "parkway": "pkwy", "terrace": "ter",
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    "suite": "ste", "unit": "unit", "apartment": "apt",
}
_NOISE_OWNER = {"llc", "lp", "llp", "inc", "corp", "co", "ltd", "the", "of", "a"}


def normalize_address(addr: str | None) -> str:
    if not addr:
        return ""
    a = re.sub(r"[^\w\s]", " ", str(addr).lower())
    tokens = [_ABBREV.get(t, t) for t in a.split()]
    return " ".join(tokens)


def street_number(addr: str | None) -> str | None:
    if not addr:
        return None
    m = re.match(r"\s*(\d+)", str(addr))
    return m.group(1) if m else None


def address_matches(row_addr: str | None, page_addr: str | None) -> bool:
    """Situs address should RESEMBLE the row's address (§6.2): same street
    number plus fuzzy street-line similarity after abbreviation folding."""
    if not row_addr or not page_addr:
        return False
    n_row, n_page = street_number(row_addr), street_number(page_addr)
    if n_row and n_page and n_row != n_page:
        return False
    a = normalize_address(str(row_addr).split(",")[0])
    b = normalize_address(str(page_addr).split(",")[0])
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.75


def owner_matches(row_owner: str | None, page_owner: str | None) -> bool:
    """Owner shown should contain the row's entity or 'PONTUS' — county data
    entry mangles names, so token containment is enough (§6.1)."""
    if not page_owner:
        return False
    page = re.sub(r"[^\w\s]", " ", str(page_owner).lower())
    if "pontus" in page:
        return True
    if not row_owner:
        return False
    row_tokens = [
        t for t in re.sub(r"[^\w\s]", " ", str(row_owner).lower()).split()
        if t not in _NOISE_OWNER and len(t) >= 3
    ]
    if not row_tokens:
        return False
    hits = sum(1 for t in row_tokens if t in page)
    return hits >= max(1, round(len(row_tokens) / 2))


@dataclass
class MatchVerdict:
    matched: bool
    basis: str                 # what we matched on
    owner_mismatch: bool       # matched but owner differs (seller exception)
    confidence_hint: str       # HIGH | MEDIUM | LOW
    reason: str = ""


def assess_match(
    candidates: list[str],
    row_owner: str | None,
    row_address: str | None,
    extraction: dict[str, Any],
) -> MatchVerdict:
    """Deterministic §6 verdict on whether the opened page is OUR property."""
    page_owner = extraction.get("owner_on_page")
    page_addr = extraction.get("situs_address_on_page")
    page_parcel = extraction.get("parcel_or_account_on_page")

    acct_ok = account_matches(candidates, page_parcel)
    addr_ok = address_matches(row_address, page_addr)
    owner_ok = owner_matches(row_owner, page_owner)

    if acct_ok and (owner_ok or addr_ok):
        return MatchVerdict(True, "account + " + ("owner" if owner_ok else "address"),
                            owner_mismatch=not owner_ok, confidence_hint="HIGH")
    if acct_ok and addr_ok is False and owner_ok is False and not page_addr and not page_owner:
        # Page exposed no owner/address to check — exact account match alone.
        return MatchVerdict(True, "account (page showed no owner/address)",
                            owner_mismatch=False, confidence_hint="MEDIUM")
    if acct_ok and addr_ok:
        return MatchVerdict(True, "account + address", owner_mismatch=not owner_ok,
                            confidence_hint="HIGH")
    if acct_ok:
        # §6.1 seller exception: recently acquired properties may still show
        # the seller — parcel/account AND address must both match to proceed.
        return MatchVerdict(False, "account only — owner and address both differ",
                            owner_mismatch=True, confidence_hint="LOW",
                            reason="account matched but neither owner nor address did")
    if owner_ok and addr_ok:
        return MatchVerdict(True, "owner + address", owner_mismatch=False,
                            confidence_hint="MEDIUM")
    if addr_ok and not page_owner:
        return MatchVerdict(True, "address (no owner shown)", owner_mismatch=False,
                            confidence_hint="MEDIUM")
    if owner_ok and not page_addr:
        return MatchVerdict(True, "owner (no situs shown)", owner_mismatch=False,
                            confidence_hint="MEDIUM")
    if addr_ok:
        # address matches exactly but owner differs → seller exception, MEDIUM
        return MatchVerdict(True, "address (owner differs — possible recent sale)",
                            owner_mismatch=True, confidence_hint="MEDIUM")
    return MatchVerdict(False, "no owner/address/parcel agreement",
                        owner_mismatch=False, confidence_hint="LOW",
                        reason="wrong record: neither owner nor address matches")


# --------------------------------------------------------------------------
# Optional Claude adjudication (port of the proven prototype normalizer)
# --------------------------------------------------------------------------

_ADJUDICATE_TOOL = {
    "name": "report_match_verdict",
    "description": "Report whether the scraped page matches the requested property.",
    "input_schema": {
        "type": "object",
        "properties": {
            "matched": {"type": "boolean"},
            "confidence": {"type": "number", "description": "0.0-1.0"},
            "basis": {"type": "string"},
            "reasoning": {"type": "string"},
        },
        "required": ["matched", "confidence"],
    },
}


async def adjudicate_with_claude(
    api_key: str,
    model: str,
    row: dict[str, Any],
    extraction: dict[str, Any],
) -> MatchVerdict | None:
    """Tie-breaker when deterministic checks are inconclusive. Lenient
    address/name comparison is judgment work an LLM does well."""
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        return None
    try:
        client = AsyncAnthropic(api_key=api_key)
        resp = await client.messages.create(
            model=model,
            max_tokens=400,
            system=(
                "You validate property-tax scrapes. Decide whether the page "
                "the browser agent read corresponds to the requested "
                "property. Compare addresses leniently (abbreviations, "
                "suffixes, units); county data entry mangles owner names; a "
                "recently sold property may still show the seller. Answer "
                "via the report_match_verdict tool only."
            ),
            tools=[_ADJUDICATE_TOOL],
            tool_choice={"type": "tool", "name": "report_match_verdict"},
            messages=[{
                "role": "user",
                "content": json.dumps(
                    {"requested_property": row, "page_extraction": extraction},
                    default=str,
                ),
            }],
        )
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                data = dict(block.input)
                conf = float(data.get("confidence", 0))
                return MatchVerdict(
                    matched=bool(data.get("matched")) and conf >= 0.7,
                    basis=f"claude: {data.get('basis', '')}".strip(),
                    owner_mismatch=False,
                    confidence_hint="MEDIUM",
                    reason=str(data.get("reasoning", "")),
                )
    except Exception as exc:  # noqa: BLE001 — adjudication is best-effort
        log.warning("Claude adjudication failed: %s", exc)
    return None
