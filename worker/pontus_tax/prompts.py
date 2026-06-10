"""Skyvern prompt builders — one parameterized workflow per taxonomy type
(CLAUDE.md §4 + hard rules §11). FAST MODE: the agent answers exactly one
question — the total amount still owed now — and stops.
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
        lines.append(
            f"  County           : {ctx.county}"
            f"{f', {ctx.state}' if ctx.state else ''}"
        )
    if ctx.owner_entity:
        lines.append(
            f"  Owner entity     : {ctx.owner_entity} (county records may "
            "mangle the spelling, or still show the previous owner)"
        )
    lines.append(f"  This attempt uses: {ctx.search_label} = \"{ctx.search_value}\"")
    if ctx.other_candidates:
        lines.append(
            "  Same id, other formats: "
            + ", ".join(f'"{c}"' for c in ctx.other_candidates[:3])
        )
    if ctx.roll_type != "real_estate":
        lines.append(
            f"  Roll type        : {ctx.roll_type.replace('_', ' ')} — open "
            "the record of this type, not the real-estate one."
        )
    return "\n".join(lines)


def _hard_rules() -> str:
    return (
        "HARD RULES — never break these\n"
        "- READ-ONLY. These are payment sites. NEVER click 'Add to Cart', "
        "'Pay', 'Pay Now', 'Check Out', 'Enroll' or enter any payment, bank "
        "or card information. Never create accounts or log in to payment "
        "accounts. Never falsely affirm eligibility gates. Plain 'I agree' "
        "disclaimer pages for read-only browsing ARE fine to accept.\n"
        "- VERIFY before reading: the opened record must match the target "
        "(owner contains the entity name or 'PONTUS', or the address/parcel "
        "matches). A clearly different property → report landed_on_search or "
        "no_matching_property, do NOT extract from it.\n"
        "- Do NOT guess a number. No figure found → amount_due_now = null "
        "with the right page_outcome."
    )


def _speed_rule() -> str:
    return (
        "BE FAST\n"
        "- You need ONE number: the total still owed right now (all years "
        "combined, penalties included). Banners like 'Total Payable: $0.00' "
        "or 'Total Amount Due: $1,234.56' ARE the answer.\n"
        "- Do NOT open payment history, receipts, per-year bill details, or "
        "any collapsed sections. Stop as soon as the total due (and the "
        "owner/address/parcel for verification) is visible."
    )


def _search_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — search portal\n"
        f"1. Search by the {ctx.search_label}: type \"{ctx.search_value}\" "
        "into the matching box (account/parcel boxes beat address boxes; "
        "strip any '#'). Submit and wait for results.\n"
        "2. If a results list appears, open the row matching the target "
        "(account exact, else street address, else owner). Several plausible "
        "rows and none clearly right → ambiguous_multiple_matches.\n"
        "3. Read the total amount due from the property's page."
    )


def _direct_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — direct account link\n"
        "1. The URL should land DIRECTLY on the target property's page. "
        "Verify owner/address/parcel.\n"
        "2. If the link errors, redirects to a search page, or shows a "
        "different parcel → report landed_on_search (only search yourself if "
        f"a search box is right there — use {ctx.search_label} "
        f"\"{ctx.search_value}\").\n"
        "3. Read the total amount due."
    )


def _multistep_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — multi-step flow\n"
        "1. Accept the disclaimer/terms page if one fronts the search "
        "(read-only browsing).\n"
        f"2. Choose the {ctx.roll_type.replace('_', ' ')} roll if asked.\n"
        + _search_path(ctx).split("\n", 1)[1]
    )


def _year_path(ctx: PromptContext) -> str:
    return (
        "NAVIGATION — year-pinned portal\n"
        "1. The URL pins a tax year or opens on a year selector — that is "
        "fine; the answer is the CURRENT total still owed (the portal's "
        "total-due figure covers it).\n"
        "2. Verify the property (owner/address/parcel), then read the total "
        "amount due. Wrong property or only a search box → landed_on_search."
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
Read this county property-tax portal and find ONE number for the target
property: the TOTAL amount of property tax still owed right now ($0.00 if
everything is paid).

{_target_block(ctx)}
{multi_note}
{path_builder(ctx)}

{_speed_rule()}
{playbook_block}
{_hard_rules()}

COMPLETION
Fill the extraction schema: amount_due_now (the one number), whether any of
it is delinquent, the owner/situs/parcel shown (for verification), and the
final page URL — or the precise page_outcome for why you could not.
"""
