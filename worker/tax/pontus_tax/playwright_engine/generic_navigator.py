"""Generic, vendor-agnostic navigator — the real "option 2".

Every OTHER module in playwright_engine/recipes/ is hand-written per
vendor: look at one portal's real DOM, write selectors for its exact
search box, its exact results list. That does not scale — every new
vendor family found in the portfolio (Grant Street, Aumentum, mptsweb,
...) needs its own multi-hour investigation-and-debug cycle, the same
one Grant Street went through.

This module replaces that with a loop: instead of hard-coded clicks,
an LLM looks at a compact, text-only view of whatever page is in front
of it and decides what to do next, the same way a person would on a
site they have never seen. No per-vendor code. The trade is real:
this makes one more model call per step, and it can be wrong in ways
hard-coded selectors can't. Both costs are worth it against writing
and maintaining N recipes for N vendors that keep multiplying.

How it sees the page: Playwright's `aria_snapshot(mode="ai")`, NOT a
screenshot. It returns a compact, indented outline of every
interactive element (links, buttons, fields) with a short ref like
`[ref=e5]`, and — verified directly against a real 2-iframe test page,
not assumed — automatically walks into <iframe> content too, prefixing
refs from the first iframe as `f1e5`, the second as `f2e5`, etc. This
is enough for every portal we have looked at today (Grant Street,
Aumentum): they are plain government HTML, not complex visual
layouts, so text is enough — no need to pay for image tokens.

The cross-frame interaction model, verified directly rather than
assumed (an earlier version of this file got it wrong and manually
tracked which Frame object each ref belonged to — unnecessary):
`page.locator(f"aria-ref={ref}")`, called on the PAGE object with
whatever ref string aria_snapshot gave you (bare "e5" or prefixed
"f1e5"), resolves correctly regardless of which frame the element is
actually in. Playwright routes it internally. The only rule that
matters is take the snapshot and act on its refs within the same
"round" — don't reuse refs across a page navigation.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import Config
from .browser import Browser
from .recipes import FetchResult, RecipeError, RowContext

# Navigation decisions need real reasoning about page structure and
# intent ("is this a search form or the bill itself? which result
# matches?") — a harder judgment call than the Extractor's job of
# reading clearly-labeled numbers off an already-settled page. Sonnet
# for the decisions, Haiku stays on extraction (extractor.py, unchanged).
_DEFAULT_MODEL = "claude-sonnet-4-6"

log = logging.getLogger("pontus_tax.playwright.generic_navigator")

# Hard ceiling on how many navigation decisions we'll ask for before
# giving up. Mirrors Skyvern's max_steps (15) but a bit tighter, since
# a text-only decision loop on a simple government page should not
# need many steps — if it does, something is wrong and burning more
# calls won't fix it.
_MAX_STEPS = 8

# Reused from grant_street.py's bot-challenge detection — duplicated
# rather than imported to keep this module fully independent of any
# one recipe; worth promoting to base.py if a third place needs it.
_BOT_CHALLENGE_MARKERS = (
    "performing security verification",
    "checking your browser",
    "verify you are not a bot",
    "just a moment",
)

_SYSTEM_PROMPT = """You are driving a real web browser toward one goal: reach the page that shows a property's CURRENT tax bill status (paid or owed, and how much), for a specific property tax portal you have never seen before.

You are given a compact outline of the page's clickable/fillable elements (links, buttons, text fields), NOT a screenshot. Each element has a short reference like [ref=e5] (or, for something inside an embedded frame, [ref=f1e5]). You do not see colors or layout, only structure and text — that is enough for government tax portals, which are plain forms and tables, not complex visual interfaces.

You will be told the property to find (an account/parcel number, an address, an owner name) and the current page's element outline. Decide ONE next action.

Rules:
- If the CURRENT page already shows a specific property's bill/account details (an account or parcel number, an owner, a dollar amount or "paid"/"total due" language) — say so. Do not click further. This is a terminal state.
- If the page LOOKS like it is on the right track (e.g. an account summary layout) but key fields still say "Loading...", "Fetching data...", or are visibly blank/placeholder — the page is mid-render, not stuck and not done. Say so with "wait"; you will be shown the SAME page again shortly, once it has had time to finish.
- If the page is a search form, fill in the field that best matches an identifier you were given (prefer an exact account/parcel number over an address or owner name), then submit (press Enter or click the search/go button — whichever the page offers).
- If the page shows a list of multiple results, click the one that best matches the property you were given.
- If the page shows an explicit bot-check / "verifying you are human" / CAPTCHA challenge, do not try to click through it. Report this explicitly so the caller can decide what to do (retry with a different connection, or give up) — you will never solve a CAPTCHA or bypass a bot check.
- If you are lost (no relevant field, no relevant link, and this isn't a bot challenge or a loading state), say so rather than clicking something irrelevant hoping it helps.
- NEVER click anything related to paying, checking out, or adding to a cart. Read-only browsing only.

You MUST respond with ONLY a JSON object, no prose before or after it, even when you are uncertain — pick the closest matching action rather than explaining your reasoning in plain text. A prose explanation instead of JSON is always wrong, no exceptions. The shape:
{
  "action": "done" | "click" | "fill_and_submit" | "wait" | "blocked" | "give_up",
  "ref": "e5 or null",
  "value": "text to fill, or null",
  "reason": "one short sentence explaining the decision"
}

"done": the current page already shows the bill; "ref"/"value" null.
"click": click the element at "ref"; "value" null.
"fill_and_submit": fill "ref" with "value", then submit (Enter or the obvious submit control).
"wait": the page is mid-render (placeholders like "Loading..." where real data belongs); "ref"/"value" null.
"blocked": a bot-check/CAPTCHA is showing; "ref"/"value" null.
"give_up": genuinely stuck, nothing productive to do; "ref"/"value" null, explain why in "reason".
"""


class GenericNavigator:
    """Vendor-agnostic fallback: an LLM decides what to click instead
    of a hand-written recipe. Used by the router (recipes/__init__.py
    + runner.py) for any URL that doesn't match a known vendor family.
    """

    name = "generic_navigator"

    def __init__(self, cfg: Config, model: str | None = None):
        if not cfg.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is required for the generic navigator "
                "(used to decide navigation steps on unrecognized portals)"
            )
        self.cfg = cfg
        self._model = model or _DEFAULT_MODEL
        self._client: Any | None = None

    def _sdk(self) -> Any:
        if self._client is None:
            # Lazy import, mirrors extractor.py / browser.py's pattern.
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic(api_key=self.cfg.anthropic_api_key)
        return self._client

    async def fetch(
        self,
        browser: Browser,
        url: str,
        row: RowContext,
    ) -> FetchResult:
        from .recipes.base import _domain_of

        domain = _domain_of(url)
        async with browser.page(
            domain, url=url, goto_kwargs={"wait_until": "domcontentloaded"}
        ) as page:
            for step in range(_MAX_STEPS):
                # Bot-challenge check BEFORE asking the model to look at
                # the page — no point spending a call on a page we
                # already know we won't act on. Only the top-level body
                # is checked; every real challenge we've hit so far
                # (Miami-Dade, county-taxes.net) replaced the WHOLE
                # top-level page, not just an embedded frame.
                try:
                    top_text = (await page.locator("body").inner_text(timeout=3000)).lower()
                except Exception:  # noqa: BLE001
                    top_text = ""
                if any(marker in top_text[:400] for marker in _BOT_CHALLENGE_MARKERS):
                    raise RecipeError(
                        "generic navigator: portal served a bot-detection "
                        "challenge page — not solving it, per CLAUDE.md §4 Type E"
                    )

                snapshot = await page.aria_snapshot(mode="ai")
                if not snapshot.strip():
                    raise RecipeError(
                        "generic navigator: page produced an empty "
                        "accessibility snapshot (blank or still loading)"
                    )

                decision = await self._decide(snapshot, row, step)
                action = decision.get("action")
                log.info(
                    "generic navigator step %d/%d: action=%s ref=%s reason=%r",
                    step + 1, _MAX_STEPS, action, decision.get("ref"),
                    decision.get("reason", "")[:150],
                )

                if action == "done":
                    return await self._read_current(page)
                if action == "blocked":
                    raise RecipeError(
                        "generic navigator: model reported a bot-check/CAPTCHA "
                        f"— {decision.get('reason', '')[:200]}"
                    )
                if action == "give_up":
                    raise RecipeError(
                        f"generic navigator gave up: {decision.get('reason', '')[:200]}"
                    )
                if action == "wait":
                    # No ref, no click — just give the page's async
                    # content (e.g. an "Amount Due" XHR, per the exact
                    # pattern seen on Grant Street and Aumentum) a
                    # moment to settle, then re-snapshot on the next
                    # loop iteration. Counts against _MAX_STEPS like any
                    # other step, which is fine — 8 is generous headroom
                    # above what any portal we've seen has needed.
                    await page.wait_for_timeout(3000)
                    continue

                ref = decision.get("ref")
                if not ref:
                    raise RecipeError(
                        f"generic navigator: action {action!r} needs a ref but got none"
                    )
                # Resolved directly on the page object — Playwright
                # routes a prefixed ref (e.g. "f1e5") to the right
                # frame internally; verified directly, no manual
                # frame-tracking needed (see module docstring).
                target = page.locator(f"aria-ref={ref}")

                try:
                    if action == "click":
                        await target.click(timeout=10_000)
                    elif action == "fill_and_submit":
                        await target.click(timeout=10_000)
                        await target.fill(str(decision.get("value") or ""))
                        await target.press("Enter")
                    else:
                        raise RecipeError(
                            f"generic navigator: model returned unknown action {action!r}"
                        )
                    await page.wait_for_load_state("domcontentloaded", timeout=15_000)
                    await page.wait_for_timeout(1500)  # let any async content start
                except RecipeError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.warning("generic navigator: action failed: %s", exc)
                    # Don't raise — let the loop re-observe the page and
                    # try again; a stale ref after navigation is common
                    # and self-corrects on the next snapshot.

            raise RecipeError(
                f"generic navigator: exhausted {_MAX_STEPS} steps without "
                "reaching a bill page"
            )

    # ---- internals --------------------------------------------------------

    async def _decide(
        self, snapshot: str, row: RowContext, step: int
    ) -> dict[str, Any]:
        candidates = ", ".join(row.account_candidates) or "(none)"
        user_prompt = (
            f"TARGET PROPERTY\n"
            f"  Account/parcel candidates: {candidates}\n"
            f"  Address: {row.address or '(not provided)'}\n"
            f"  Owner entity: {row.owner_entity or '(not provided)'}\n"
            f"  Step {step + 1} of {_MAX_STEPS}\n\n"
            f"CURRENT PAGE ELEMENT OUTLINE:\n{snapshot[:8000]}\n\n"
            "Decide the next action now."
        )
        client = self._sdk()
        msg = await client.messages.create(
            model=self._model,
            max_tokens=512,
            system=[{
                "type": "text",
                "text": _SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": user_prompt}],
        )
        text_parts = [
            getattr(b, "text", "") for b in msg.content
            if getattr(b, "type", None) == "text"
        ]
        raw = "".join(text_parts).strip()
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.lower().startswith("json"):
                raw = raw[4:].lstrip()
            raw = raw.rsplit("```", 1)[0].strip()
        try:
            out = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("generic navigator: model returned non-JSON: %r", raw[:300])
            return {"action": "give_up", "reason": f"model returned non-JSON: {raw[:200]}"}
        if not isinstance(out, dict):
            return {"action": "give_up", "reason": f"model returned {type(out).__name__}, not an object"}
        return out

    async def _read_current(self, page: Any) -> FetchResult:
        """The model says this page already shows the bill. The data
        usually lives in an embedded iframe (every portal seen so far
        does this), so check every frame's text and keep whichever is
        longest — a real bill page reads far longer than a thin
        wrapper shell. No dependency on refs existing in that frame."""
        best_text = ""
        best_url = page.url
        for fr in page.frames:
            try:
                text = await fr.locator("body").inner_text(timeout=3000)
            except Exception:  # noqa: BLE001
                continue
            if len(text) > len(best_text):
                best_text = text
                best_url = getattr(fr, "url", page.url)
        if not best_text:
            best_text = await page.locator("body").inner_text()
        return FetchResult(page_text=best_text, final_url=best_url)
