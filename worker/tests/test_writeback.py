import datetime as dt

from openpyxl import load_workbook

from pontus_tax.canonical import DELINQUENT, NEEDS_REVIEW, PAID, HIGH, LOW, MEDIUM, RowOutcome
from pontus_tax.intake import parse_workbook
from pontus_tax.writeback import output_filename, write_output

RUN_DATE = dt.date(2026, 6, 9)


def _outcomes():
    return {
        "s00_r0003": RowOutcome(
            row_key="s00_r0003", sheet_name="Florida Prop Tax", row_number=3,
            row_status=PAID, confidence=HIGH,
            status_note=(
                "Paid in full $4,974.48 on 12/29/2025 "
                "(Receipt N12292025P015431, paid by Robert Machin Jr)"
            ),
            write_date_paid="12/29/2025",
            write_receipt="N12292025P015431",
        ),
        "s00_r0004": RowOutcome(
            row_key="s00_r0004", sheet_name="Florida Prop Tax", row_number=4,
            row_status=NEEDS_REVIEW, confidence=LOW,
            status_note="NEEDS REVIEW — account not found",
            write_receipt="SHOULD-NOT-BE-WRITTEN",
        ),
        "s00_r0005": RowOutcome(
            row_key="s00_r0005", sheet_name="Florida Prop Tax", row_number=5,
            row_status=DELINQUENT, confidence=MEDIUM,
            status_note="DELINQUENT — $123,456.78 owed as of 6/9/2026",
            write_amount_due=123456.78,
            write_receipt="XYZ-OVERWRITE-ATTEMPT",
        ),
    }


def test_writeback_protections_and_new_column(florida_workbook, tmp_path):
    with open(florida_workbook, "rb") as fh:
        original_bytes = fh.read()

    intake = parse_workbook(florida_workbook)
    out_path = str(tmp_path / output_filename("Property Taxes- Florida.xlsx", RUN_DATE))
    headers = write_output(intake, _outcomes(), RUN_DATE, out_path)

    # §10.4 — the original upload is never modified
    with open(florida_workbook, "rb") as fh:
        assert fh.read() == original_bytes
    assert out_path.endswith("Property Taxes- Florida — checked 2026-06-09.xlsx")
    assert headers["Florida Prop Tax"]["amount"] == "Amount Due — June 2026"
    assert headers["Florida Prop Tax"]["status"] == "June 2026 Update"

    ws = load_workbook(out_path)["Florida Prop Tax"]

    # Two new columns after Website (W=23): X=Amount Due, Y=status note
    assert ws["X2"].value == "Amount Due — June 2026"
    assert ws["Y2"].value == "June 2026 Update"
    assert ws["Y3"].value.startswith("Paid in full $4,974.48")
    assert ws["Y4"].value == "NEEDS REVIEW — account not found"
    assert ws["Y5"].value.startswith("DELINQUENT")

    # Amount Due column: $0.00 for verified paid, the live owed figure for
    # delinquent, BLANK for unverified rows (never invented)
    assert ws["X3"].value == 0.0
    assert ws["X4"].value is None
    assert ws["X5"].value == 123456.78

    # Verified payment details written into their canonical columns
    assert ws["R3"].value == dt.datetime(2025, 12, 29)
    assert ws["S3"].value == "N12292025P015431"

    # LOW/NEEDS_REVIEW results never reach data cells (§7)
    assert ws["S4"].value is None

    # No silent erasure: existing receipt survives a conflicting scrape
    assert ws["S5"].value == "KEEP-ME-123"

    # Formulas everywhere are untouched
    assert ws["Q3"].value == "=N3+O3"
    assert ws["N6"].value == "=SUM(N3:N5)"

    # Live owed amount NOT written into installment grids (multiple amount
    # columns) — it rides the status note instead
    assert ws["N5"].value == 120802.06


def test_unprocessed_rows_are_marked_not_skipped(florida_workbook, tmp_path):
    intake = parse_workbook(florida_workbook)
    outcomes = _outcomes()
    del outcomes["s00_r0005"]  # pretend the run died before row 5
    out_path = str(tmp_path / "out.xlsx")
    write_output(intake, outcomes, RUN_DATE, out_path)
    ws = load_workbook(out_path)["Florida Prop Tax"]
    assert ws["Y5"].value == "NOT CHECKED — run ended before this row"
    assert ws["X5"].value is None  # unknown — never invented
