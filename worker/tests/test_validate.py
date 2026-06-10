import datetime as dt

from pontus_tax.canonical import (
    DELINQUENT, NEEDS_REVIEW, PAID, PARTIAL, UNPAID,
    HIGH, MEDIUM,
    aggregate_status,
)
from pontus_tax.validate import (
    build_account_record, build_row_note, choose_bill, parse_money,
    year_label_matches,
)
from pontus_tax.verify import MatchVerdict

TODAY = dt.date(2026, 6, 9)
VERDICT = MatchVerdict(True, "account + owner", owner_mismatch=False,
                       confidence_hint=HIGH)


def _extraction(bills, **over):
    base = {
        "page_outcome": "account_found",
        "owner_on_page": "PONTUS EHC PALM BEACH LLC",
        "situs_address_on_page": "950 EVERNIA ST",
        "parcel_or_account_on_page": "74-43-43-21-01-043-0050",
        "bills": bills,
        "final_url": "https://example.gov/acct",
    }
    base.update(over)
    return base


def test_money_and_year_labels():
    assert parse_money("$5,128.33") == 5128.33
    assert parse_money("(120.50)") == -120.50
    assert parse_money("n/a") is None
    assert year_label_matches("2025", "2025")
    assert year_label_matches("2025", "2025-26")
    assert year_label_matches("2025", "2025/2026")
    assert not year_label_matches("2025", "2024-2025")  # prior fiscal year


def test_choose_bill_never_grabs_top_row_blindly():
    bills = [{"year_label": "2026"}, {"year_label": "2025"}]
    bill, note = choose_bill(bills, "2025")
    assert bill["year_label"] == "2025" and note is None
    # target year not issued yet → newest reported, with a note (§5.1)
    bill, note = choose_bill([{"year_label": "2025"}], "2026")
    assert bill["year_label"] == "2025"
    assert "not issued" in note


def test_putnam_discount_is_normal_paid():
    # GROSS 5,128.33 paid 4,974.48 = 3% December discount (§5.2)
    rec, _ = build_account_record(
        "12345", _extraction([{
            "year_label": "2025", "status_text": "PAID",
            "amount_billed": 5128.33, "amount_paid": 4974.48,
            "amount_due": 0, "date_paid": "12/29/2025",
            "receipt": "N12292025P015431", "paid_by": "Robert Machin Jr",
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    assert rec.status == PAID
    assert rec.confidence == HIGH
    assert "discount" in rec.evidence


def test_paid_far_below_billed_needs_review():
    rec, _ = build_account_record(
        "12345", _extraction([{
            "year_label": "2025", "status_text": "PAID",
            "amount_billed": 1000.0, "amount_paid": 500.0, "amount_due": 0,
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    assert rec.status == NEEDS_REVIEW
    assert "below billed" in rec.evidence


def test_zero_banner_without_proof_is_medium():
    rec, _ = build_account_record(
        "12345", _extraction([{
            "year_label": "2025", "status_text": "Nothing owed",
            "amount_due": 0,
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    assert rec.status == PAID
    assert rec.confidence == MEDIUM
    assert "payment details unavailable" in rec.evidence


def test_delinquent_growth_flags_lower_live_amount():
    rec, _ = build_account_record(
        "504209AB0120", _extraction([{
            "year_label": "2025", "status_text": "DELINQUENT",
            "amount_due": 100000.0,
        }]),
        VERDICT, "2025", 120802.06, None, TODAY,
    )
    assert rec.status == DELINQUENT
    assert "LOWER than the sheet" in rec.evidence


def test_future_payment_date_dropped_and_sheet_corrected():
    rec, corrections = build_account_record(
        "12345", _extraction([{
            "year_label": "2025", "status_text": "PAID",
            "amount_billed": 1000.0, "amount_paid": 1000.0, "amount_due": 0,
            "date_paid": "11/13/2025", "receipt": "R1",
        }]),
        VERDICT, "2025", None, dt.datetime(2026, 11, 13), TODAY,
    )
    assert rec.date_paid == "11/13/2025"
    # the sheet's impossible 2026 date gets a correction note (§7)
    assert corrections == ["sheet said 11/13/2026; portal receipt shows 11/13/2025"]


def test_prior_year_balance_makes_row_delinquent():
    rec, _ = build_account_record(
        "12345", _extraction([
            {"year_label": "2025", "status_text": "PAID", "amount_due": 0,
             "amount_paid": 900.0, "amount_billed": 900.0, "date_paid": "12/01/2025"},
            {"year_label": "2024", "status_text": "DELINQUENT", "amount_due": 432.10},
        ]),
        VERDICT, "2025", None, None, TODAY,
    )
    assert rec.prior_year_balance is True
    assert rec.status == DELINQUENT
    assert "2024 owes $432.10" in rec.evidence


def test_partial_and_unpaid_statuses():
    # Current-year bills mid-cycle: installment splits are PARTIAL, not
    # delinquency (§5.2); a wholly open current bill is UNPAID.
    rec, _ = build_account_record(
        "1", _extraction([{
            "year_label": "2026", "amount_billed": 1000.0,
            "amount_paid": 400.0, "amount_due": 600.0,
        }]),
        VERDICT, "2026", None, None, TODAY,
    )
    assert rec.status == PARTIAL
    rec, _ = build_account_record(
        "1", _extraction([{
            "year_label": "2026", "amount_billed": 1000.0, "amount_due": 1000.0,
            "next_due_date": "12/10/2026",
        }]),
        VERDICT, "2026", None, None, TODAY,
    )
    assert rec.status == UNPAID
    # A PRIOR-year bill still owing is delinquent even if partially paid.
    rec, _ = build_account_record(
        "1", _extraction([{
            "year_label": "2025", "amount_billed": 1000.0,
            "amount_paid": 400.0, "amount_due": 600.0,
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    assert rec.status == DELINQUENT


def test_aggregation_rules():
    assert aggregate_status([PAID, PAID]) == PAID
    assert aggregate_status([PAID, UNPAID]) == UNPAID
    assert aggregate_status([UNPAID, DELINQUENT]) == DELINQUENT
    assert aggregate_status([PAID, NEEDS_REVIEW]) == NEEDS_REVIEW


def test_status_note_formats():
    rec, _ = build_account_record(
        "12345", _extraction([{
            "year_label": "2025", "status_text": "PAID",
            "amount_billed": 5128.33, "amount_paid": 4974.48, "amount_due": 0,
            "date_paid": "12/29/2025", "receipt": "N12292025P015431",
            "paid_by": "Robert Machin Jr",
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    note = build_row_note([rec], PAID, [], TODAY)
    assert note == (
        "Paid in full $4,974.48 on 12/29/2025 "
        "(Receipt N12292025P015431, paid by Robert Machin Jr)"
    )

    rec2, _ = build_account_record(
        "504209AB0120", _extraction([{
            "year_label": "2025", "status_text": "DELINQUENT",
            "amount_due": 123456.78,
        }]),
        VERDICT, "2025", None, None, TODAY,
    )
    note2 = build_row_note([rec2], DELINQUENT, [], TODAY)
    assert note2 == "DELINQUENT — $123,456.78 owed as of 6/9/2026"

    multi = build_row_note([rec, rec2], DELINQUENT,
                           ["sheet said X; portal shows Y"], TODAY)
    assert "12345:" in multi and "504209AB0120:" in multi
    assert multi.endswith("| NOTE: sheet said X; portal shows Y")
