"""The data-extraction schema handed to Skyvern for every portal task.

FAST MODE: one question per property — the total amount still owed RIGHT
NOW. No receipts, no payment history, no per-year tables. The only extra
fields are the identity fields needed to verify the right property was
read (§6) and the navigation outcome.
"""

from __future__ import annotations

from typing import Any

EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "page_outcome": {
            "type": "string",
            "enum": [
                "account_found",
                "landed_on_search",
                "ambiguous_multiple_matches",
                "no_matching_property",
                "login_required",
                "blocked",
                "pdf_only",
                "error",
            ],
            "description": (
                "How the task ended. 'account_found' ONLY if a page for the "
                "matching property was opened and read. 'landed_on_search' if "
                "the given URL did not show the property (redirected to a "
                "search page, error, or a DIFFERENT parcel). "
                "'ambiguous_multiple_matches' if several results matched and "
                "the right one was unclear. 'no_matching_property' if the "
                "search found nothing usable. 'login_required' / 'blocked' / "
                "'pdf_only' / 'error' as applicable."
            ),
        },
        "amount_due_now": {
            "type": ["number", "string", "null"],
            "description": (
                "THE ANSWER: the total property tax still owed RIGHT NOW for "
                "this property — all years combined, including any penalties, "
                "interest and fees. Copy the page's total figure (labels like "
                "'Total Amount Due', 'Total Payable', 'Balance Due', 'Amount "
                "Due'). 0 if everything is paid — that is a normal, correct "
                "answer. null ONLY if no due figure could be found at all."
            ),
        },
        "includes_delinquency": {
            "type": ["boolean", "null"],
            "description": (
                "true if any of the amount owed is past due (the page says "
                "delinquent, past due, prior year owed, certificate, etc.)."
            ),
        },
        "owner_on_page": {
            "type": ["string", "null"],
            "description": "Owner of record shown on the page that was read.",
        },
        "situs_address_on_page": {
            "type": ["string", "null"],
            "description": (
                "The property's physical/situs address shown on the page "
                "(not the owner's mailing address)."
            ),
        },
        "parcel_or_account_on_page": {
            "type": ["string", "null"],
            "description": (
                "The parcel/account/folio number shown on the page that was "
                "read."
            ),
        },
        "final_url": {
            "type": ["string", "null"],
            "description": "URL of the page the amount was read from.",
        },
    },
    "required": ["page_outcome", "amount_due_now"],
}
