import datetime as dt

from pontus_tax.canonical import (
    DELINQUENT, NEEDS_REVIEW, PAID, UNPAID,
    HIGH, LOW, MEDIUM,
    AccountRecord,
    aggregate_status,
)
from pontus_tax.validate import (
    build_account_record, build_row_note, parse_money,
)
from pontus_tax.verify import MatchVerdict

TODAY = dt.date(2026, 6, 9)
VERDICT = MatchVerdict(True, "account + owner", owner_mismatch=False,
                       confidence_hint=HIGH)


def _extraction(amount, delinquent=None):
    return {
        "page_outcome": "account_found",
        "amount_due_now": amount,
        "includes_delinquency": delinquent,
        "owner_on_page": "PONTUS EHC PALM BEACH LLC",
        "situs_address_on_page": "950 EVERNIA ST",
        "parcel_or_account_on_page": "74-43-43-21-01-043-0050",
        "final_url": "https://example.gov/acct",
    }


def test_money_parsing():
    assert parse_money("$5,128.33") == 5128.33
    assert parse_money("(120.50)") == -120.50
    assert parse_money(0) == 0.0
    assert parse_money("n/a") is None


def test_zero_due_is_paid():
    rec = build_account_record("12345", _extraction(0), VERDICT)
    assert rec.status == PAID
    assert rec.amount_due == 0.0
    assert rec.confidence == HIGH


def test_balance_is_unpaid_and_string_amounts_parse():
    rec = build_account_record("12345", _extraction("$4,974.48"), VERDICT)
    assert rec.status == UNPAID
    assert rec.amount_due == 4974.48


def test_delinquency_flag_marks_delinquent():
    rec = build_account_record("504209AB0120", _extraction(123456.78, True), VERDICT)
    assert rec.status == DELINQUENT
    assert rec.amount_due == 123456.78


def test_no_figure_needs_review_low_confidence():
    rec = build_account_record("12345", _extraction(None), VERDICT)
    assert rec.status == NEEDS_REVIEW
    assert rec.amount_due is None
    assert rec.confidence == LOW
    assert "no amount-due figure" in rec.evidence


def test_owner_mismatch_noted_in_evidence():
    verdict = MatchVerdict(True, "account + address", owner_mismatch=True,
                           confidence_hint=MEDIUM)
    rec = build_account_record("12345", _extraction(0), verdict)
    assert rec.status == PAID
    assert rec.confidence == MEDIUM
    assert "owner on page differs" in rec.evidence


def test_aggregation_rules():
    assert aggregate_status([PAID, PAID]) == PAID
    assert aggregate_status([PAID, UNPAID]) == UNPAID
    assert aggregate_status([UNPAID, DELINQUENT]) == DELINQUENT
    assert aggregate_status([PAID, NEEDS_REVIEW]) == NEEDS_REVIEW


def test_status_notes_short_form():
    paid = build_account_record("12345", _extraction(0), VERDICT)
    assert build_row_note([paid], PAID, TODAY) == "Paid — $0.00 due"

    owed = build_account_record("504209AB0120", _extraction(123456.78, True), VERDICT)
    assert build_row_note([owed], DELINQUENT, TODAY) == (
        "DELINQUENT — $123,456.78 owed as of 6/9/2026"
    )

    open_bill = build_account_record("999", _extraction(600), VERDICT)
    assert build_row_note([open_bill], UNPAID, TODAY) == (
        "OWES $600.00 as of 6/9/2026"
    )

    multi = build_row_note([paid, owed], DELINQUENT, TODAY)
    assert multi.startswith("$123,456.78 owed across 2 accounts")
    assert "12345: Paid — $0.00 due" in multi

    all_paid = build_row_note([paid, paid, paid], PAID, TODAY)
    assert all_paid == "All 3 accounts paid — $0.00 due"


def test_account_record_roundtrip_includes_new_fields():
    # New optional fields default safely and roundtrip through to_dict /
    # constructor without drift — store._outcome_doc relies on asdict for
    # Firestore serialization, so this guards against silent field loss.
    rec = AccountRecord(
        account_searched="74-43-43-21-01-043-0050",
        status=UNPAID,
        amount_due=4974.48,
        ultimate_payment_due=4974.48,
        date_paid="2025-12-29",
        amount_paid=4974.48,
        due_dates=["2026-03-31"],
    )
    d = rec.to_dict()

    # New fields present with the right values.
    assert d["ultimate_payment_due"] == 4974.48
    assert d["due_dates"] == ["2026-03-31"]
    # Existing-but-now-first-class fields untouched.
    assert d["date_paid"] == "2025-12-29"
    assert d["amount_paid"] == 4974.48

    # Defaults are safe.
    blank = AccountRecord(account_searched="x")
    blank_dict = blank.to_dict()
    assert blank_dict["ultimate_payment_due"] is None
    assert blank_dict["due_dates"] == []

    # Reconstructing from the serialized dict round-trips exactly.
    reborn = AccountRecord(**d)
    assert reborn.ultimate_payment_due == 4974.48
    assert reborn.due_dates == ["2026-03-31"]
    assert reborn == rec
