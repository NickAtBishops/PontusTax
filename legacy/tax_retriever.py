"""
tax_retriever.py
================

Retrieve the CURRENT property-tax amount due from an arbitrary county
tax-collector portal, given only a URL and a property address.

The portals look nothing alike (different layouts, some land directly on an
account page, some show a search box, some return a list of matching parcels),
so the program does NOT hardcode selectors. It leans on Skyvern's vision/LLM
agent to navigate and read the page, and uses Claude as a validation layer that
decides whether the agent landed on the right parcel and whether to retry with a
different search term (owner name or parcel id) before trusting the number.

Flow
----
1. Open a single live browser session (so login + search + read share state).
2. Run ONE adaptive Skyvern task: navigate -> (search by address if needed)
   -> (pick the matching result if a list appears) -> read current amount due.
   Login is handled in the same task only when credentials are supplied.
3. Hand the raw extraction to Claude, which canonicalizes it and judges whether
   the matched property actually corresponds to the requested address. Claude
   answers through a forced tool call, so the result is always structured JSON.
4. If Claude is not confident there was a match (or confidence is below the
   floor), retry the Skyvern task using a fallback search term (owner, then
   parcel id). Cap the number of attempts.

Target value
------------
"current amount due" = the live outstanding balance the owner must still pay
right now. Amounts already paid and historical receipts are ignored. If the
account is fully paid, the correct answer is 0.00.

Requirements
------------
    pip install skyvern anthropic python-dotenv

Environment
-----------
    SKYVERN_API_KEY      from https://app.skyvern.com/settings
    ANTHROPIC_API_KEY    from the Anthropic console
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, asdict
from typing import Any, Optional

from anthropic import AsyncAnthropic
from skyvern import Skyvern
from skyvern.client.core.api_error import ApiError

# Optional: load a local .env if python-dotenv is installed. Guarded so the
# module still imports cleanly without the dependency.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ModuleNotFoundError:
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tax_retriever")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

# Anthropic model for the validation / normalization pass. This is structured
# JSON judgment plus a lenient address comparison, so Sonnet is the right
# cost/quality fit. Haiku ("claude-haiku-4-5-20251001") also works and is
# cheaper if you are running many lookups. Current model strings:
# https://docs.claude.com/en/docs/about-claude/models
NORMALIZER_MODEL = "claude-sonnet-4-6"

# Skyvern agent engine. skyvern-2.0 is the default and handles multi-step
# navigate -> search -> select -> read flows well.
SKYVERN_ENGINE = "skyvern-2.0"

# Cap steps so a misbehaving site cannot run up cost. Raise if portals are deep.
MAX_STEPS = 25

# Route through a residential IP. Many production county portals sit behind WAFs
# that block datacenter IPs. "RESIDENTIAL" is Skyvern's default random US
# residential pool. For a stubborn in-state portal you can instead pass a
# GeoTarget, e.g. {"country": "US", "subdivision": "FL"}. Set to "NONE" to
# disable.
PROXY_LOCATION: Any = "RESIDENTIAL"

# How many search terms to try before giving up (address, then fallbacks).
MAX_ATTEMPTS = 3

# Minimum confidence Claude must report before we trust a match as a final
# answer. Below this we treat the attempt as a retry if a fallback term remains.
CONFIDENCE_FLOOR = 0.7

# Statuses Skyvern returns that mean the run will not produce more output.
TERMINAL_FAILURE = {"failed", "terminated", "timed_out", "canceled"}

# Backoff delays (seconds) for transient 5xx from Skyvern's cloud. The session
# endpoint occasionally returns 504 when their browser pool is warming. If all
# attempts fail we fall back to running each task without a shared session.
SESSION_CREATE_BACKOFFS = (2, 5, 10)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def _clean_address(s: str) -> str:
    """Turn tab/newline-separated address fields into one comma-separated line.

    The inputs often arrive pasted from a spreadsheet, e.g.
    '950 Evernia St\\tWest Palm Beach\\tFL\\t33401\\tPalm Beach'. Feeding tabs
    into a search box hurts match rates, so collapse them into a clean string.
    """
    parts = [seg.strip() for seg in re.split(r"[\t\n]+", s) if seg.strip()]
    if not parts:
        return s.strip()
    return ", ".join(parts)


def _coerce_output(raw: Any) -> Any:
    """Skyvern output can be a dict, a list, or a JSON string. Normalize to a
    Python object so downstream field access does not silently fail."""
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return {"raw_text": raw}
    return raw


# --------------------------------------------------------------------------- #
# Input / output models
# --------------------------------------------------------------------------- #

@dataclass
class PropertyInput:
    url: str
    property_address: str
    owner_name: Optional[str] = None         # fallback search term
    parcel_id: Optional[str] = None          # fallback search term
    # Only for the rare portal that gates the BALANCE behind a real login.
    # Prefer Skyvern's encrypted credential store in production (see notes at
    # the bottom of this file) rather than passing raw secrets here.
    username: Optional[str] = None
    password: Optional[str] = None

    def __post_init__(self) -> None:
        # Keep a clean, comma-separated full address for matching and prompts.
        self.property_address = _clean_address(self.property_address)

    def _street_search_value(self) -> str:
        """Primary search term: the street portion before the first comma.
        Most portals search on the street address, not the full city/state/zip
        blob. The full address is still used for matching in the prompt."""
        street = self.property_address.split(",")[0].strip()
        return street or self.property_address

    def search_terms(self) -> list[tuple[str, str]]:
        """Ordered (label, value) search terms to try."""
        terms = [("property address", self._street_search_value())]
        if self.owner_name:
            terms.append(("owner name", self.owner_name))
        if self.parcel_id:
            terms.append(("parcel / account number", self.parcel_id))
        return terms[:MAX_ATTEMPTS]


@dataclass
class TaxResult:
    success: bool
    amount_due: Optional[float] = None       # canonical numeric balance owed now
    raw_amount_string: Optional[str] = None  # exactly as shown on the page
    currency: str = "USD"
    amount_label: Optional[str] = None        # the label the page used
    as_of_date: Optional[str] = None
    parcel_id: Optional[str] = None
    property_address_on_page: Optional[str] = None
    owner_on_page: Optional[str] = None
    matched: bool = False                     # does the page match the request?
    match_basis: Optional[str] = None
    confidence: float = 0.0
    attempts: int = 0
    reasoning: Optional[str] = None
    page_outcome: Optional[str] = None
    recording_url: Optional[str] = None       # Skyvern run video, for audit
    screenshot_urls: Optional[list] = None    # last screenshots, for audit
    raw_extract: Any = None                   # full Skyvern output, for audit
    error: Optional[str] = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, default=str)


# --------------------------------------------------------------------------- #
# Extraction schema
#
# Skyvern fills these fields by reading the page. The field DESCRIPTIONS do the
# heavy lifting (the agent reads them), so they are written to remove ambiguity
# about what "currently due" means and to capture enough context for Claude to
# verify the right parcel was opened.
# --------------------------------------------------------------------------- #

EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "current_amount_due": {
            "type": ["string", "null"],
            "description": (
                "The CURRENT total property tax the owner must still pay right "
                "now, copied exactly as shown including the currency symbol "
                "(for example '$0.00' or '$3,915.80'). This is the live "
                "outstanding balance, NOT an amount that has already been paid. "
                "Look for a figure labeled 'Total Amount Due', 'Total Payable', "
                "'Balance Due', 'Amount Due', or the total of any unpaid bills. "
                "If every bill shows as paid/redeemed, the current amount due is "
                "'0.00'. Return null only if no due figure can be found."
            ),
        },
        "amount_label": {
            "type": ["string", "null"],
            "description": (
                "The exact label the page used for the current_amount_due figure "
                "(e.g. 'Total Amount Due', 'Total Payable', 'Balance Due')."
            ),
        },
        "parcel_id": {
            "type": ["string", "null"],
            "description": (
                "The parcel number, property control number, or account number "
                "shown on the property detail page that was opened."
            ),
        },
        "property_address_on_page": {
            "type": ["string", "null"],
            "description": (
                "The situs / physical property address shown on the detail page "
                "that was opened (not the owner's mailing address if they differ)."
            ),
        },
        "owner_on_page": {
            "type": ["string", "null"],
            "description": "The owner of record shown on the opened detail page.",
        },
        "as_of_date": {
            "type": ["string", "null"],
            "description": (
                "Any 'last updated', 'as of', or balance-date timestamp shown."
            ),
        },
        "page_outcome": {
            "type": "string",
            "enum": [
                "amount_found",
                "ambiguous_multiple_matches",
                "no_matching_property",
                "login_required_no_credentials",
                "blocked",
                "error",
            ],
            "description": (
                "How the task ended. 'amount_found' only if a due figure was read "
                "on a property page matching the target. 'ambiguous_multiple_"
                "matches' if several parcels matched and the right one was unclear. "
                "'no_matching_property' if the search returned nothing usable. "
                "'login_required_no_credentials' if a real login blocked access "
                "and no credentials were available. 'blocked' for CAPTCHA/WAF/"
                "access-denied. 'error' for anything else."
            ),
        },
        "candidate_matches": {
            "type": "array",
            "description": (
                "Only if multiple parcels matched the search: one entry per "
                "candidate so the caller can disambiguate."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "address": {"type": "string"},
                    "owner": {"type": "string"},
                    "parcel_id": {"type": "string"},
                },
            },
        },
        "notes": {
            "type": ["string", "null"],
            "description": "Anything unusual worth flagging to the caller.",
        },
    },
    "required": ["current_amount_due", "page_outcome"],
}


# --------------------------------------------------------------------------- #
# Skyvern prompt builder
#
# One prompt has to cover every layout. It is structured as: the objective, the
# strict definition of the target number, an adaptive decision tree for what the
# landing page might be, hard guardrails (never touch the payment flow), and a
# clear completion condition. Each clause exists to kill a specific failure mode.
# --------------------------------------------------------------------------- #

def build_prompt(p: PropertyInput, search_label: str, search_value: str) -> str:
    login_clause = ""
    if p.username and p.password:
        login_clause = (
            "\nLOGIN:\n"
            f"- If, and only if, a username/password login form blocks access to "
            f"the property balance, log in with username '{p.username}' and "
            f"password '{p.password}', then continue. Do not create a new account."
        )

    candidate_hint = ""
    if p.owner_name or p.parcel_id:
        bits = []
        if p.owner_name:
            bits.append(f"owner of record '{p.owner_name}'")
        if p.parcel_id:
            bits.append(f"parcel/account number '{p.parcel_id}'")
        candidate_hint = (
            "\nDISAMBIGUATION:\n"
            f"- The correct property also has {', and '.join(bits)}. Use this to "
            f"pick the right row if the search returns more than one result."
        )

    return f"""\
OBJECTIVE
You are reading a county property-tax website. Find the CURRENT total amount of
property tax that is still owed (the live outstanding balance) for this property:

  Property address : {p.property_address}
  Searching by      : {search_label} = "{search_value}"

WHAT "CURRENT AMOUNT DUE" MEANS
- It is the money the owner must still pay right now.
- Amounts already paid, prior-year receipts, and redeemed certificates are NOT
  currently due. Ignore them.
- If a single figure labeled "Total Amount Due", "Total Payable", "Balance Due",
  or "Amount Due" is shown, that is the answer.
- If multiple tax years are listed, the answer is the sum of the UNPAID balances
  (current plus any delinquent), i.e. the grand total still owed.
- If every bill shows as paid or redeemed, the current amount due is 0.00. That
  is a valid, correct answer, not a failure.

WHAT TO DO (the landing page can be any of these; adapt)
1. If the page already shows this property's tax detail with a due/payable/
   balance figure, read it directly.
2. If the page has a search box, type the {search_label} ("{search_value}") into
   it and submit (click the search button / magnifying glass or press Enter).
   WAIT for the results to fully load before doing anything else.
3. If the search returns a LIST of multiple matching properties, open the single
   row whose address best matches "{p.property_address}". Then read its balance.
4. If the search returns exactly one property or jumps straight to a detail page,
   read its balance.{candidate_hint}{login_clause}

HARD RULES (do not break these)
- Do NOT add anything to a cart. Do NOT click "Add to Cart", "Check Out", "Pay",
  "Pay Now", or proceed to any checkout or payment step. You only READ.
- Do NOT enter any payment or card information.
- Stay in English if a language toggle is offered.
- Do NOT guess a number. If you cannot find a matching property or a due figure,
  set page_outcome accordingly and leave current_amount_due null.

COMPLETION
You are done once you have opened a property page that matches the target
address and read its current amount due (even if that amount is 0.00). Then
return the data described by the extraction schema.
"""


# --------------------------------------------------------------------------- #
# Claude validation / normalization
#
# Skyvern's raw output is free-form and varies by site. Claude turns it into one
# canonical record AND decides whether the page actually matched the request. We
# force a tool call so the answer is always a structured dict, with no markdown
# fences or stray prose to parse around.
# --------------------------------------------------------------------------- #

NORMALIZER_SYSTEM = """\
You validate and normalize property-tax data scraped from county websites.
You are given (a) the property the user asked about and (b) the raw fields a
browser agent extracted from whatever page it ended up on.

Decide whether the page the agent read actually corresponds to the requested
property. Compare addresses leniently (abbreviations, suffixes, casing, and unit
formatting differ across sites) and use owner name and parcel id when present.
Parse the current amount due into a plain number (strip "$" and commas); a
correctly read, fully-paid account is amount_due = 0.0 with matched = true. If
the page did NOT match, if no due figure was found, or if your confidence is low,
set needs_retry true and suggest the most useful next search term when there is
one. Report your judgment by calling the report_validation tool.
"""

VALIDATION_TOOL: dict[str, Any] = {
    "name": "report_validation",
    "description": "Report the normalized, validated property-tax result.",
    "input_schema": {
        "type": "object",
        "properties": {
            "amount_due": {
                "type": ["number", "null"],
                "description": "Current balance owed as a plain number; 0.0 if fully paid.",
            },
            "raw_amount_string": {
                "type": ["string", "null"],
                "description": "The amount exactly as shown on the page.",
            },
            "currency": {"type": "string"},
            "amount_label": {"type": ["string", "null"]},
            "as_of_date": {"type": ["string", "null"]},
            "parcel_id": {"type": ["string", "null"]},
            "property_address_on_page": {"type": ["string", "null"]},
            "owner_on_page": {"type": ["string", "null"]},
            "matched": {
                "type": "boolean",
                "description": "True if the page corresponds to the requested property.",
            },
            "match_basis": {
                "type": ["string", "null"],
                "description": "Short note on what you matched on (address, owner, parcel).",
            },
            "confidence": {
                "type": "number",
                "description": "0.0-1.0 confidence in the match and the amount.",
            },
            "needs_retry": {"type": "boolean"},
            "suggested_search_term": {
                "type": ["string", "null"],
                "enum": ["owner name", "parcel id", None],
            },
            "reasoning": {"type": "string"},
        },
        "required": ["amount_due", "matched", "confidence", "needs_retry"],
    },
}


async def normalize_with_claude(
    anthropic: AsyncAnthropic,
    p: PropertyInput,
    raw_output: Any,
) -> dict[str, Any]:
    user_payload = {
        "requested_property": {
            "address": p.property_address,
            "owner_name": p.owner_name,
            "parcel_id": p.parcel_id,
        },
        "raw_extracted_fields": raw_output,
    }

    resp = await anthropic.messages.create(
        model=NORMALIZER_MODEL,
        max_tokens=700,
        system=NORMALIZER_SYSTEM,
        tools=[VALIDATION_TOOL],
        tool_choice={"type": "tool", "name": "report_validation"},
        messages=[{"role": "user", "content": json.dumps(user_payload, default=str)}],
    )

    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "report_validation":
            return dict(block.input)

    # Forcing tool_choice should prevent this, but stay defensive: if no tool
    # call came back, signal a low-confidence retry rather than crashing.
    log.warning("Normalizer returned no tool_use block; treating as a retry.")
    return {
        "amount_due": None,
        "matched": False,
        "confidence": 0.0,
        "needs_retry": True,
        "reasoning": "Validator returned no structured output.",
    }


# --------------------------------------------------------------------------- #
# Skyvern task runner (one attempt)
# --------------------------------------------------------------------------- #

async def open_session_with_retry(skyvern: Skyvern) -> Optional[str]:
    """Try to provision a shared browser session, retrying transient 5xx.

    Returns the session id on success, or None if all attempts hit a 5xx (in
    which case the caller should fall back to running each task without a
    persistent session - Skyvern will provision an ephemeral browser per task).
    """
    attempts = len(SESSION_CREATE_BACKOFFS) + 1
    for i in range(attempts):
        try:
            session = await skyvern.create_browser_session()
            return session.browser_session_id
        except ApiError as exc:
            transient = exc.status_code is not None and exc.status_code >= 500
            if not transient or i == attempts - 1:
                log.warning(
                    "create_browser_session failed (status=%s): %s. "
                    "Proceeding without a shared session.",
                    exc.status_code, exc.body,
                )
                return None
            delay = SESSION_CREATE_BACKOFFS[i]
            log.warning(
                "create_browser_session got %s; retrying in %ds (attempt %d/%d)",
                exc.status_code, delay, i + 1, attempts,
            )
            await asyncio.sleep(delay)
    return None


async def run_skyvern_attempt(
    skyvern: Skyvern,
    p: PropertyInput,
    session_id: Optional[str],
    search_label: str,
    search_value: str,
) -> dict[str, Any]:
    prompt = build_prompt(p, search_label, search_value)
    log.info("Skyvern attempt: searching by %s = %r", search_label, search_value)

    task_kwargs: dict[str, Any] = dict(
        url=p.url,
        prompt=prompt,
        data_extraction_schema=EXTRACTION_SCHEMA,
        engine=SKYVERN_ENGINE,
        max_steps=MAX_STEPS,
        proxy_location=PROXY_LOCATION,
        wait_for_completion=True,
    )
    if session_id is not None:
        task_kwargs["browser_session_id"] = session_id

    run = await skyvern.run_task(**task_kwargs)

    status = getattr(run, "status", None)
    log.info("  -> status=%s", status or "unknown")

    if status in TERMINAL_FAILURE:
        output: Any = {
            "page_outcome": "error",
            "current_amount_due": None,
            "notes": f"Skyvern run ended with status={status}; "
                     f"reason={getattr(run, 'failure_reason', None)}",
        }
    else:
        output = getattr(run, "output", None)

    return {
        "output": output,
        "status": status,
        # Audit trail. For a money tool you want a receipt you can eyeball later.
        "recording_url": getattr(run, "recording_url", None),
        "screenshot_urls": getattr(run, "screenshot_urls", None),
    }


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #

async def retrieve_current_tax_due(p: PropertyInput) -> TaxResult:
    skyvern = Skyvern(api_key=os.environ["SKYVERN_API_KEY"])
    anthropic = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    # One live browser session shared across attempts (keeps any login + cookies).
    # If Skyvern's session endpoint is degraded (intermittent 504s), fall back
    # to running each task with its own ephemeral browser.
    session_id = await open_session_with_retry(skyvern)
    if session_id is None:
        log.info("Running without a shared browser session (per-task ephemeral browsers).")
    else:
        log.info("Opened browser session %s", session_id)

    result = TaxResult(success=False)

    try:
        terms = p.search_terms()
        attempt = 0
        idx = 0

        while attempt < MAX_ATTEMPTS and idx < len(terms):
            attempt += 1
            label, value = terms[idx]

            attempt_result = await run_skyvern_attempt(skyvern, p, session_id, label, value)
            raw = _coerce_output(attempt_result["output"])

            result.raw_extract = raw
            result.recording_url = attempt_result.get("recording_url")
            result.screenshot_urls = attempt_result.get("screenshot_urls")
            result.attempts = attempt

            verdict = await normalize_with_claude(anthropic, p, raw)
            log.info("  Claude: matched=%s confidence=%.2f needs_retry=%s",
                     verdict.get("matched"), verdict.get("confidence", 0.0),
                     verdict.get("needs_retry"))

            # Fold Claude's verdict into the result.
            result.amount_due = verdict.get("amount_due")
            result.raw_amount_string = verdict.get("raw_amount_string")
            result.currency = verdict.get("currency", "USD")
            result.amount_label = verdict.get("amount_label")
            result.as_of_date = verdict.get("as_of_date")
            result.parcel_id = verdict.get("parcel_id")
            result.property_address_on_page = verdict.get("property_address_on_page")
            result.owner_on_page = verdict.get("owner_on_page")
            result.matched = bool(verdict.get("matched"))
            result.match_basis = verdict.get("match_basis")
            result.confidence = float(verdict.get("confidence", 0.0))
            result.reasoning = verdict.get("reasoning")
            result.page_outcome = raw.get("page_outcome") if isinstance(raw, dict) else None

            have_amount = result.amount_due is not None

            # Success: right parcel, a numeric balance, and enough confidence.
            if result.matched and have_amount and result.confidence >= CONFIDENCE_FLOOR:
                result.success = True
                break

            # A matched, numeric, but low-confidence read is not trustworthy on
            # its own; retry with a more specific term if one remains.
            low_confidence = result.matched and have_amount and result.confidence < CONFIDENCE_FLOOR
            should_retry = bool(verdict.get("needs_retry")) or low_confidence

            if should_retry:
                suggested = (verdict.get("suggested_search_term") or "").lower()
                # Jump to the suggested term if we have it; else just go to the
                # next available fallback in order. Never move backwards.
                next_idx = idx + 1
                if "owner" in suggested:
                    next_idx = next((i for i, (l, _) in enumerate(terms)
                                     if "owner" in l), idx + 1)
                elif "parcel" in suggested or "account" in suggested:
                    next_idx = next((i for i, (l, _) in enumerate(terms)
                                     if "parcel" in l), idx + 1)
                idx = max(next_idx, idx + 1)
                continue

            # Claude is not asking for a retry but we still failed -> stop.
            break

        if not result.success and result.error is None:
            result.error = (
                f"Could not confirm a matching property balance after "
                f"{result.attempts} attempt(s). Last outcome: {result.page_outcome}; "
                f"matched={result.matched}; confidence={result.confidence:.2f}."
            )

    except Exception as exc:  # noqa: BLE001 - surface anything to the caller
        log.exception("Retrieval failed")
        result.success = False
        result.error = f"{type(exc).__name__}: {exc}"
    finally:
        if session_id is not None:
            try:
                await skyvern.close_browser_session(session_id)
                log.info("Closed browser session %s", session_id)
            except Exception:  # noqa: BLE001
                pass

    return result


# --------------------------------------------------------------------------- #
# Sync wrapper (handy for Flask)
# --------------------------------------------------------------------------- #

def retrieve_current_tax_due_sync(p: PropertyInput) -> TaxResult:
    return asyncio.run(retrieve_current_tax_due(p))

# --------------------------------------------------------------------------- #
# Batch retrieval (concurrent)
#
# With a paid Skyvern plan you can run several browser sessions at once. This
# runs many lookups concurrently, bounded by a semaphore so you never exceed
# your plan's concurrent-session cap. Each lookup still opens its own isolated
# session, so one slow or stuck portal does not block the others.
# --------------------------------------------------------------------------- #

# Keep this at or below your Skyvern plan's concurrent browser-session limit.
MAX_CONCURRENCY = 5


async def retrieve_many(
    props: list[PropertyInput],
    concurrency: int = MAX_CONCURRENCY,
    on_result=None,
) -> list[TaxResult]:
    """Run many retrievals concurrently.

    `on_result(index, result)` is invoked as each lookup finishes (in completion
    order, not input order) so a caller can stream progress / write output. It
    may be a plain function or a coroutine function.
    """
    sem = asyncio.Semaphore(max(1, concurrency))
    results: list[Optional[TaxResult]] = [None] * len(props)

    async def worker(i: int, p: PropertyInput) -> None:
        async with sem:
            res = await retrieve_current_tax_due(p)
        results[i] = res
        if on_result is not None:
            out = on_result(i, res)
            if asyncio.iscoroutine(out):
                await out

    await asyncio.gather(*(worker(i, p) for i, p in enumerate(props)))
    return results  # type: ignore[return-value]


def retrieve_many_sync(
    props: list[PropertyInput],
    concurrency: int = MAX_CONCURRENCY,
) -> list[TaxResult]:
    return asyncio.run(retrieve_many(props, concurrency=concurrency))


# --------------------------------------------------------------------------- #
# Example
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    # Palm Beach County example from the uploaded account page (fully paid -> 0.00).
    prop = PropertyInput(
        url="https://pbctax.publicaccessnow.com/PropertyTax/Account.aspx?p=74-43-43-21-01-043-0050&a=1418360",
        property_address="950 Evernia St\tWest Palm Beach\tFL\t33401\tPalm Beach",
        owner_name="EHC Palm Beach",
        parcel_id="74-43-43-21-01-043-0050",
    )
    out = retrieve_current_tax_due_sync(prop)
    print(out.to_json())


# --------------------------------------------------------------------------- #
# Flask wiring (sketch)
# --------------------------------------------------------------------------- #
#
#   from flask import Flask, request, jsonify
#   from tax_retriever import PropertyInput, retrieve_current_tax_due_sync
#
#   app = Flask(__name__)
#
#   @app.post("/tax/lookup")
#   def lookup():
#       body = request.get_json(force=True)
#       prop = PropertyInput(
#           url=body["url"],
#           property_address=body["property_address"],
#           owner_name=body.get("owner_name"),
#           parcel_id=body.get("parcel_id"),
#       )
#       result = retrieve_current_tax_due_sync(prop)
#       return jsonify({"success": result.success, **json.loads(result.to_json())})
#
# For throughput, run each lookup in a worker/queue rather than blocking the
# request thread, since a Skyvern run can take a minute or more.
#
# --------------------------------------------------------------------------- #
# Production note on credentials
# --------------------------------------------------------------------------- #
#
# Passing username/password on PropertyInput injects them into the agent prompt,
# which is fine for a quick test but not ideal. For real logins, use Skyvern's
# encrypted credential store: credentials are injected into the browser and never
# sent to the LLM. Create the credential once, then reference its id on the task
# instead of putting secrets in the prompt. See:
# https://www.skyvern.com/docs/credentials