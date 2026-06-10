"""The data-extraction schema handed to Skyvern for every portal task.

Field DESCRIPTIONS do the heavy lifting — the agent reads them. They encode
the extraction rules of CLAUDE.md §5 (year semantics, '$0.00 banner is not
proof', payments-table priority, roll types) so any portal layout resolves
into the same shape. The engine then maps `bills[]` onto the canonical §3
record per target year.
"""

from __future__ import annotations

from typing import Any

MONEY = ["number", "string", "null"]

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
                "How the task ended. 'account_found' ONLY if a property "
                "detail/bill page matching the target was opened and read. "
                "'landed_on_search' if the given URL did not show the "
                "property (redirected to a search page, error, or a "
                "DIFFERENT parcel than requested). "
                "'ambiguous_multiple_matches' if several candidate parcels "
                "matched and the right one was unclear. 'no_matching_"
                "property' if searching returned nothing usable. "
                "'login_required' if an account login wall blocks the data. "
                "'blocked' for CAPTCHA/WAF/access denied that could not be "
                "passed. 'pdf_only' if amounts exist only inside a "
                "downloadable PDF/TIF document. 'error' for anything else."
            ),
        },
        "page_type_observed": {
            "type": "string",
            "enum": [
                "account_detail", "search_form", "results_list", "disclaimer",
                "year_selector", "pdf_document", "blocked", "other",
            ],
            "description": "The kind of page the run ENDED on.",
        },
        "vendor_footer": {
            "type": ["string", "null"],
            "description": (
                "Platform/vendor credit if visible (footer text like "
                "'Powered by Grant Street Group', '© Aumentum Technologies', "
                "'Pacific Blue Software', 'Tyler Technologies', 'Schneider "
                "Geospatial', 'DEVNET'…), else null."
            ),
        },
        "owner_on_page": {
            "type": ["string", "null"],
            "description": "Owner of record shown on the opened detail page.",
        },
        "situs_address_on_page": {
            "type": ["string", "null"],
            "description": (
                "The situs/physical property address on the detail page (NOT "
                "the owner's mailing address if they differ)."
            ),
        },
        "parcel_or_account_on_page": {
            "type": ["string", "null"],
            "description": (
                "The parcel number / account number / folio / property "
                "control number shown on the opened detail page."
            ),
        },
        "roll_type_on_page": {
            "type": ["string", "null"],
            "enum": ["real_estate", "tangible", "business", "unknown", None],
            "description": (
                "Roll/account type of the record that was opened: real "
                "estate/secured vs tangible personal property/unsecured vs "
                "business. Same address can have BOTH types — report which "
                "one this record is."
            ),
        },
        "assessed_value": {
            "type": MONEY,
            "description": "Assessed value if displayed, as a plain number.",
        },
        "page_timestamp": {
            "type": ["string", "null"],
            "description": "Any 'last updated' / 'as of' timestamp shown.",
        },
        "final_url": {
            "type": ["string", "null"],
            "description": "URL of the page the data was actually read from.",
        },
        "bills": {
            "type": "array",
            "description": (
                "One entry PER TAX YEAR visible for this property: the "
                "target year AND any earlier year that still shows a "
                "balance. IMPORTANT: before filling this, EXPAND collapsed "
                "sections — 'Recently Paid Bills' (+ toggles), payment "
                "history tables, per-year bill lists. A '$0.00 due' or "
                "'Total Payable: $0.00' banner alone is NOT payment proof; "
                "the proof (amount, date, receipt) is usually inside those "
                "sections. When a dense bill page shows many numbers: the "
                "PAYMENTS table (posted date, receipt, paid-by, amount) is "
                "ground truth; TOTAL/GROSS is the amount billed; ignore "
                "per-authority millage lines (they sum into gross)."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "year_label": {
                        "type": "string",
                        "description": (
                            "The year exactly as the portal labels it "
                            "('2025', '2025-26', '2025/2026')."
                        ),
                    },
                    "status_text": {
                        "type": ["string", "null"],
                        "description": (
                            "Status exactly as shown ('PAID', 'Unpaid', "
                            "'Delinquent', 'Open', 'Redeemed'…)."
                        ),
                    },
                    "amount_billed": {
                        "type": MONEY,
                        "description": (
                            "Gross/total billed for the year (TOTAL/GROSS), "
                            "plain number."
                        ),
                    },
                    "amount_paid": {
                        "type": MONEY,
                        "description": (
                            "What was actually paid. May legitimately be a "
                            "few percent BELOW billed (early-payment "
                            "discounts) — copy what the page shows, plain "
                            "number."
                        ),
                    },
                    "amount_due": {
                        "type": MONEY,
                        "description": (
                            "Live balance still owed NOW for this year "
                            "including penalties/interest; 0 if fully paid. "
                            "Plain number."
                        ),
                    },
                    "date_paid": {
                        "type": ["string", "null"],
                        "description": "Payment posted date as shown.",
                    },
                    "receipt": {
                        "type": ["string", "null"],
                        "description": "Receipt/confirmation number if shown.",
                    },
                    "paid_by": {
                        "type": ["string", "null"],
                        "description": "Payer name if shown.",
                    },
                    "next_due_date": {
                        "type": ["string", "null"],
                        "description": (
                            "Next installment/delinquency deadline if the "
                            "year is not fully paid."
                        ),
                    },
                },
                "required": ["year_label"],
            },
        },
        "candidate_matches": {
            "type": "array",
            "description": (
                "Only when multiple parcels matched the search: one entry per "
                "candidate so the caller can disambiguate."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "address": {"type": ["string", "null"]},
                    "owner": {"type": ["string", "null"]},
                    "parcel_id": {"type": ["string", "null"]},
                },
            },
        },
        "notes": {
            "type": ["string", "null"],
            "description": (
                "Anything unusual worth flagging (refund rows, 'seller name "
                "still on record', certificate sold, bankruptcy flag…)."
            ),
        },
    },
    "required": ["page_outcome", "bills"],
}
