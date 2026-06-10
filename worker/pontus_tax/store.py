"""Run persistence.

FirestoreStore — production: run/rows/events live under tax_checker_runs,
resume state in tax_checker_scrape_state (deterministic doc IDs, template
§12), files in GCS, playbook library in tax_checker_playbooks.

LocalStore — development: process one workbook on disk with no cloud at all
(`python main.py --local-xlsx …`). Same orchestrator either way.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import tempfile
from typing import Any, Protocol

from .canonical import (
    NEEDS_REVIEW, PAID, PARTIAL, UNPAID, DELINQUENT, UNREACHABLE,
    RowOutcome,
)
from .config import Config
from .intake import RowIntake, SheetIntake
from .playbooks import SEED_PLAYBOOKS, Playbook

log = logging.getLogger("pontus_tax.store")

JOB_NAME = "tax_check"

_COUNTER_BY_STATUS = {
    PAID: "paid",
    PARTIAL: "partial",
    UNPAID: "unpaid",
    DELINQUENT: "delinquent",
    NEEDS_REVIEW: "needs_review",
    UNREACHABLE: "unreachable",
}


def row_key(sheet_index: int, row_number: int) -> str:
    # zero-padded so Firestore documentId order == sheet/row order
    return f"s{sheet_index:02d}_r{row_number:04d}"


def row_input_doc(row: RowIntake) -> dict[str, Any]:
    return {
        "address": row.address,
        "city": row.city,
        "state": row.state,
        "zip": row.zip,
        "county": row.county,
        "owner_entity": row.owner_entity,
        "internal_id": row.internal_id,
        "account_raw": row.account_raw,
        "accounts": [a.display for a in row.accounts],
        "tax_year": row.tax_year,
        "url": row.url,
        "responsible_party": row.responsible_party,
    }


class RunStore(Protocol):
    run_id: str
    def claim_run(self) -> dict[str, Any]: ...
    def fetch_input(self) -> str: ...
    def save_intake(self, sheets: list[SheetIntake], planned: list[tuple[str, int, RowIntake, SheetIntake]]) -> None: ...
    def pending_keys(self, resume: bool) -> set[str]: ...
    def mark_in_progress(self, key: str) -> None: ...
    def save_outcome(self, key: str, outcome: RowOutcome) -> None: ...
    def mark_failed(self, key: str, error: str, outcome: RowOutcome) -> None: ...
    def cancel_requested(self) -> bool: ...
    def set_status(self, status: str) -> None: ...
    def collect_outcomes(self) -> dict[str, RowOutcome]: ...
    def put_output(self, local_path: str, file_name: str) -> str: ...
    def finish(self, summary: dict[str, Any], output_path: str | None, output_file_name: str | None, failed: bool, canceled: bool) -> None: ...
    def fail_run(self, error: str) -> None: ...
    def load_playbooks(self) -> list[Playbook]: ...
    def upsert_playbook(self, pb: Playbook) -> bool: ...
    def log_event(self, level: str, message: str, key: str | None = None) -> None: ...


# ===========================================================================
# Firestore
# ===========================================================================

class FirestoreStore:
    RUNS = "tax_checker_runs"
    PLAYBOOKS = "tax_checker_playbooks"
    SCRAPE_STATE = "tax_checker_scrape_state"

    def __init__(self, cfg: Config, run_id: str):
        self.cfg = cfg
        self.run_id = run_id
        self._db = None
        self._bucket = None
        self._tmpdir = tempfile.mkdtemp(prefix="taxchk_")
        self._run_cache: dict[str, Any] = {}

    # -- clients ----------------------------------------------------------
    def _credentials(self):
        if self.cfg.service_account_json:
            from google.oauth2 import service_account

            info = json.loads(self.cfg.service_account_json)
            return service_account.Credentials.from_service_account_info(info)
        return None  # ADC (Cloud Run)

    def db(self):
        if self._db is None:
            from google.cloud import firestore

            creds = self._credentials()
            project = self.cfg.resolved_project_id()
            self._db = firestore.Client(project=project, credentials=creds)
        return self._db

    def bucket(self):
        if self._bucket is None:
            from google.cloud import storage

            creds = self._credentials()
            project = self.cfg.resolved_project_id()
            client = storage.Client(project=project, credentials=creds)
            if not self.cfg.storage_bucket:
                raise RuntimeError("STORAGE_BUCKET is not set")
            self._bucket = client.bucket(self.cfg.storage_bucket)
        return self._bucket

    def _ts(self):
        from google.cloud import firestore

        return firestore.SERVER_TIMESTAMP

    def _run_ref(self):
        return self.db().collection(self.RUNS).document(self.run_id)

    # -- lifecycle ---------------------------------------------------------
    def claim_run(self) -> dict[str, Any]:
        snap = self._run_ref().get()
        if not snap.exists:
            raise RuntimeError(f"run {self.run_id} not found in {self.RUNS}")
        data = snap.to_dict() or {}
        self._run_cache = data
        update = {"status": "running", "updated_at": self._ts(), "trigger_error": None}
        if not data.get("started_at"):
            update["started_at"] = self._ts()
        self._run_ref().update(update)
        return data

    def fetch_input(self) -> str:
        path = self._run_cache["input_path"]
        local = os.path.join(self._tmpdir, os.path.basename(path))
        self.bucket().blob(path).download_to_filename(local)
        return local

    def save_intake(self, sheets, planned) -> None:
        sheets_doc = [
            {
                "name": s.name,
                "header_row": s.header_row,
                "group_header_row": s.group_row,
                "data_row_count": len(s.rows),
                "mapping": s.mapping_doc(),
                "ambiguous": s.ambiguous,
                "protected_columns": s.protected_columns,
            }
            for s in sheets
        ]
        self._run_ref().update({
            "sheets": sheets_doc,
            "totals.rows": len(planned),
            "updated_at": self._ts(),
        })

        existing = {
            d.id for d in self._run_ref().collection("rows").select([]).stream()
        }
        db = self.db()
        batch = db.batch()
        ops = 0
        for key, sheet_index, row, sheet in planned:
            if key in existing:
                continue
            row_ref = self._run_ref().collection("rows").document(key)
            batch.set(row_ref, {
                "id": key,
                "run_id": self.run_id,
                "sheet_name": sheet.name,
                "row_number": row.row_number,
                "state": "pending",
                "input": row_input_doc(row),
                "accounts": [],
                "row_status": None,
                "status_note": None,
                "confidence": None,
                "evidence": None,
                "needs_review_reason": None,
                "skyvern": None,
                "writes": None,
                "created_at": self._ts(),
                "updated_at": self._ts(),
            })
            state_ref = db.collection(self.SCRAPE_STATE).document(
                f"{JOB_NAME}__{self.run_id}__{key}"
            )
            batch.set(state_ref, {
                "id": f"{JOB_NAME}__{self.run_id}__{key}",
                "job_name": JOB_NAME,
                "run_id": self.run_id,
                "target_id": key,
                "status": "pending",
                "row_status": None,
                "error": None,
                "attempted_at": None,
                "completed_at": None,
                "created_at": self._ts(),
                "updated_at": self._ts(),
            })
            ops += 2
            if ops >= 400:
                batch.commit()
                batch = db.batch()
                ops = 0
        if ops:
            batch.commit()

    def pending_keys(self, resume: bool) -> set[str]:
        # Single-field query + in-code status filter: a run's scrape_state set
        # is small, and this avoids needing a composite index at all.
        wanted = {"pending", "in_progress"} | ({"failed"} if resume else set())
        q = self.db().collection(self.SCRAPE_STATE).where(
            "run_id", "==", self.run_id
        )
        return {
            doc.get("target_id")
            for doc in q.stream()
            if doc.get("status") in wanted
        }

    def _state_ref(self, key: str):
        return self.db().collection(self.SCRAPE_STATE).document(
            f"{JOB_NAME}__{self.run_id}__{key}"
        )

    def mark_in_progress(self, key: str) -> None:
        self._state_ref(key).update({
            "status": "in_progress",
            "attempted_at": self._ts(),
            "updated_at": self._ts(),
        })
        self._run_ref().collection("rows").document(key).update({
            "state": "in_progress",
            "updated_at": self._ts(),
        })

    def _outcome_doc(self, outcome: RowOutcome) -> dict[str, Any]:
        return {
            "state": outcome.row_status,
            "accounts": [a.to_dict() for a in outcome.accounts],
            "row_status": outcome.row_status,
            "status_note": outcome.status_note,
            "confidence": outcome.confidence,
            "evidence": outcome.evidence,
            "needs_review_reason": outcome.needs_review_reason,
            "skyvern": {
                "run_ids": outcome.skyvern_run_ids,
                "recording_urls": outcome.recording_urls,
                "app_urls": outcome.app_urls,
            },
            "writes": {
                "date_paid": outcome.write_date_paid,
                "receipt": outcome.write_receipt,
                "assessed_value": outcome.write_assessed_value,
                "amount_due": outcome.write_amount_due,
                "discovered_url": outcome.discovered_url,
            },
            "updated_at": self._ts(),
        }

    def _run_tally_updates(self, key: str, outcome: RowOutcome) -> dict[str, Any]:
        """Counter deltas for the run doc. A row re-processed after a retry
        first UNDOES its previous tally (status count + amount due) so totals
        — especially the money — never double-count."""
        from google.cloud import firestore

        prev = (
            self._run_ref().collection("rows").document(key)
            .get(field_paths=["row_status", "accounts"]).to_dict() or {}
        )
        prev_status = prev.get("row_status")
        prev_due = sum(
            (a.get("amount_due") or 0) for a in (prev.get("accounts") or [])
        )
        new_due = sum((a.amount_due or 0) for a in outcome.accounts)

        updates: dict[str, Any] = {"updated_at": self._ts()}
        due_delta = round(new_due - prev_due, 2)
        if due_delta:
            updates["totals.amount_due"] = firestore.Increment(due_delta)
        if prev_status is None:
            updates["totals.processed"] = firestore.Increment(1)
        new_counter = _COUNTER_BY_STATUS.get(outcome.row_status, "needs_review")
        old_counter = _COUNTER_BY_STATUS.get(prev_status) if prev_status else None
        if old_counter != new_counter:
            if old_counter:
                updates[f"totals.{old_counter}"] = firestore.Increment(-1)
            updates[f"totals.{new_counter}"] = firestore.Increment(1)
        return updates

    def save_outcome(self, key: str, outcome: RowOutcome) -> None:
        tally = self._run_tally_updates(key, outcome)
        self._run_ref().collection("rows").document(key).update(
            self._outcome_doc(outcome)
        )
        self._state_ref(key).update({
            "status": "done",
            "row_status": outcome.row_status,
            "error": None,
            "completed_at": self._ts(),
            "updated_at": self._ts(),
        })
        self._run_ref().update(tally)

    def mark_failed(self, key: str, error: str, outcome: RowOutcome) -> None:
        tally = self._run_tally_updates(key, outcome)
        self._run_ref().collection("rows").document(key).update(
            self._outcome_doc(outcome)
        )
        self._state_ref(key).update({
            "status": "failed",
            "row_status": outcome.row_status,
            "error": error[:1500],
            "updated_at": self._ts(),
        })
        self._run_ref().update(tally)

    def cancel_requested(self) -> bool:
        snap = self._run_ref().get(field_paths=["cancel_requested"])
        return bool(snap.exists and snap.get("cancel_requested"))

    def set_status(self, status: str) -> None:
        self._run_ref().update({"status": status, "updated_at": self._ts()})

    def collect_outcomes(self) -> dict[str, RowOutcome]:
        out: dict[str, RowOutcome] = {}
        for doc in self._run_ref().collection("rows").stream():
            d = doc.to_dict() or {}
            if not d.get("status_note"):
                continue
            writes = d.get("writes") or {}
            out[doc.id] = RowOutcome(
                row_key=doc.id,
                sheet_name=d.get("sheet_name", ""),
                row_number=int(d.get("row_number") or 0),
                accounts=[],
                row_status=d.get("row_status") or NEEDS_REVIEW,
                status_note=d.get("status_note") or "",
                confidence=d.get("confidence") or "LOW",
                evidence=d.get("evidence") or "",
                needs_review_reason=d.get("needs_review_reason"),
                write_date_paid=writes.get("date_paid"),
                write_receipt=writes.get("receipt"),
                write_assessed_value=writes.get("assessed_value"),
                write_amount_due=writes.get("amount_due"),
                discovered_url=writes.get("discovered_url"),
            )
        return out

    def put_output(self, local_path: str, file_name: str) -> str:
        path = f"tax_checker/outputs/{self.run_id}/{file_name}"
        self.bucket().blob(path).upload_from_filename(
            local_path,
            content_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
        )
        return path

    def finish(self, summary, output_path, output_file_name, failed, canceled) -> None:
        if canceled:
            status = "canceled"
        elif failed:
            status = "done_with_errors"
        else:
            status = "done"
        self._run_ref().update({
            "status": status,
            "summary": summary,
            "output_path": output_path,
            "output_file_name": output_file_name,
            "finished_at": self._ts(),
            "updated_at": self._ts(),
        })

    def fail_run(self, error: str) -> None:
        self._run_ref().update({
            "status": "failed",
            "error": error[:1500],
            "finished_at": self._ts(),
            "updated_at": self._ts(),
        })

    # -- playbooks ----------------------------------------------------------
    def load_playbooks(self) -> list[Playbook]:
        col = self.db().collection(self.PLAYBOOKS)
        docs = list(col.stream())
        if not docs:
            batch = self.db().batch()
            for pb in SEED_PLAYBOOKS:
                d = pb.to_dict()
                d["created_at"] = self._ts()
                d["updated_at"] = self._ts()
                batch.set(col.document(pb.key), d)
            batch.commit()
            return list(SEED_PLAYBOOKS)
        return [Playbook.from_dict(d.to_dict() or {}) for d in docs]

    def upsert_playbook(self, pb: Playbook) -> bool:
        ref = self.db().collection(self.PLAYBOOKS).document(pb.key)
        if ref.get().exists:
            return False
        d = pb.to_dict()
        d["discovered_in_run"] = self.run_id
        d["created_at"] = self._ts()
        d["updated_at"] = self._ts()
        ref.set(d)
        return True

    # -- events --------------------------------------------------------------
    def log_event(self, level: str, message: str, key: str | None = None) -> None:
        try:
            self._run_ref().collection("events").add({
                "level": level,
                "message": message[:1500],
                "row_key": key,
                "ts": self._ts(),
            })
        except Exception:  # noqa: BLE001 — logging must never kill a run
            log.warning("event write failed: %s", message)


# ===========================================================================
# Local (no cloud)
# ===========================================================================

class LocalStore:
    def __init__(self, xlsx_path: str, max_rows: int | None = None):
        self.run_id = "local"
        self.xlsx_path = os.path.abspath(xlsx_path)
        self.max_rows = max_rows
        self.outcomes: dict[str, RowOutcome] = {}
        self.playbooks: dict[str, Playbook] = {pb.key: pb for pb in SEED_PLAYBOOKS}
        self.new_playbooks: list[str] = []
        self.planned: list[str] = []
        self.summary: dict[str, Any] | None = None
        self.output_local: str | None = None

    def claim_run(self) -> dict[str, Any]:
        return {
            "file_name": os.path.basename(self.xlsx_path),
            "input_path": self.xlsx_path,
        }

    def fetch_input(self) -> str:
        return self.xlsx_path

    def save_intake(self, sheets, planned) -> None:
        self.planned = [key for key, *_ in planned]
        for s in sheets:
            log.info(
                "sheet '%s': header row %s, %d data rows, mapping=%s",
                s.name, s.header_row, len(s.rows), s.mapping_doc(),
            )
            for a in s.ambiguous:
                log.warning("ambiguous mapping: %s", a)

    def pending_keys(self, resume: bool) -> set[str]:
        keys = list(self.planned)
        if self.max_rows is not None:
            keys = keys[: self.max_rows]
        return set(keys)

    def mark_in_progress(self, key: str) -> None:
        log.info("→ %s", key)

    def save_outcome(self, key: str, outcome: RowOutcome) -> None:
        self.outcomes[key] = outcome
        log.info("✓ %s %s — %s", key, outcome.row_status, outcome.status_note)

    def mark_failed(self, key: str, error: str, outcome: RowOutcome) -> None:
        self.outcomes[key] = outcome
        log.error("✗ %s failed: %s", key, error)

    def cancel_requested(self) -> bool:
        return False

    def set_status(self, status: str) -> None:
        log.info("run status → %s", status)

    def collect_outcomes(self) -> dict[str, RowOutcome]:
        return dict(self.outcomes)

    def put_output(self, local_path: str, file_name: str) -> str:
        self.output_local = local_path
        return local_path

    def finish(self, summary, output_path, output_file_name, failed, canceled) -> None:
        self.summary = summary
        base, _ = os.path.splitext(self.xlsx_path)
        summary_path = f"{base} — summary {dt.date.today().isoformat()}.json"
        with open(summary_path, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2, default=str)
        log.info("summary written: %s", summary_path)
        if output_path:
            log.info("checked workbook: %s", output_path)

    def fail_run(self, error: str) -> None:
        log.error("RUN FAILED: %s", error)

    def load_playbooks(self) -> list[Playbook]:
        return list(self.playbooks.values())

    def upsert_playbook(self, pb: Playbook) -> bool:
        if pb.key in self.playbooks:
            return False
        self.playbooks[pb.key] = pb
        self.new_playbooks.append(pb.key)
        return True

    def log_event(self, level: str, message: str, key: str | None = None) -> None:
        getattr(log, level if level in ("info", "warning", "error") else "info")(
            "%s%s", f"[{key}] " if key else "", message
        )
