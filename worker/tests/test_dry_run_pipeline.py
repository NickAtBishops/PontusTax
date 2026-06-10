"""End-to-end through the real orchestrator with --dry-run semantics:
intake → per-row loop → write-back → summary, no portals contacted."""

import asyncio
import glob
import os

from openpyxl import load_workbook

from pontus_tax.config import Config
from pontus_tax.orchestrator import execute_run
from pontus_tax.store import LocalStore


def test_dry_run_full_pipeline(florida_workbook):
    store = LocalStore(florida_workbook)
    cfg = Config()
    summary = asyncio.run(execute_run(store, cfg, dry_run=True))

    assert summary["status_counts"] == {"NEEDS_REVIEW": 3}
    assert summary["status_column_header"].endswith("Update")
    assert summary["amount_column_header"].startswith("Amount Due")
    assert len(summary["review_rows"]) == 3

    out_dir = os.path.dirname(store.output_local)
    outputs = glob.glob(os.path.join(out_dir, "* — checked *.xlsx"))
    assert outputs, "checked workbook must be produced even on a dry run"
    ws = load_workbook(outputs[0])["Florida Prop Tax"]
    for row in (3, 4, 5):
        assert "dry run" in str(ws.cell(row=row, column=25).value)
        assert ws.cell(row=row, column=24).value is None  # nothing invented

    summaries = glob.glob(
        os.path.join(os.path.dirname(florida_workbook), "* — summary *.json")
    )
    assert summaries, "run summary JSON must be written in local mode"
