import datetime as dt

from pontus_tax.intake import parse_workbook, status_column_header


def test_header_detection_two_stacked_rows(florida_workbook):
    intake = parse_workbook(florida_workbook)
    assert len(intake.sheets) == 1
    sheet = intake.sheets[0]
    assert sheet.header_row == 2
    assert sheet.group_row == 1


def test_column_mapping_by_header_not_letter(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    m = sheet.mapping_doc()
    assert m["address"] == "A"
    assert m["city"] == "B"
    assert m["state"] == "C"
    assert m["zip"] == "D"
    assert m["county"] == "E"
    assert m["owner_entity"] == "F"
    assert m["internal_id"] == "G"      # PID is Pontus-internal, NOT the parcel
    assert m["account_number"] == "H"   # the real search key
    assert m["tax_year"] == "I"
    assert m["installments"] == "J"
    assert m["date_paid"] == "R"
    assert m["confirmation"] == "S"
    assert m["responsible_party"] == "T"
    assert m["website"] == "W"
    assert m["total"] == "Q"
    assert set(m["status_notes"].split(",")) == {"U", "V"}


def test_numbered_columns_typed_by_data(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    m = sheet.mapping_doc()
    # K/L hold dates, M is an (empty) date-group column; N/O/P hold numbers
    assert "K" in m["due_dates"] and "L" in m["due_dates"]
    assert "N" in m["amounts"] and "O" in m["amounts"]
    assert "K" not in m["amounts"]


def test_formula_total_column_protected_but_not_sum_row_columns(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    # Q has a formula in EVERY data row → protected.
    assert "Q" in sheet.protected_columns
    # N/O carry one SUM in the totals row only — per-cell guards handle that;
    # the columns themselves stay writable.
    assert "N" not in sheet.protected_columns
    assert "O" not in sheet.protected_columns


def test_data_rows_exclude_totals_row(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    assert [r.row_number for r in sheet.rows] == [3, 4, 5]


def test_url_from_hyperlink_and_multi_account_cell(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    rows = {r.row_number: r for r in sheet.rows}
    assert rows[3].url.startswith("https://pbctax.publicaccessnow.com/")
    assert rows[4].url == "https://pinellas.county-taxes.net/public"
    assert rows[5].url is None
    assert [g.display for g in rows[4].accounts] == [
        "T815151", "T813795", "R444958",
    ]
    assert rows[3].tax_year == "2025"
    assert rows[5].confirmation_existing == "KEEP-ME-123"


def test_status_column_follows_workbook_pattern(florida_workbook):
    sheet = parse_workbook(florida_workbook).sheets[0]
    assert sheet.update_columns, "April/May 2026 Update columns should be detected"
    assert status_column_header(sheet, dt.date(2026, 6, 9)) == "June 2026 Update"
