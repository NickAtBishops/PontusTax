"""Recipe interface — one per vendor family.

A recipe is a small Python class that knows how to navigate ONE family
of portal (Grant Street's county-taxes.net, PublicAccessNow, ptaxweb,
Tyler, Beacon/Schneider, etc.) from a row's input to the bill detail
page. The router (`runner.py`) picks a recipe by URL pattern; the
recipe's only job is to return the rendered bill-page text.

Recipes do NOT extract structured fields. That is the extractor's job
(`extractor.py`), shared by every recipe. The split keeps each recipe
small (the only thing that varies per vendor is the click path) and
lets the LLM cost stay independent of the number of recipes we add.

Contract:
  - url_pattern    : a compiled regex matched against the row's URL.
                     The first recipe whose pattern matches wins.
  - fetch(...)     : navigate to the bill page for `row`. Return the
                     visible page text (preferred) or HTML.
  - On a soft failure (the search returned no results, the parcel was
    not found, the page redirected to something we cannot read),
    raise `RecipeError` with a short reason. The runner (runner.py)
    converts this directly into a "no_matching_property" result for
    the row — there is NO automatic in-run fallback to Skyvern. An
    analyst has to manually re-upload the workbook with engine=
    "skyvern" to get AI-agent coverage on a row a recipe couldn't
    resolve. (See runner.py's module docstring for the authoritative
    statement of this — this file used to claim otherwise.)
  - On a hard failure (network error, Playwright timeout), let the
    exception propagate. The orchestrator's existing per-row try /
    except marks the row UNREACHABLE.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from ..browser import Browser


class RecipeError(Exception):
    """The recipe could not produce a bill page for THIS row, but the
    portal itself appears reachable. Examples: no matching parcel,
    multiple ambiguous results, layout the recipe does not handle.
    The runner catches this and converts it into a "no_matching_property"
    result for the row — NOT an automatic Skyvern fallback within the
    same run (see runner.py's module docstring)."""


@dataclass
class RowContext:
    """The bits of a row a recipe needs to navigate. Mirrors the
    fields the Skyvern path's prompt builder reads off the row, so a
    recipe written from the CLAUDE.md spec sees the same picture."""

    url: str | None
    address: str | None
    owner_entity: str | None
    account_candidates: list[str]   # already normalized (intake §2.2)
    tax_year: str | None
    county: str | None
    state: str | None


class Recipe(ABC):
    """Base for a vendor-family recipe."""

    #: Class-level URL pattern. The router compiles this once and uses
    #: it for dispatch. Subclasses MUST override.
    url_pattern: re.Pattern[str] = re.compile(r"a^")  # matches nothing

    #: Human-readable family name surfaced in event logs and the
    #: orchestrator's evidence trail.
    name: str = "base"

    @classmethod
    def matches(cls, url: str | None) -> bool:
        if not url:
            return False
        return bool(cls.url_pattern.search(url))

    @abstractmethod
    async def fetch(
        self,
        browser: Browser,
        url: str,
        row: RowContext,
    ) -> "FetchResult":
        """Navigate to the bill page for `row` and return its text.

        Implementations follow the same shape:
          1. Open a fresh page on `browser` (uses the polite-delay lock
             for the domain automatically).
          2. Try the deep link as given.
          3. If it lands somewhere wrong (search form, expired token),
             fall back to the search flow with the row's account / address.
          4. Wait for the bill-detail marker.
          5. Return the page's visible text + final URL.

        Raise RecipeError(reason) on a soft failure.
        """


@dataclass
class FetchResult:
    page_text: str
    final_url: str | None


def _domain_of(url: str) -> str:
    """Cheap host extraction without importing tld libs. Falls back
    to the raw URL when parsing fails so polite-delay still applies
    to something sane."""
    try:
        from urllib.parse import urlparse

        host = urlparse(url).netloc.lower()
        return host or url
    except Exception:  # noqa: BLE001
        return url
