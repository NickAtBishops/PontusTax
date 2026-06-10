"""Known-vendor playbook library — CLAUDE.md §8.

Vendor specifics are DATA, not code. Seeds below cover the national
platforms; every run may add entries (§4.7) so the system gets smarter with
each new portal it meets. Persistent copy lives in tax_checker_playbooks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse


@dataclass
class Playbook:
    key: str
    vendor_name: str
    url_patterns: list[str] = field(default_factory=list)        # substrings
    footer_signatures: list[str] = field(default_factory=list)   # lowercase
    default_taxonomy: str = "B"
    hints: str = ""
    quirks: list[str] = field(default_factory=list)
    source: str = "seed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.key,
            "vendor_name": self.vendor_name,
            "url_patterns": self.url_patterns,
            "footer_signatures": self.footer_signatures,
            "default_taxonomy": self.default_taxonomy,
            "hints": self.hints,
            "quirks": self.quirks,
            "source": self.source,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Playbook":
        return Playbook(
            key=d.get("id") or d.get("key") or "unknown",
            vendor_name=d.get("vendor_name", "Unknown"),
            url_patterns=list(d.get("url_patterns") or []),
            footer_signatures=list(d.get("footer_signatures") or []),
            default_taxonomy=d.get("default_taxonomy", "B"),
            hints=d.get("hints", ""),
            quirks=list(d.get("quirks") or []),
            source=d.get("source", "seed"),
        )


SEED_PLAYBOOKS: list[Playbook] = [
    Playbook(
        key="grant_street",
        vendor_name="Grant Street Group (county-taxes.net / BillExpress)",
        url_patterns=["county-taxes.net", "county-taxes.com", "billexpress"],
        footer_signatures=["grant street group", "billexpress"],
        default_taxonomy="A",
        hints=(
            "Deep links contain base64 tokens that decode to "
            "county:roll_type:parents:<uuid> — the token pins the roll type "
            "(real estate vs tangible). A bare domain root is a SEARCH page. "
            "Bills appear as a per-year 'Annual Bill' list: each year shows "
            "Paid status, amount, date and a Receipt number — open/expand the "
            "target year's bill to read the receipt and payment details."
        ),
        quirks=["stale tokens redirect to search — fall back to account search"],
    ),
    Playbook(
        key="publicaccessnow",
        vendor_name="PublicAccessNow",
        url_patterns=["publicaccessnow.com"],
        footer_signatures=["publicaccessnow"],
        default_taxonomy="A",
        hints=(
            "Deep link shape Account.aspx?p=<parcel>&a=<account>. The page "
            "shows a 'Total Payable' banner — '$0.00' is NOT proof of "
            "payment. The proof (amount, date, receipt) hides in a collapsed "
            "'Recently Paid Bills' section: click the (+) toggle and read it."
        ),
        quirks=["always expand 'Recently Paid Bills' before concluding"],
    ),
    Playbook(
        key="ptaxweb_pacific_blue",
        vendor_name="ptaxweb / Pacific Blue Software",
        url_patterns=["/ptaxweb/", "editpropertysearch2.action"],
        footer_signatures=["pacific blue software"],
        default_taxonomy="B",
        hints=(
            "Either a deep 'action=detail&propertyId=…' link or a bare search "
            "form. The bill detail page is DENSE: per-authority ad-valorem "
            "lines, NON AD VALOREM assessments, GROSS, PAYMENTS, REFUND. The "
            "PAYMENTS table (posted date, receipt, paid-by, amount) is ground "
            "truth; GROSS is the amount billed; ignore per-authority/millage "
            "lines; note any non-empty REFUND."
        ),
    ),
    Playbook(
        key="aumentum",
        vendor_name="Aumentum Technologies",
        url_patterns=["aumentum"],
        footer_signatures=["aumentum technologies", "aumentum"],
        default_taxonomy="A",
        hints=(
            "Same pattern as PublicAccessNow: a current-balance banner plus a "
            "collapsed recently-paid section that holds the actual payment "
            "proof — expand it before concluding paid/unpaid."
        ),
    ),
    Playbook(
        key="tyler_technologies",
        vendor_name="Tyler Technologies (iTax / Eagle / EnerGov)",
        url_patterns=["tylertech", "itax", "tylerhost"],
        footer_signatures=["tyler technologies", "tyler tech"],
        default_taxonomy="B",
        hints="Common nationally; classify the landing page by shape and proceed.",
    ),
    Playbook(
        key="beacon_schneider",
        vendor_name="Beacon / Schneider Geospatial",
        url_patterns=["beacon.schneidercorp.com", "schneidercorp"],
        footer_signatures=["schneider geospatial", "beacon"],
        default_taxonomy="B",
        hints=(
            "Beacon is often the ASSESSOR side (parcel data, assessed value); "
            "tax payment data may live on a separate collector site (§ Type G) "
            "— extract what is shown, do not infer payment status from "
            "assessment data."
        ),
    ),
    Playbook(
        key="devnet",
        vendor_name="DEVNET (wEdge)",
        url_patterns=["devnetwedge"],
        footer_signatures=["devnet"],
        default_taxonomy="B",
        hints="Parcel search portal; billing tab per tax year.",
    ),
    Playbook(
        key="govtechtaxpro",
        vendor_name="GovTech (taxpro)",
        url_patterns=["govtechtaxpro"],
        footer_signatures=["govtech"],
        default_taxonomy="B",
        hints="Tax search portal; per-year tax detail with payment history.",
    ),
]


def match_playbook(
    url: str | None,
    library: list[Playbook],
    vendor_footer: str | None = None,
) -> Playbook | None:
    """Identify the platform from URL patterns, then footer credits (§4.7)."""
    if url:
        low = url.lower()
        for pb in library:
            if any(p in low for p in pb.url_patterns):
                return pb
    if vendor_footer:
        foot = vendor_footer.lower()
        for pb in library:
            if any(sig in foot for sig in pb.footer_signatures):
                return pb
    return None


def draft_playbook(
    vendor_footer: str | None,
    url: str | None,
    taxonomy: str,
    observations: str,
) -> Playbook:
    """§4.7 step 3 — a brand-new vendor was solved generically; write a
    playbook entry so the library grows instead of re-solving it next run."""
    domain = urlparse(url).netloc.lower() if url else ""
    base = vendor_footer or domain or "unknown-vendor"
    key = re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_")[:60] or "unknown_vendor"
    return Playbook(
        key=key,
        vendor_name=vendor_footer or domain or "Unknown vendor",
        url_patterns=[domain] if domain else [],
        footer_signatures=[vendor_footer.lower()] if vendor_footer else [],
        default_taxonomy=taxonomy,
        hints=observations,
        source="discovered",
    )
