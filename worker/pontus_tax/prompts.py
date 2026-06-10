"""Skyvern prompt builders — one parameterized workflow per taxonomy type
(CLAUDE.md §4 + hard rules §11). Never a bespoke script per property.

Every prompt is assembled from the same blocks: objective, target identity,
the type-specific navigation path, jurisdiction-aware reading rules (§5),
vendor playbook hints (§8), hard read-only guardrails, completion criteria.
"""

from __future__ import annotations

from dataclasses import dataclass

from .playbooks import Playbook
from .taxonomy import TYPE_A, TYPE_B, TYPE_C, TYPE_D


@dataclass
class PromptContext:
    url: str
    address: str            # full "street, city, ST zip"
    county: str | None
    state: str | None
    owner_entity: str | None
    target_year: str | None
    roll_type: str          # "real_estate" | "tangible" | "business"
    search_label: str       # what we're searching by THIS attempt
    search_value: str
    other_candidates: list[str]
    playbook: Playbook | None
    multi_account_note: str | None = None


def _target_block(ctx: PromptContext) -> str:
    lines = [
        "TARGET PROPERTY",
        f"  Address          : {ctx.address or '(not provided)'}",
    ]
    if ctx.county:
        lines.append(f"  County           : {ctx.county}{f', {ctx.state}' if ctx.state else ''}")
    if ctx.owner_entity:
        lines.append(f"  Owner entity     : {ctx.owner_entity} (county records may "
                     "show a mangled spelling, or the previous owner if recently sold)")
    lines.append(f"  This attempt uses: {ctx.search_label} = \"{ctx.search_value}\"")
    if ctx.other_candidates:
        lines.append(
            "  Same id, other formats the portal might accept: "
            + ", ".join(f'"{c}"' for c in ctx.other_candidates[:4])
        )
    roll = ctx.roll_type.replace("_", " ")
    lines.append(
        f"  Roll/account type: {roll} — real estate/secured vs tangible "
        "personal property vs business are DIFFERENT accounts; the same "
        "address can have both. Open the record of this type only."
    )
    return "\n".join(lines)


def _year_block(ctx: PromptContext) -> str:
    if ctx.target_year:
        return (
            "WHICH TAX YEAR\n"
            f"- The target year is {ctx.target_year}. Portals label years "
            f"differently — treat '{ctx.target_year}', "
            f"'{ctx.target_year}-{str(int(ctx.target_year) + 1)[-2:] if ctx.target_year.isdigit() else '…'}' "
            f"and '{ctx.target_year}/{int(ctx.target_year) + 1 if ctx.target_year.isdigit() else '…'}' "
            "as the same year. NEVER just grab the top/newest row.\n"
            "- Also report any EARLIER year that still shows a balance.\n"
            "- If a year selector exists, make sure the displayed year matches "
            "the target before reading."
        )
    return (
        "WHICH TAX YEAR\n"
        "- No target year was given: read the most recent ISSUED annual bill "
        "(state its year label exactly), plus any earlier year that still "
        "shows a balance."
    )


def _reading_block() -> str:
    return (
        "HOW TO READ THE BILL PAGE\n"
        "- EXPAND collapsed sections first: 'Recently Paid Bills' (+), "
        "payment history, per-year bill lists. A 'Total Payable: $0.00' or "
        "'$0 due' banner is NOT proof of payment — the proof (amount paid, "
        "date, receipt number, payer) lives inside those sections.\n"
        "- Dense pages: the PAYMENTS table is ground truth; TOTAL/GROSS is "
        "the amount billed; per-authority and millage lines are noise.\n"
        "- Paid being slightly below billed is normal (early-payment "
        "discounts); copy the numbers exactly as shown, do not 'correct' them.\n"
        "- If the account is delinquent, the live amount due (with penalties "
        "and interest) is the number that matters; also note any 'certificate "
        "sold' or similar flags in notes."
    )


def _hard_rules() -> str:
    return (
        "HARD RULES — never break these\n"
        "- READ-ONLY. These are payment sites. NEVER click 'Add to Cart', "
        "'Pay', 'Pay Now', 'Check Out', 'Enroll', 'Sign up', or enter any "
        "payment, bank, or card information.\n"
        "- Never create an account, never log in to a payment account, never "
        "enroll in installment plans or e-billing.\n"
        "- Never falsely affirm eligibility gates (e.g. 'I am a government "
        "employee'). Plain 'I agree to the site terms / disclaimer' pages for "
        "read-only browsing ARE fine to accept.\n"
        "- Stay in English if a language toggle is offered.\n"
        "- Do NOT guess. If you cannot find the matching property or its "
        "figures, set page_outcome accordingly and leave fields null.\n"
        "- Verification: the opened record must match the target (owner "
        "contains the entity name or 'PONTUS', or the situs address/parcel "
        "matches). If the page shows a clearly different property, report "
        "landed_on_search or no_matching_property — do not extract from it."
    )


def _search_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — search portal\n"
        f"1. You are on (or will land on) a property-tax search page for "
        f"{ctx.county or 'the'} county.\n"
        f"2. Search by the {ctx.search_label}: type \"{ctx.search_value}\" "
        "into the matching search box (account/parcel boxes beat address "
        "boxes; strip any '#'). Submit and WAIT for results to load fully.\n"
        "3. If a results LIST appears, open the row matching the target: "
        "exact account/parcel match first, else exact street address, else "
        "owner containing the entity name. If several rows could match and "
        "none is clearly right, report ambiguous_multiple_matches with the "
        "candidates.\n"
        "4. On the property's detail/bill page, read the data per the rules "
        "below."
    )


def _direct_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — direct account link\n"
        "1. The URL should land DIRECTLY on the target property's account/"
        "bill page (deep link).\n"
        "2. First verify it: the owner, situs address, or parcel/account on "
        "the page must match the target. Tokens go stale — if the link "
        "errors, redirects to a search page, or shows a DIFFERENT parcel, "
        "report page_outcome=landed_on_search (do not search yourself unless "
        "a search box is right there and one search reaches the right "
        f"record using {ctx.search_label} \"{ctx.search_value}\").\n"
        "3. Once verified, read the data per the rules below."
    )


def _multistep_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — multi-step flow\n"
        "1. This portal fronts its search with extra steps: a disclaimer/"
        "terms page ('I agree' is fine to accept for read-only browsing), "
        "and/or a roll-type choice (real estate vs tangible vs business).\n"
        f"2. Choose the {ctx.roll_type.replace('_', ' ')} roll when asked.\n"
        + _search_path(ctx).split("\n", 1)[1]
    )


def _year_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — year-pinned portal\n"
        "1. The URL pins a tax year (e.g. y=2025) or the site opens on a "
        "year selector. CONFIRM the displayed year equals the target year; "
        "if not, use the selector/URL to switch to it.\n"
        "2. Then verify the property (owner / situs address / parcel must "
        "match the target) and read the data per the rules below. If the "
        "page shows a different property or only a search box, report "
        "landed_on_search."
    )


_PATHS = {
    TYPE_A: _direct_path,
    TYPE_B: _search_path,
    TYPE_C: _multistep_path,
    TYPE_D: _year_path,
}


def build_prompt(taxonomy_type: str, ctx: PromptContext) -> str:
    path_builder = _PATHS.get(taxonomy_type, _search_path)
    playbook_block = ""
    if ctx.playbook is not None and ctx.playbook.hints:
        playbook_block = (
            f"\nKNOWN PLATFORM — {ctx.playbook.vendor_name}\n"
            f"{ctx.playbook.hints}\n"
        )
    multi_note = f"\nNOTE: {ctx.multi_account_note}\n" if ctx.multi_account_note else ""

    return f"""\
OBJECTIVE
You are reading a county property-tax portal to determine the CURRENT tax
status of one property: paid or owed, the amounts, dates, and receipt
numbers — for the target tax year and any earlier year still owing.

{_target_block(ctx)}
{multi_note}
{path_builder(ctx)}

{_year_block(ctx)}

{_reading_block()}
{playbook_block}
{_hard_rules()}

COMPLETION
You are done when you have either (a) opened the matching property page and
filled the extraction schema from it — including bills[] for the target year
and any earlier year with a balance, the owner/situs/parcel shown, the roll
type, any vendor footer credit, and the final page URL — or (b) determined
that you cannot (then set page_outcome to the precise reason and fill what
you saw, e.g. candidate_matches). Copy values exactly as displayed; a fully
paid account with $0 due is a normal, correct result.
"""
