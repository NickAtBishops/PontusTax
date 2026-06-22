"""The data-extraction schema handed to Skyvern for every portal task.

Primary answer remains amount_due_now (the total still owed right now).
A small set of structured payment fields layer on top for analyst-facing
clarity: ultimate_payment_due (after-discount/after-penalty final figure),
payment_date / payment_amount (most recent posted payment), and due_dates
(remaining installment deadlines). All payment fields are optional and
nullable; only page_outcome and amount_due_now are required.

Identity fields (owner / situs / parcel) are still here to verify the
right property was read (§6).
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
        "ultimate_payment_due": {
            "type": ["number", "string", "null"],
            "description": (
                "The final amount actually due on the bill after any current "
                "early-payment discount AND any past-due penalties/interest "
                "— the 'final answer' the portal shows. Often equal to "
                "amount_due_now; differs when a discount window is active "
                "(e.g. FL November pay-by-month tiers). Null if the bill is "
                "fully paid and no balance remains."
            ),
        },
        "payment_date": {
            "type": ["string", "null"],
            "description": (
                "Most recent payment posted date for this bill, ISO "
                "yyyy-mm-dd preferred. Null if no payment is shown."
            ),
        },
        "payment_amount": {
            "type": ["number", "string", "null"],
            "description": (
                "Amount of the most recent payment posted for this bill. "
                "Null if no payment is shown."
            ),
        },
        "due_dates": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Remaining installment due dates for this tax year (ISO "
                "yyyy-mm-dd). Multiple entries when the jurisdiction has "
                "multiple installments. Empty array when fully paid or no "
                "future deadlines remain."
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
