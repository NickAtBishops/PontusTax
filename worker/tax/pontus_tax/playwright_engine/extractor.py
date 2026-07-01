"""Structured extraction from a rendered portal page.

Contract: a recipe hands us the bill page's HTML (or visible text)
plus the row's identifying context, and we return a dict shaped EXACTLY
like the Skyvern engine's `EXTRACTION_SCHEMA` output, so the orchestrator
treats both engines identically downstream (no branches in validate,
verify, build_account_record, writeback).

How we keep this cheap: ONE Claude Haiku 4.5 call per row. The system
prompt + JSON schema are passed as a cache_control "ephemeral" block,
so warm calls (every call after the first within ~5 minutes) read the
schema from Anthropic's cache and the prompt-cache-read input token
rate applies — roughly $0.10/MTok instead of $1/MTok. With a ~10k input
schema this drops the per-call cost from ~$0.012 to ~$0.003.

No vision. We feed Claude TEXT only — either the page's `innerText`
(the recipe's preferred form: it strips the HTML chrome and is far
cheaper) or, when the recipe really needs DOM detail, the raw HTML.

Read-only by construction: this module never opens a browser, never
clicks anything, never touches a portal. It only receives content that
the recipe has already rendered.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import Config
from ..extraction_schema import EXTRACTION_SCHEMA

log = logging.getLogger("pontus_tax.playwright.extractor")

# Haiku 4.5 is the right tier for this: structured extraction from
# well-formed pages where Sonnet's extra reasoning is wasted. Sonnet
# is held back as a per-row override for unusually messy pages.
_DEFAULT_MODEL = "claude-haiku-4-5"


_SYSTEM_PROMPT = """You read property-tax-portal bill pages and return ONE JSON object that conforms to the schema below. You never click anything, never fetch anything; the page text has already been rendered for you.

RULES
- Output ONLY the JSON object. No prose, no markdown, no code fences.
- The required answer is amount_due_now: the TOTAL still owed RIGHT NOW for this property across all years, including penalties / interest / fees. 0 (zero) is a perfectly valid and common answer for a paid-in-full property.
- Identity fields (owner_on_page, situs_address_on_page, parcel_or_account_on_page) come from the page exactly as printed; do not normalize.
- If the page is clearly NOT the bill page for the target property (a search form, a "no results" message, a different parcel), set page_outcome to landed_on_search, no_matching_property, ambiguous_multiple_matches, login_required, blocked, pdf_only, or error as appropriate and leave money fields null.
- Money: if the page shows "$1,234.56", return the number 1234.56. Strip "$", ",", and "USD". Negative balances are unusual but legal; preserve the sign.
- Dates: ISO yyyy-mm-dd. If only a year or "Nov 2025" is shown, use the first day of the month (2025-11-01). If no date can be determined, null.
- Never invent. If a field is not visible on the page, return null, not a guess.

SCHEMA (the JSON object you return MUST conform to this):
""" + json.dumps(EXTRACTION_SCHEMA, indent=2)


def _user_prompt(
    page_text: str,
    *,
    owner_entity: str | None,
    address: str | None,
    accounts: list[str],
    tax_year: str | None,
    final_url: str | None,
) -> str:
    """The per-row prompt: small, varies per call, NOT cached."""
    target_lines = ["TARGET PROPERTY (for verification of page_outcome)"]
    if address:
        target_lines.append(f"  Address       : {address}")
    if owner_entity:
        target_lines.append(f"  Owner entity  : {owner_entity}")
    if accounts:
        target_lines.append(f"  Account(s)    : {', '.join(accounts)}")
    if tax_year:
        target_lines.append(f"  Tax year      : {tax_year}")
    if final_url:
        target_lines.append(f"  URL rendered  : {final_url}")
    target_block = "\n".join(target_lines)

    # Truncate aggressively. Property tax bill pages are SMALL once
    # the chrome is stripped (a few KB). 25k chars is more than enough
    # and stops a misbehaving recipe from sending us a 1 MB HTML
    # document and burning tokens.
    capped = page_text[:25_000]
    truncation_note = (
        "\n[content truncated at 25,000 chars]" if len(page_text) > 25_000 else ""
    )

    return (
        f"{target_block}\n\n"
        f"PAGE CONTENT (already rendered, text only):\n"
        f"-----8<-----\n{capped}{truncation_note}\n----->8-----\n\n"
        f"Return the JSON object now."
    )


class Extractor:
    def __init__(self, cfg: Config, model: str | None = None):
        if not cfg.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is required for the Playwright engine "
                "(used to extract structured fields from rendered pages)"
            )
        self.cfg = cfg
        self.model = model or _DEFAULT_MODEL
        self._client: Any | None = None

    def _sdk(self) -> Any:
        if self._client is None:
            # Lazy import so machines without anthropic installed can
            # still import this module (mirrors browser.py's pattern).
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic(api_key=self.cfg.anthropic_api_key)
        return self._client

    async def extract(
        self,
        page_text: str,
        *,
        owner_entity: str | None,
        address: str | None,
        accounts: list[str],
        tax_year: str | None,
        final_url: str | None,
    ) -> dict[str, Any]:
        """Run one Haiku call. Returns a dict that matches
        `EXTRACTION_SCHEMA` so it can be handed straight to
        `validate.build_account_record` without translation.

        Raises on transport errors (the runner translates these into
        UNREACHABLE via the orchestrator's existing per-row try/except;
        see orchestrator.py line ~615).
        """
        client = self._sdk()
        msg = await client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    # The cache makes the schema effectively free on
                    # every call after the first in a ~5-min window.
                    # The per-row content is in the user message and
                    # is NOT cached.
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": _user_prompt(
                        page_text,
                        owner_entity=owner_entity,
                        address=address,
                        accounts=accounts,
                        tax_year=tax_year,
                        final_url=final_url,
                    ),
                }
            ],
        )
        # Claude returns content blocks; the model is instructed to
        # output the JSON object as plain text. Concatenate any text
        # blocks, then parse.
        text_parts = [
            getattr(block, "text", "")
            for block in msg.content
            if getattr(block, "type", None) == "text"
        ]
        raw = "".join(text_parts).strip()
        # Cheap defensive strip: if the model wrapped the JSON in a
        # ```json fence despite the instructions, peel it.
        if raw.startswith("```"):
            raw = raw.strip("`")
            if raw.lower().startswith("json"):
                raw = raw[4:].lstrip()
            raw = raw.rsplit("```", 1)[0].strip()
        def _malformed(reason: str) -> dict[str, Any]:
            # Map to the same "error" shape the Skyvern path emits when
            # output is garbled, so downstream code is identical.
            log.warning("extractor: %s | raw=%r", reason, raw[:400])
            return {
                "page_outcome": "error",
                "amount_due_now": None,
                "bills": [],
                "notes": f"extraction returned non-JSON: {raw[:300]}",
            }

        try:
            out = json.loads(raw)
        except json.JSONDecodeError as exc:
            return _malformed(f"JSON parse failed: {exc}")
        if not isinstance(out, dict):
            # Valid JSON syntax (e.g. a bare list, string, number, or
            # null) is NOT guaranteed to be an object — only
            # JSONDecodeError is a parse failure. Without this check,
            # `out.setdefault(...)` below raises an uncaught
            # AttributeError on a list/str/None, which bypasses this
            # clean fallback and surfaces as an opaque "runner error:
            # ... object has no attribute 'setdefault'" instead.
            return _malformed(
                f"top-level JSON was {type(out).__name__}, not an object"
            )
        # Backwards-compat shim: orchestrator/validate look for a `bills`
        # list on some code paths. The new schema doesn't carry one;
        # set an empty list so downstream code that asks for it gets a
        # safe default rather than KeyError.
        out.setdefault("bills", [])
        return out
