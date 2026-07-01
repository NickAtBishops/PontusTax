"""Worker entrypoint.

Cloud Run Job:   RUN_ID env (set per execution by the web app) — Firestore mode.
Local dev:       python main.py --run-id <id>            (Firestore mode)
                 python main.py --local-xlsx tracker.xlsx [--dry-run] [--max-rows N]
                                                          (no cloud at all)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

# Load .env files for local runs (repo root + worker/). No-op when absent.
try:
    from dotenv import load_dotenv

    _root = os.path.join(os.path.dirname(__file__), "..")
    load_dotenv(os.path.join(_root, ".env"))
    load_dotenv(os.path.join(_root, ".env.local"), override=True)
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)
except ModuleNotFoundError:
    pass

from pontus_tax.config import Config
from pontus_tax.orchestrator import execute_run
from pontus_tax.store import FirestoreStore, LocalStore, claim_next_queued

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("pontus_tax.main")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pontus property-tax check worker")
    p.add_argument("--run-id", default=os.environ.get("RUN_ID"),
                   help="tax_checker_runs document id (Firestore mode)")
    p.add_argument("--local-xlsx", default=None,
                   help="process a workbook on disk with no cloud (dev mode)")
    p.add_argument("--dry-run", action="store_true",
                   help="parse + write back without contacting any portal")
    p.add_argument("--max-rows", type=int, default=None,
                   help="local mode: only process the first N rows")
    p.add_argument("--resume", action="store_true",
                   default=os.environ.get("RESUME") == "1",
                   help="also re-run rows whose scrape_state is 'failed'")
    # --engine only applies to local mode (LocalStore). In Firestore
    # mode the engine rides on the run document, written by the upload
    # API at run-creation time.
    p.add_argument(
        "--engine",
        choices=["skyvern", "playwright"],
        default=os.environ.get("LOCAL_ENGINE", "skyvern"),
        help="engine for --local-xlsx runs (default: skyvern)",
    )
    return p.parse_args(argv)


def _run_once(
    store: FirestoreStore | LocalStore, cfg: Config, args: argparse.Namespace
) -> bool:
    """Process a single run. Returns True on success, False on hard failure
    (the run is marked failed so the queue isn't blocked by it)."""
    try:
        asyncio.run(execute_run(store, cfg, resume=args.resume, dry_run=args.dry_run))
        return True
    except Exception as exc:  # noqa: BLE001
        log.exception("run failed")
        if isinstance(store, FirestoreStore):
            try:
                store.fail_run(f"{type(exc).__name__}: {exc}")
            except Exception:  # noqa: BLE001
                pass
        return False


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    cfg = Config()

    # Each engine needs its own key, and a Firestore-mode worker
    # (Cloud Run job) doesn't know which engine the queue will ask for
    # until a run is actually claimed — `engine` lives on the run doc,
    # read inside execute_run(), strictly after this function would
    # already have to decide whether to start at all. So we do NOT
    # hard-require SKYVERN_API_KEY here the way earlier code did: a
    # deployment that intentionally runs Playwright-only (no Skyvern
    # plan, ANTHROPIC_API_KEY set) would otherwise refuse to start at
    # all, every single invocation, queue never even inspected. Each
    # runner already lazily raises a clear error on its OWN missing key
    # when it's actually constructed (SkyvernRunner._sdk(),
    # Extractor.__init__) — that's what surfaces a real misconfiguration
    # for whichever engine a run actually picked. We only refuse to
    # start here when NEITHER key is present, since then no run of
    # either engine could possibly succeed.
    if (
        not args.dry_run
        and not args.local_xlsx
        and not cfg.skyvern_api_key
        and not cfg.anthropic_api_key
    ):
        log.error(
            "Neither SKYVERN_API_KEY nor ANTHROPIC_API_KEY is set — no "
            "queued run, on either engine, could succeed (use --dry-run "
            "to test without either)"
        )
        return 2
    if (
        not args.dry_run
        and args.local_xlsx
        and args.engine == "skyvern"
        and not cfg.skyvern_api_key
    ):
        log.error("SKYVERN_API_KEY is not set (use --engine playwright or --dry-run)")
        return 2
    if (
        not args.dry_run
        and args.local_xlsx
        and args.engine == "playwright"
        and not cfg.anthropic_api_key
    ):
        log.error(
            "ANTHROPIC_API_KEY is not set — required by the Playwright "
            "engine's extraction step"
        )
        return 2

    # Explicit single-run modes: process exactly the requested run.
    if args.local_xlsx:
        store = LocalStore(
            args.local_xlsx, max_rows=args.max_rows, engine=args.engine,
        )
        return 0 if _run_once(store, cfg, args) else 1
    if args.run_id:
        return 0 if _run_once(FirestoreStore(cfg, args.run_id), cfg, args) else 1

    # Argument-free (Cloud Run trigger): DRAIN the queue. After each run
    # finishes or is canceled, claim the next queued run and process it too,
    # so the queue empties on its own without a fresh execution per run.
    # Executions stay serialized — claim_next_queued refuses while another
    # run is active — so this loop is the single active worker, one run at a
    # time. A run that crashes is marked failed (not re-queued), so the loop
    # can't spin on it; the job's own timeout bounds the total.
    processed = 0
    while True:
        run_id = claim_next_queued(cfg)
        if run_id is None:
            if processed == 0:
                log.info("no queued runs — nothing to do")
            else:
                log.info("queue drained — %d run(s) processed", processed)
            return 0
        processed += 1
        log.info("claimed queued run %s (#%d this execution)", run_id, processed)
        _run_once(FirestoreStore(cfg, run_id), cfg, args)


if __name__ == "__main__":
    raise SystemExit(main())
