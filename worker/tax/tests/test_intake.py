import datetime as dt

from pontus_tax.intake import _match_field, parse_workbook, status_column_header


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
    assert [r.row_number for r in sheet.rows] == [3, 4, 5, 6]


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
    # Legacy Florida-style workbooks have month-update columns; the new
    # write-back model OVERWRITES the rightmost one every run instead of
    # appending a fresh per-run column.
    sheet = parse_workbook(florida_workbook).sheets[0]
    assert sheet.update_columns, "April/May 2026 Update columns should be detected"
    assert status_column_header(sheet) == "May 2026 Update"


def test_status_column_defaults_to_last_run_notes_on_fresh_template(
    ptax_master_workbook,
):
    # PTAX_Master has no month-update column → the writeback creates
    # 'Last run notes' once; the header function reports that name.
    sheet = parse_workbook(ptax_master_workbook).sheets[0]
    assert sheet.update_columns == []
    assert status_column_header(sheet) == "Last run notes"


# ---------------------------------------------------------------------------
# PTAX_Master template — fixed-cell layout (the new canonical workbook).
# ---------------------------------------------------------------------------


def test_ptax_master_header_detection(ptax_master_workbook):
    # README sheet has no detectable header row → skipped naturally.
    # Property Tax sheet (2026-06-25 reshuffle): row 2 is the System /
    # Pontus System Report / Model System Output band, row 3 is section
    # sub-labels (Location / Business Plan / Property Tax / Due Date),
    # row 4 is the field-header row, data starts at row 5. detect_header
    # picks row 4 (most field matches) and row 3 as the group row above it.
    intake = parse_workbook(ptax_master_workbook)
    assert [s.name for s in intake.sheets] == ["Property Tax"]
    sheet = intake.sheets[0]
    assert sheet.header_row == 4
    assert sheet.group_row == 3


def test_ptax_master_structured_field_mapping(ptax_master_workbook):
    # The three structured cells the checker writes to land at Y/Z/AB
    # under the "Model System Output" band. The two legacy cells
    # (ultimate_payment_due, next_due_date) were dropped from the
    # 2026-06-25 layout and are absent — first_col returns None.
    sheet = parse_workbook(ptax_master_workbook).sheets[0]
    assert sheet.first_col("payment_amount").letter == "Y"
    assert sheet.first_col("payment_date").letter == "Z"
    assert sheet.first_col("run_confidence").letter == "AB"
    assert sheet.first_col("ultimate_payment_due") is None
    assert sheet.first_col("next_due_date") is None


def test_ptax_master_original_tracker_columns_still_map(ptax_master_workbook):
    # The strict-header additions must not break the existing fuzzy mapping
    # for the A–R analyst-maintained columns the checker READS.
    m = parse_workbook(ptax_master_workbook).sheets[0].mapping_doc()
    assert m["address"] == "A"
    assert m["city"] == "B"
    assert m["state"] == "C"
    assert m["zip"] == "D"
    assert m["owner_entity"] == "E"
    assert m["internal_id"] == "F"     # PID
    assert m["account_number"] == "G"  # Account #
    assert m["installments"] == "H"
    assert m["confirmation"] == "N"
    assert m["responsible_party"] == "O"
    assert m["website"] == "R"
    # "Actual assessment" at AA fuzzy-matches the assessed_value bucket;
    # the writeback then refuses to touch it (it isn't in
    # _WRITABLE_FIELDS) — see test_writeback_guard_blocks_protected_columns.
    assert m["assessed_value"] == "AA"


def test_strict_match_beats_fuzzy_for_payment_amount():
    # "Payment amount" contains the word "amount" which the fuzzy table
    # would otherwise route to the loose `amounts` bucket. Strict wins.
    field, spec, tied = _match_field("Payment amount")
    assert field == "payment_amount"
    assert tied == []
    assert spec >= 1000


def test_strict_match_beats_fuzzy_for_next_due_date():
    # "Next due date" contains "due date" — the fuzzy table would otherwise
    # route to `due_dates`. Strict wins.
    field, _, tied = _match_field("Next due date")
    assert field == "next_due_date"
    assert tied == []


def test_strict_header_is_case_and_whitespace_tolerant():
    # Case + extra whitespace must still match strictly. Paraphrase must not.
    assert _match_field("ULTIMATE   PAYMENT  DUE")[0] == "ultimate_payment_due"
    assert _match_field("  Payment Date  ")[0] == "payment_date"
    # NOT tolerant of paraphrase — "Amount due now" should not become
    # ultimate_payment_due. (It falls through to a fuzzy match elsewhere
    # or returns None; here we just assert the strict path doesn't fire.)
    assert _match_field("Amount due now")[0] != "ultimate_payment_due"
