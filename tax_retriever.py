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
   the matched property actually corresponds to the requested address.
4. If Claude is not confident there was a match, retry the Skyvern task using a
   fallback search term (owner, then parcel id). Cap the number of attempts.

Target value
------------
"current amount due" = the live outstanding balance the owner must still pay
right now. Amounts already paid and historical receipts are ignored. If the
account is fully paid, the correct answer is 0.00.

Requirements
------------
    pip install skyvern anthropic

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
from dotenv import load_dotenv
load_dotenv()
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from anthropic import AsyncAnthropic
from skyvern import Skyvern
from skyvern.client.core.api_error import ApiError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tax_retriever")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

# Anthropic model used for the validation / normalization pass. Sonnet is a good
# cost/quality fit for this kind of structured judgment. Swap if you prefer.
# Current model strings: https://docs.claude.com/en/docs/about-claude/models
NORMALIZER_MODEL = "claude-opus-4-8"

# Skyvern agent engine. skyvern-2.0 is the default and handles multi-step
# navigate -> search -> select -> read flows well.
SKYVERN_ENGINE = "skyvern-2.0"

# Cap steps so a misbehaving site cannot run up cost. Raise if portals are deep.
MAX_STEPS = 25

# Route through a residential IP. Many production county portals sit behind WAFs
# that block datacenter IPs. The public demos work without it; set to None to
# disable, or to a country code per Skyvern's proxy docs.
PROXY_LOCATION: Optional[str] = "RESIDENTIAL"

# How many search terms to try before giving up (address, then fallbacks).
MAX_ATTEMPTS = 3

# Statuses Skyvern returns that mean the run will not produce more output.
TERMINAL_FAILURE = {"failed", "terminated", "timed_out", "canceled"}

# Backoff delays (seconds) for transient 5xx from Skyvern's cloud. The session
# endpoint occasionally returns 504 when their browser pool is warming. If all
# attempts fail we fall back to running each task without a shared session.
SESSION_CREATE_BACKOFFS = (2, 5, 10)


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

    def search_terms(self) -> list[tuple[str, str]]:
        """Ordered (label, value) search terms to try."""
        terms = [("property address", self.property_address)]
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
# canonical record AND decides whether the page actually matched the request. If
# it did not match, Claude signals a retry and suggests a better search term.
# --------------------------------------------------------------------------- #

NORMALIZER_SYSTEM = """\
You validate and normalize property-tax data scraped from county websites.
You are given (a) the property the user asked about and (b) the raw fields a
browser agent extracted from whatever page it ended up on.

Your job:
1. Decide whether the page the agent read actually corresponds to the requested
   property. Compare addresses leniently (abbreviations, suffixes, casing, unit
   formatting differ across sites) and use owner name / parcel id if present.
2. Parse the current amount due into a plain number (strip "$" and commas). A
   correctly read, fully-paid account is amount_due = 0.0 and matched = true.
3. If the page did NOT match, or no due figure was found, set needs_retry true
   and suggest the most useful next search term, if any.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "amount_due": <number or null>,
  "raw_amount_string": <string or null>,
  "currency": "USD",
  "amount_label": <string or null>,
  "as_of_date": <string or null>,
  "parcel_id": <string or null>,
  "property_address_on_page": <string or null>,
  "owner_on_page": <string or null>,
  "matched": <true|false>,
  "match_basis": <short string: what you matched on>,
  "confidence": <0.0-1.0>,
  "needs_retry": <true|false>,
  "suggested_search_term": <"owner name"|"parcel id"|null>,
  "reasoning": <one or two sentences>
}
"""


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
        messages=[{"role": "user", "content": json.dumps(user_payload, default=str)}],
    )

    text = "".join(block.text for block in resp.content if block.type == "text").strip()
    # Strip accidental code fences just in case.
    if text.startswith("```"):
        text = text.strip("`")
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("json"):
            text = text[:-4]
    return json.loads(text)


# --------------------------------------------------------------------------- #
# Skyvern task runner (one attempt)
# --------------------------------------------------------------------------- #

async def open_session_with_retry(skyvern: Skyvern) -> Optional[str]:
    """Try to provision a shared browser session, retrying transient 5xx.

    Returns the session id on success, or None if all attempts hit a 5xx (in
    which case the caller should fall back to running each task without a
    persistent session — Skyvern will provision an ephemeral browser per task).
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
) -> Any:
    prompt = build_prompt(p, search_label, search_value)
    log.info("Skyvern attempt: searching by %s = %r", search_label, search_value)

    task_kwargs: dict[str, Any] = dict(
        url=p.url,
        prompt=prompt,
        data_extraction_schema=EXTRACTION_SCHEMA,
        engine=SKYVERN_ENGINE,
        max_steps=MAX_STEPS,
        proxy_location=PROXY_LOCATION,
        # Classify common recoverable failures so retry logic can react.
        error_code_mapping={
            "no_property_found": "The search returned no matching property.",
            "session_blocked": "Session expired, CAPTCHA, WAF, or access denied.",
        },
        wait_for_completion=True,
    )
    if session_id is not None:
        task_kwargs["browser_session_id"] = session_id

    run = await skyvern.run_task(**task_kwargs)

    log.info("  -> status=%s", getattr(run, "status", "unknown"))
    if getattr(run, "status", None) in TERMINAL_FAILURE:
        return {
            "page_outcome": "error",
            "current_amount_due": None,
            "notes": f"Skyvern run ended with status={run.status}; "
                     f"reason={getattr(run, 'failure_reason', None)}",
        }
    return run.output


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

            raw = await run_skyvern_attempt(skyvern, p, session_id, label, value)
            result.raw_extract = raw
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
            result.page_outcome = (raw or {}).get("page_outcome") if isinstance(raw, dict) else None

            # Success: matched the right parcel and we have a numeric balance.
            if result.matched and result.amount_due is not None:
                result.success = True
                break

            # Decide whether to retry with the next fallback search term.
            if verdict.get("needs_retry"):
                suggested = (verdict.get("suggested_search_term") or "").lower()
                # Jump to the suggested term if we have it; else just go to the
                # next available fallback in order.
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
                f"{result.attempts} attempt(s). Last outcome: {result.page_outcome}."
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
# Example
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    # Palm Beach County example from the uploaded account page (fully paid -> 0.00).
    prop = PropertyInput(
        url="https://pbctax.publicaccessnow.com/PropertyTax/Account.aspx?p=74-43-43-21-01-043-0050&a=1418360",
        property_address="950 Evernia St	West Palm Beach	FL	33401	Palm Beach",
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
