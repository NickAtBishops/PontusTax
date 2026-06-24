"""Portal discovery — CLAUDE.md §4.6.

Rows with no URL get one constructed: web-search for the county's official
tax-collector search page, preferring .gov/.us/county domains. The found URL
is recorded in the output so the spreadsheet gets fixed for next time.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import unquote, urlparse, parse_qs

import httpx

log = logging.getLogger("pontus_tax.discovery")

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_BAD_HOSTS = (
    "duckduckgo.", "wikipedia.", "facebook.", "zillow.", "redfin.",
    "realtor.", "yelp.", "linkedin.", "youtube.", "propertyshark.",
    "ownerly.", "trulia.", "loopnet.",
)


def _score(host: str, county: str) -> int:
    score = 0
    if host.endswith(".gov"):
        score += 100
    if host.endswith(".us"):
        score += 60
    c = re.sub(r"[^a-z]", "", county.lower())
    if c and c in re.sub(r"[^a-z]", "", host):
        score += 40
    if "tax" in host or "collector" in host or "treasurer" in host:
        score += 20
    if "county-taxes" in host or "publicaccessnow" in host:
        score += 30
    return score


async def discover_portal(county: str, state: str | None) -> str | None:
    """DuckDuckGo HTML search → best official-looking result, or None."""
    query = f"{county} county {state or ''} tax collector property tax search"
    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": _UA}, timeout=30, follow_redirects=True
        ) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/", params={"q": query}
            )
            resp.raise_for_status()
            html = resp.text
    except httpx.HTTPError as exc:
        log.warning("portal discovery failed for %s: %s", county, exc)
        return None

    candidates: list[tuple[int, str]] = []
    for href in re.findall(r'href="([^"]+)"', html):
        url = href
        if "uddg=" in href:  # DDG redirect wrapper
            q = parse_qs(urlparse(href).query)
            url = unquote(q.get("uddg", [""])[0])
        if not url.startswith("http"):
            continue
        host = urlparse(url).netloc.lower()
        if not host or any(b in host for b in _BAD_HOSTS):
            continue
        s = _score(host, county)
        if s > 0:
            candidates.append((s, url))

    if not candidates:
        log.info("no official portal found for %s county", county)
        return None
    candidates.sort(key=lambda t: -t[0])
    best = candidates[0][1]
    log.info("discovered portal for %s county: %s", county, best)
    return best
