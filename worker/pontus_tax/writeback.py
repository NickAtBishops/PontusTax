"""Write-back — CLAUDE.md §10.

openpyxl, preserving structure: formatting, widths, merged headers,
hyperlinks, formulas. Writes ONLY into detected canonical columns plus one
NEW status column named after the workbook's own pattern. Formula cells are
never touched; a scraped blank/zero never erases a real value; no row is
silently skipped. The original upload is never modified — output is a copy.
"""

from __future__ import annotations

import datetime as dt
import logging
from copy import copy
from typing import Any

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .canonical import NEEDS_REVIEW, PAID, UNREACHABLE, LOW, RowOutcome
from .intake import (
    SheetIntake, WorkbookIntake, amount_column_header, status_column_header,
)
from .validate import parse_date, parse_money

log = logging.getLogger("pontus_tax.writeback")

# Statuses whose data values are allowed into data cells (§7: LOW/NEEDS_REVIEW
# results reach the status column only).
_WRITABLE_STATUSES_EXCLUDED = {NEEDS_REVIEW, UNREACHABLE}


def _is_formula(cell) -> bool:
    return cell.data_type == "f" or (
        isinstance(cell.value, str) and str(cell.value).startswith("=")
    )


def _cell_empty(cell) -> bool:
    v = cell.value
    return v is None or (isinstance(v, str) and not v.strip())


def _values_equalish(existing: Any, new: Any) -> bool:
    if existing is None or new is None:
        return False
    e_money, n_money = parse_money(existing), parse_money(new)
    if e_money is not None and n_money is not None:
        return abs(e_money - n_money) < 0.01
    e_date, n_date = parse_date(existing), parse_date(new)
    if e_date is not None and n_date is not None:
        return e_date == n_date
    return str(existing).strip().lower() == str(new).strip().lower()


def _safe_write(ws, row: int, col: int, value: Any, number_format: str | None = None) -> bool:
    """One gate for every data-cell write: never a formula cell, never erase,
    never fight an existing different value (corrections ride the status
    column instead). Returns True when the cell was written."""
    cell = ws.cell(row=row, column=col)
    if _is_formula(cell):
        return False
    if value is None or (isinstance(value, str) and not value.strip()):
        return False  # §7 no silent erasure — blanks never overwrite
    if not _cell_empty(cell):
        return _values_equalish(cell.value, value)  # already right → fine
    cell.value = value
    if number_format:
        cell.number_format = number_format
    return True


def _column_number_format(ws, col: int, data_start: int, data_end: int) -> str | None:
    for r in range(data_start, min(data_end, data_start + 40) + 1):
        cell = ws.cell(row=r, column=col)
        if cell.value is not None and cell.number_format != "General":
            return cell.number_format
    return None


def _last_used_column(ws, sheet: SheetIntake) -> int:
    last = 0
    rows_to_scan = [sheet.header_row]
    if sheet.group_row:
        rows_to_scan.append(sheet.group_row)
    rows_to_scan += [r.row_number for r in sheet.rows[:3]]
    for r in rows_to_scan:
        for c in range(ws.max_column, 0, -1):
            if ws.cell(row=r, column=c).value is not None:
                last = max(last, c)
                break
    return last or ws.max_column


def write_output(
    intake: WorkbookIntake,
    outcomes: dict[str, RowOutcome],
    run_date: dt.date,
    out_path: str,
) -> dict[str, dict[str, str]]:
    """Produce the checked copy. Returns
    {sheet_name: {"amount": <amount due header>, "status": <status header>}}."""
    wb = load_workbook(intake.path, data_only=False)
    headers_added: dict[str, dict[str, str]] = {}

    for s_idx, sheet in enumerate(intake.sheets):
        ws = wb[sheet.name]
        data_rows = [r.row_number for r in sheet.rows]
        data_start, data_end = min(data_rows), max(data_rows)

        # ---- TWO new columns (§10.2): live Amount Due, then the status
        # note named after the workbook's own pattern --------------------
        amount_col = _last_used_column(ws, sheet) + 1
        status_col = amount_col + 1
        amount_header = amount_column_header(sheet, run_date)
        status_header = status_column_header(sheet, run_date)
        headers_added[sheet.name] = {
            "amount": amount_header,
            "status": status_header,
        }

        def _style_header(col: int, text: str, width: float) -> None:
            cell = ws.cell(row=sheet.header_row, column=col)
            cell.value = text
            if sheet.update_columns:
                pattern_col = sheet.update_columns[-1]
                src = ws.cell(row=sheet.header_row, column=pattern_col.index)
                cell.font = copy(src.font)
                cell.fill = copy(src.fill)
                cell.border = copy(src.border)
                cell.alignment = copy(src.alignment)
                src_width = ws.column_dimensions[pattern_col.letter].width
                if src_width and width > 30:
                    width = src_width
            ws.column_dimensions[get_column_letter(col)].width = width

        _style_header(amount_col, amount_header, 16)
        _style_header(status_col, status_header, 52)

        date_info = sheet.first_col("date_paid")
        conf_info = sheet.first_col("confirmation")
        assessed_info = sheet.first_col("assessed_value")
        amount_cols = sheet.columns.get("amounts", [])
        date_fmt = (
            _column_number_format(ws, date_info.index, data_start, data_end)
            if date_info
            else None
        ) or "MM/DD/YYYY"

        for row in sheet.rows:
            key = f"s{s_idx:02d}_r{row.row_number:04d}"
            outcome = outcomes.get(key)
            note_cell = ws.cell(row=row.row_number, column=status_col)
            if outcome is None:
                # §10.3 — no row is ever silently skipped.
                note_cell.value = "NOT CHECKED — run ended before this row"
                continue
            note_cell.value = outcome.status_note or "NOT CHECKED"
            note_cell.alignment = copy(note_cell.alignment)

            allowed = (
                outcome.row_status not in _WRITABLE_STATUSES_EXCLUDED
                and outcome.confidence != LOW
            )

            # ---- the dedicated Amount Due column ------------------------
            # $0.00 = verified paid in full; the live owed total for open/
            # delinquent rows; BLANK when unverified (never invented).
            due_value: float | None = None
            if allowed:
                if outcome.row_status == PAID:
                    due_value = 0.0
                elif outcome.write_amount_due is not None:
                    due_value = outcome.write_amount_due
            if due_value is not None:
                due_cell = ws.cell(row=row.row_number, column=amount_col)
                due_cell.value = due_value
                due_cell.number_format = '"$"#,##0.00'

            if not allowed:
                continue

            if date_info and outcome.write_date_paid:
                d = parse_date(outcome.write_date_paid)
                if d:
                    _safe_write(ws, row.row_number, date_info.index, d, date_fmt)
            if conf_info and outcome.write_receipt:
                _safe_write(ws, row.row_number, conf_info.index, outcome.write_receipt)
            if assessed_info and outcome.write_assessed_value is not None:
                _safe_write(
                    ws, row.row_number, assessed_info.index,
                    outcome.write_assessed_value,
                )
            # Live amount owed goes into the amounts column ONLY when the
            # sheet has exactly one (installment grids stay untouched).
            if len(amount_cols) == 1 and outcome.write_amount_due is not None:
                _safe_write(
                    ws, row.row_number, amount_cols[0].index,
                    outcome.write_amount_due,
                )

    wb.save(out_path)
    log.info("wrote checked workbook: %s", out_path)
    return headers_added


def output_filename(input_name: str, run_date: dt.date) -> str:
    stem, dot, ext = input_name.rpartition(".")
    if not dot:
        stem, ext = input_name, "xlsx"
    return f"{stem} — checked {run_date.isoformat()}.{ext}"
