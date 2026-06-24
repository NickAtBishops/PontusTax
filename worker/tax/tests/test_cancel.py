"""On-the-spot cancel: when cancel is requested while rows are in flight,
the worker aborts the in-flight tasks immediately rather than waiting for
them to finish, then jumps straight to write-back."""

import asyncio

import pytest

from pontus_tax import orchestrator
from pontus_tax.config import Config
from pontus_tax.orchestrator import RowProcessor, execute_run
from pontus_tax.store import LocalStore


class _CancelingStore(LocalStore):
    """A LocalStore that reports cancel from the first poll and records the
    canceled flag write-back receives."""

    def __init__(self, xlsx_path):
        super().__init__(xlsx_path)
        self.finished_canceled = None

    def cancel_requested(self) -> bool:
        return True

    def finish(self, summary, output_path, output_file_name, failed, canceled):
        self.finished_canceled = canceled
        super().finish(summary, output_path, output_file_name, failed, canceled)


def test_cancel_aborts_in_flight_rows_fast(florida_workbook, monkeypatch):
    # A row "in flight" would take far longer than the test's patience.
    async def never_finishes(self, job):
        await asyncio.sleep(3600)

    monkeypatch.setattr(RowProcessor, "process", never_finishes)
    # Poll fast so the test doesn't wait the production 5s window.
    monkeypatch.setattr(orchestrator, "CANCEL_POLL_SECONDS", 0.01)

    store = _CancelingStore(florida_workbook)
    cfg = Config()

    async def run():
        # If cancel were cooperative (old behavior), this would hang on the
        # 3600s sleeps and time out. Instant cancel must finish in well under
        # the timeout.
        return await asyncio.wait_for(
            execute_run(store, cfg, dry_run=True), timeout=10
        )

    summary = asyncio.run(run())

    # Reached write-back, marked canceled, and invented no row outcomes.
    assert store.finished_canceled is True
    assert summary["status_counts"] == {}
    assert any("cancel" in n.lower() for n in summary["notes"])
