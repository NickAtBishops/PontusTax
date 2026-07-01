"""Grant Street Group — county-taxes.net (BillExpress / govhub).

Covers the Florida county-taxes.net family: Clay, Hillsborough, Charlotte,
Pasco, Pinellas, Broward, Indian River, Flagler, Collier, Miami-Dade and
several others. Also handles the related host pattern
`<county>.county-taxes.com`, which redirects to `county-taxes.net/<county>`.

REAL STRUCTURE (verified 2026-06-30 against the live portal — Clay County,
account 09-05-24-005954-056-00 — not assumed from documentation):

  - The top-level page (whatever URL you land on — a deep link, a bare
    `/property-tax` search root, or a search results redirect) is a thin
    wrapper: county branding, public notices, a Google Pay payframe
    iframe, and ONE other iframe whose URL contains "iframe-taxsys" (or
    "govhub") that holds the actual account/bill content. The top-level
    page's own body text is just notification banners — it is NEVER
    where the bill data lives.
  - That iframe loads in two stages: first the iframe document itself
    (~1-3s), then an internal XHR populates "Amount Due" / "Account
    History" — both show literal "Loading" placeholder text until that
    second stage finishes (~5-8s total from navigation). Reading the
    iframe before BOTH stages settle returns a page that looks
    "empty"/"not a bill page" even though the deep link worked.
  - On a bare `/property-tax` root (no deep-link token), the search
    input lives on the TOP-LEVEL page (not inside an iframe yet): a
    single visible `<input type="text">` with placeholder text
    "Name, Address, Account Number, etc." — no `name` attribute, so a
    `name=`-based selector never matches it.
  - Submitting an exact account-number search navigates the top-level
    page to a deep-link-shaped URL and the SAME iframe pattern as above
    takes over — there is no separate "results list" step for an exact
    match. We have not observed what an ambiguous multi-match results
    page looks like; the result-click fallback below is best-effort and
    intentionally fails safe (RecipeError, not a guess) rather than
    risk reading the wrong property.
  - county-taxes.net is behind Cloudflare bot-protection on at least
    some county roots (observed on Pinellas's bare search page during
    testing) and can occasionally serve a "Performing security
    verification" challenge page instead of real content. Per CLAUDE.md
    Type E, we never try to solve or bypass that — we detect it and
    raise RecipeError so the row falls through to Needs Review/Skyvern
    honestly instead of misreading the challenge page as "no results".
"""

from __future__ import annotations

import logging
import re

from ..browser import Browser
from .base import FetchResult, Recipe, RecipeError, RowContext, _domain_of

log = logging.getLogger("pontus_tax.playwright.recipes.grant_street")

# Total time we'll wait for the bill iframe to appear AND fully settle
# (both load stages described above). Routing through a residential/ISP
# proxy (Bright Data) roughly DOUBLES this versus a direct connection —
# measured live 2026-06-30: ~6-8s direct, ~18.7s through the proxy for
# the exact same Clay County page. The original 20s budget was tuned
# against direct connections only and was cutting it close enough to
# fail intermittently once the proxy was wired in (a slow run could
# exceed it and the recipe would wrongly conclude "not a bill page").
# 45s gives solid headroom above the observed worst case, not just the
# bare minimum — Cloud Run's network path to the proxy may add more
# variance than was seen from a single local test.
_SETTLE_TIMEOUT_S = 45.0
_POLL_INTERVAL_S = 0.5

_BOT_CHALLENGE_MARKERS = (
    "performing security verification",
    "checking your browser",
    "verify you are not a bot",
)


class GrantStreetRecipe(Recipe):
    url_pattern = re.compile(
        r"(county-taxes\.net|\.county-taxes\.com)",
        re.IGNORECASE,
    )
    name = "grant_street"

    _SEARCH_INPUT_SELECTOR = "input[placeholder*='Name, Address, Account' i]"

    _NO_RESULT_MARKERS = [
        "text=No matches",
        "text=No results",
        "text=could not be found",
        "text=No properties were found",
        "text=no accounts found",
    ]

    async def fetch(
        self,
        browser: Browser,
        url: str,
        row: RowContext,
    ) -> FetchResult:
        domain = _domain_of(url)
        async with browser.page(
            domain, url=url, goto_kwargs={"wait_until": "domcontentloaded"}
        ) as page:
            await self._raise_if_bot_challenge(page)

            settled = await self._wait_for_bill_frame(page)
            if settled is not None:
                return await self._read_bill(settled)

            # ---- Not a bill page within the settle window. Either a
            # search form, or a portal layout we don't recognize. ------
            if not row.account_candidates and not row.address and not row.owner_entity:
                raise RecipeError(
                    "deep link did not show the property within "
                    f"{_SETTLE_TIMEOUT_S:.0f}s and we have no account, "
                    "address, or owner to search by"
                )

            search_input = page.locator(self._SEARCH_INPUT_SELECTOR).first
            try:
                has_search = await search_input.count() > 0 and await search_input.is_visible()
            except Exception:  # noqa: BLE001
                has_search = False
            if not has_search:
                raise RecipeError(
                    "Grant Street recipe: not a bill page and no search "
                    f"input found on {page.url!s}"
                )

            # §4B input ladder: account candidates → street address →
            # owner entity name. `row.account_candidates` is THIS
            # account group's candidates only (the runner scopes it),
            # never the whole row's — see playwright_engine/runner.py.
            ladder: list[tuple[str, str]] = [
                ("account", c) for c in row.account_candidates
            ]
            if row.address:
                ladder.append(("address", row.address))
            if row.owner_entity:
                ladder.append(("owner", row.owner_entity))

            last_failed_label = ""
            for label, value in ladder:
                if not await self._try_search(page, search_input, value):
                    last_failed_label = f"{label}={value!r} (submit failed)"
                    continue
                await self._raise_if_bot_challenge(page)

                settled = await self._wait_for_bill_frame(page)
                if settled is not None:
                    return await self._read_bill(settled)

                if await self._is_no_results(page):
                    last_failed_label = f"{label}={value!r} (no matches)"
                    await self._clear(page, search_input)
                    continue

                # Best-effort: a results LIST rather than a direct hit.
                # We have not been able to observe this state live
                # (exact-account searches in testing always navigated
                # straight to the bill); only attempt a click if there
                # is an unambiguous single linked row, otherwise treat
                # it as a soft failure rather than guess.
                clicked = await self._click_single_result(page)
                if clicked:
                    await self._raise_if_bot_challenge(page)
                    settled = await self._wait_for_bill_frame(page)
                    if settled is not None:
                        return await self._read_bill(settled)
                last_failed_label = (
                    f"{label}={value!r} (no bill frame after search, "
                    f"no unambiguous result row)"
                )
                await self._clear(page, search_input)

            raise RecipeError(
                f"Grant Street recipe exhausted search ladder; last: "
                f"{last_failed_label or 'no candidates'}"
            )

    # ---- iframe handling ---------------------------------------------

    async def _wait_for_bill_frame(self, page):
        """Poll up to _SETTLE_TIMEOUT_S for the account-detail iframe to
        appear AND fully settle. Returns the settled Frame, or None if
        the window elapses without one appearing/settling — that's the
        NORMAL outcome when we're actually on a search form, not an
        error by itself.

        Verified live (2026-06-30) that the iframe loads in multiple
        micro-stages, not one: "Amount Due" resolves first, then
        "Account History" fills in roughly 0.5s later. A single
        "does the text still say Loading" check can sample the gap
        between those stages and falsely call it settled with the
        Account History table still empty. Stability (the SAME text on
        two consecutive polls) is the only signal that survives an
        arbitrary number of these stages without hard-coding each one.
        """
        import time

        deadline = time.monotonic() + _SETTLE_TIMEOUT_S
        last_seen: tuple[str, str] | None = None  # (frame_url, body_text)
        while time.monotonic() < deadline:
            found_any = False
            for fr in page.frames:
                if "iframe-taxsys" not in fr.url and "govhub" not in fr.url:
                    continue
                try:
                    body = await fr.locator("body").inner_text(timeout=2000)
                except Exception:  # noqa: BLE001 — frame mid-navigation
                    continue
                stripped = body.strip()
                if not stripped:
                    continue
                found_any = True
                if "loading" in stripped[:300].lower():
                    last_seen = None  # explicit loading marker resets stability
                    continue
                current = (fr.url, stripped)
                if last_seen == current:
                    return fr  # identical content on two consecutive polls
                last_seen = current
            if not found_any:
                last_seen = None
            await page.wait_for_timeout(int(_POLL_INTERVAL_S * 1000))
        return None

    async def _raise_if_bot_challenge(self, page) -> None:
        try:
            text = (await page.locator("body").inner_text(timeout=2000)).lower()
        except Exception:  # noqa: BLE001
            return
        if any(marker in text for marker in _BOT_CHALLENGE_MARKERS):
            raise RecipeError(
                "portal served a bot-detection challenge page "
                "(Cloudflare or similar) — not solving it, per "
                "CLAUDE.md §4 Type E"
            )

    async def _is_no_results(self, page) -> bool:
        for sel in self._NO_RESULT_MARKERS:
            try:
                if await page.locator(sel).first.count() > 0:
                    return True
            except Exception:  # noqa: BLE001
                continue
        return False

    async def _try_search(self, page, input_loc, value: str) -> bool:
        try:
            await input_loc.click()
            await input_loc.fill(value)
            await input_loc.press("Enter")
            await page.wait_for_load_state("domcontentloaded", timeout=30_000)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("Grant Street search submit failed: %s", exc)
            return False

    async def _click_single_result(self, page) -> bool:
        """Only clicks when exactly ONE plausible result link is found
        — ambiguity is a soft failure, not a guess (§6: never extract
        from an unverified/wrong page)."""
        candidates = [
            ".result-row a",
            ".result a",
            ".search-results a",
            "table tbody tr td a",
            "[data-test='result-row'] a",
        ]
        for sel in candidates:
            loc = page.locator(sel)
            try:
                count = await loc.count()
            except Exception:  # noqa: BLE001
                continue
            if count == 1 and await loc.first.is_visible():
                try:
                    await loc.first.click()
                    await page.wait_for_load_state(
                        "domcontentloaded", timeout=30_000
                    )
                    return True
                except Exception:  # noqa: BLE001
                    continue
        return False

    async def _clear(self, page, input_loc) -> None:
        try:
            await input_loc.fill("")
        except Exception:  # noqa: BLE001
            pass

    async def _read_bill(self, frame) -> FetchResult:
        try:
            text = await frame.locator("body").inner_text()
        except Exception:  # noqa: BLE001
            text = await frame.content()
        return FetchResult(page_text=text, final_url=frame.url)
