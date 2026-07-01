"""PlaywrightRunner — drop-in replacement surface for SkyvernRunner.

The orchestrator picks ONE runner per run, based on `run.engine`. This
runner mirrors `SkyvernRunner`'s public surface (`run_attempt`,
`download_bill_pdf`, `close_all`, `reap_orphaned_sessions`) so the
orchestrator's call sites do not branch.

Behavioural differences vs Skyvern:
  - Navigation: deterministic, per-vendor Playwright recipe (no LLM, no
    vision). Each recipe runs its OWN per-row input ladder internally
    (parcel candidates → address) before giving up, so a single
    `run_attempt` call exhausts the row.
  - Extraction: one Claude Haiku call against the rendered page text
    (no vision; text only). Schema prompt-cached so warm calls are cheap.
  - Result caching: keyed by `(domain, url, row_key, group_candidates)`
    — scoped to the specific account group on the specific row, NOT
    just the URL. A bare `(domain, url)` key would collapse multiple
    accounts sharing one URL (a multi-account row, or several rows
    sharing one bare search page — both real, documented cases) into
    one cached result, silently relabeling one account's bill data
    under another's name. The orchestrator's attempt-ladder still calls
    `run_attempt` once per search term for a GIVEN group; those calls
    legitimately hit the cache (the recipe already tried everything it
    can for that group in one pass), but a different group or row never
    collides with it.
  - Unknown vendors: a row whose URL matches NO hand-written recipe
    falls through to `GenericNavigator` (generic_navigator.py) — an
    LLM-driven decision loop that reads the page and decides what to
    click, instead of failing immediately. A row whose recipe OR the
    navigator raises `RecipeError` (genuinely stuck, or a bot-challenge
    detected) returns `page_outcome="no_matching_property"`, routed to
    `_needs_review_record`. There is still no automatic retry on
    Skyvern within the same run — re-upload with `engine="skyvern"`
    for that.
  - `download_bill_pdf` is intentionally unimplemented; the recipes
    don't surface PDF-only outcomes in the first cut.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..config import Config
from ..intake import RowIntake
from .browser import Browser
from .extractor import Extractor
from .generic_navigator import GenericNavigator
from .recipes import RecipeError, RowContext, match as match_recipe

log = logging.getLogger("pontus_tax.playwright.runner")


# Mirrors `SkyvernRunner.AttemptResult` so the orchestrator's call sites
# read it the same way. Skyvern-only fields (run_id, recording_url,
# app_url) stay None on this engine; the dashboard's "Recordings" panel
# is empty for Playwright rows, which is fine — the evidence trail for
# this engine is the recipe name + final URL in `output`.
@dataclass
class AttemptResult:
    output: Any
    status: str | None
    run_id: str | None = None
    recording_url: str | None = None
    app_url: str | None = None
    failure_reason: str | None = None
    downloaded_files: list[Any] = field(default_factory=list)


class PlaywrightRunner:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.browser = Browser(cfg)
        self.extractor = Extractor(cfg)
        # Falls through here for any URL that matches no hand-written
        # recipe, instead of failing immediately (see run_attempt below).
        self.generic_navigator = GenericNavigator(cfg)
        # (domain, url) -> AttemptResult cache. The orchestrator's
        # ladder calls `run_attempt` once per search term; for
        # Playwright they all collapse to one recipe run.
        self._cache: dict[tuple[str, str], AttemptResult] = {}

    # -- Skyvern-shaped surface ------------------------------------------

    async def reap_orphaned_sessions(self) -> int:
        # Playwright runs in-process; no orphaned cloud sessions to
        # reap. Skyvern's plan-cap concern (browser sessions stacking
        # across crashed runs) does not exist here, because Cloud Run
        # Jobs kill the whole container on failure.
        return 0

    async def close_all(self) -> None:
        await self.browser.close()

    async def run_attempt(
        self,
        domain: str,
        url: str,
        prompt: str,
        schema: dict[str, Any],
        title: str,
        *,
        row: RowIntake | None = None,
        group_candidates: list[str] | None = None,
        row_key: str | None = None,
    ) -> AttemptResult:
        """Drive ONE Playwright recipe + ONE Haiku extraction, scoped to
        ONE account group on ONE row. The `prompt` and `schema` args are
        deliberately ignored — Skyvern's prompt steers a vision agent;
        Playwright doesn't need it. The recipe + extractor enforce the
        same contract via code + schema, not prose.

        `row` carries address/owner/tax-year context shared by every
        account on the row. `group_candidates` is the SPECIFIC
        account's normalized candidates (CLAUDE.md §2.2) — NOT the
        whole row's. `row_key` (the orchestrator's per-row job key,
        e.g. "s00_r0005") plus `group_candidates` form the cache scope.

        Why both matter: a single row can carry multiple accounts at
        one address in one cell (CLAUDE.md §9, the Pinellas case —
        three accounts, one URL), and multiple SEPARATE rows can share
        one bare search URL (CLAUDE.md §9, the Broward case — three
        rows, one search page). Caching by (domain, url) alone collapses
        all of those into one cached result: whichever account the
        recipe happens to resolve first gets silently relabeled and
        reused for every other account/row that shares the URL — wrong
        dollar amounts written under a different account's name with no
        error raised. Scoping the cache key (and the candidates handed
        to the recipe) to THIS row + THIS group's own candidates is
        what makes each account get its own real search.
        """
        cache_key = (domain, url, row_key, tuple(group_candidates or ()))
        cached = self._cache.get(cache_key)
        if cached is not None:
            log.debug("playwright cache hit for %s (row=%s)", url, row_key)
            return cached

        # --- 1) Pick a recipe by URL pattern; fall through to the
        # generic, LLM-driven navigator for any vendor we have no
        # hand-written recipe for, instead of failing immediately.
        # Both expose the same fetch(browser, url, ctx) -> FetchResult
        # shape and a `.name`, so everything below treats them alike.
        recipe_cls = match_recipe(url)
        recipe: Any = recipe_cls() if recipe_cls is not None else self.generic_navigator
        if recipe_cls is None:
            log.info(
                "no hand-written recipe for %r — falling through to the "
                "generic navigator", domain or url,
            )

        if row is None:
            # The Skyvern path doesn't pass row; if we get here on
            # Playwright the caller forgot. Return a clear soft error
            # rather than crashing the whole run.
            result = AttemptResult(
                output={
                    "page_outcome": "error",
                    "amount_due_now": None,
                    "bills": [],
                    "notes": (
                        "Playwright runner called without row context; "
                        "recipes need the row to drive the search."
                    ),
                },
                status="completed",
                failure_reason="missing_row_context",
            )
            self._cache[cache_key] = result
            return result

        # account_candidates is THIS group's candidates only — never
        # the whole row's (see the cache-scoping note above). address /
        # owner_entity / tax_year ARE legitimately row-level: a row's
        # multiple accounts share one physical property.
        ctx = RowContext(
            url=url,
            address=row.address,
            owner_entity=row.owner_entity,
            account_candidates=list(group_candidates or []),
            tax_year=row.tax_year,
            county=row.county,
            state=row.state,
        )

        # --- 2) Run the recipe. ------------------------------------------
        try:
            fetched = await recipe.fetch(self.browser, url, ctx)
        except RecipeError as exc:
            # Most RecipeErrors genuinely mean "couldn't find this
            # property" — but a bot-check/CAPTCHA (generic_navigator's
            # two distinct raise sites: the top-level marker scan, and
            # the model explicitly reporting "blocked") means the
            # opposite: the portal never showed us anything to judge a
            # match against. Route those to "blocked" so the
            # orchestrator's dedicated needs-review message (§ Type E)
            # fires instead of the misleading "no matching property"
            # one, which reads as "wrong property" to an analyst when
            # the real story is "never got past the challenge page".
            exc_text = str(exc).lower()
            is_bot_block = "bot-detection" in exc_text or "bot-check" in exc_text
            log.warning("recipe %s soft-failed for %s: %s", recipe.name, url, exc)
            result = AttemptResult(
                output={
                    "page_outcome": "blocked" if is_bot_block else "no_matching_property",
                    "amount_due_now": None,
                    "bills": [],
                    "notes": f"{recipe.name}: {exc}",
                },
                status="completed",
                failure_reason=str(exc)[:200],
            )
            self._cache[cache_key] = result
            return result
        # Any other exception (network timeout, browser crash) bubbles
        # to the orchestrator's per-row try/except → UNREACHABLE. That
        # is the right shape: if the browser died, the row genuinely
        # didn't get checked.

        # --- 3) Extract structured fields from the rendered page. --------
        # `accounts` here is the SAME group_candidates the recipe just
        # searched with — keeping this in sync with ctx.account_candidates
        # above is what makes the extractor's verification context match
        # what was actually searched, instead of the whole row's accounts.
        extracted = await self.extractor.extract(
            fetched.page_text,
            owner_entity=row.owner_entity,
            address=row.address,
            accounts=list(group_candidates or []),
            tax_year=row.tax_year,
            final_url=fetched.final_url,
        )
        # Ensure final_url rides the result so the orchestrator's
        # verification step (assess_match) can read it.
        extracted.setdefault("final_url", fetched.final_url)
        extracted.setdefault("bills", [])
        # Tag the recipe family so the dashboard can show which path
        # was taken on a row-by-row basis.
        extracted["recipe"] = recipe.name

        result = AttemptResult(output=extracted, status="completed")
        self._cache[cache_key] = result
        return result

    async def download_bill_pdf(
        self,
        domain: str,
        url: str,
        goal: str,
    ) -> AttemptResult:
        """PDF-only portals (§4F) are not handled by recipes in the
        first cut. The orchestrator only calls this when the extractor
        emits page_outcome="pdf_only", and the Haiku extractor never
        does. If we ever get here it means a recipe explicitly emitted
        pdf_only; for now, return a soft failure so the row lands in
        Needs Review with a clear reason.
        """
        return AttemptResult(
            output={
                "page_outcome": "error",
                "amount_due_now": None,
                "bills": [],
                "notes": (
                    "PDF-only portal — not yet supported on the "
                    "Playwright engine. Re-run with engine=skyvern."
                ),
            },
            status="completed",
            failure_reason="pdf_path_not_supported",
        )
