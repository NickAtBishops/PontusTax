"""Identifier hygiene — CLAUDE.md §2.2.

Account/parcel values arrive dirty. Each raw cell becomes a list of
AccountCandidates (one per distinct account in the cell — Florida row 4 has
three), each carrying an ordered list of normalized lookup candidates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class AccountCandidates:
    display: str                     # the cleaned id as shown to humans
    candidates: list[str] = field(default_factory=list)  # try in order


def _strip_token(tok: str) -> str:
    tok = tok.strip()
    tok = tok.lstrip("#").strip()
    tok = tok.rstrip(".,;:")
    return tok.strip()


def _dedup(seq: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in seq:
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def candidate_variants(raw: str) -> list[str]:
    """Ordered lookup variants for ONE identifier:
    as-is → without dashes → without dots/spaces → without leading zeros.
    APN shapes vary by state — never validate against one format.
    """
    base = _strip_token(raw)
    if not base:
        return []
    no_dash = base.replace("-", "")
    no_sep = re.sub(r"[.\s\-]", "", base)
    variants = [base, no_dash, no_sep]
    # leading-zero-free variants (on the separator-free form too)
    for v in (base, no_sep):
        stripped = v.lstrip("0")
        if stripped and stripped != v:
            variants.append(stripped)
    # trailing unit suffixes like "/0" — try with, then without
    if "/" in base:
        variants.append(base.split("/", 1)[0])
    return _dedup(variants)


def split_accounts(raw: str | None) -> list[AccountCandidates]:
    """Split a cell that may hold MULTIPLE ids (`/ ; ,` separators) into one
    AccountCandidates per real account. A short trailing `/N` fragment is a
    unit suffix of the previous id, not its own account.
    """
    if raw is None:
        return []
    text = str(raw).strip()
    if not text or text.lower() in {"n/a", "na", "none", "-", "tbd", "?"}:
        return []

    # First split on hard separators ; and ,
    rough = re.split(r"[;,]", text)
    tokens: list[str] = []
    for part in rough:
        part = part.strip()
        if not part:
            continue
        # '/' is ambiguous: separator between full ids vs unit suffix ("…/0").
        pieces = [p for p in part.split("/") if p.strip()]
        if len(pieces) <= 1:
            tokens.append(part)
            continue
        rebuilt: list[str] = []
        for piece in pieces:
            cleaned = _strip_token(piece)
            if rebuilt and len(cleaned) <= 2:
                rebuilt[-1] = f"{rebuilt[-1]}/{cleaned}"  # suffix, keep attached
            else:
                rebuilt.append(cleaned)
        tokens.extend(rebuilt)

    out: list[AccountCandidates] = []
    for tok in tokens:
        display = _strip_token(tok)
        variants = candidate_variants(tok)
        if variants:
            out.append(AccountCandidates(display=display, candidates=variants))
    return out


def normalize_for_match(value: str | None) -> str:
    """Loose normalization used when comparing a portal's parcel/account to
    the row's candidates: case, separators and leading zeros are noise."""
    if not value:
        return ""
    v = re.sub(r"[^A-Za-z0-9]", "", str(value)).upper()
    return v.lstrip("0") or v


def account_matches(candidates: list[str], shown: str | None) -> bool:
    if not shown:
        return False
    norm_shown = normalize_for_match(shown)
    if not norm_shown:
        return False
    return any(normalize_for_match(c) == norm_shown for c in candidates)
