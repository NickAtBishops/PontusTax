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
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    cfg = Config()

    if args.local_xlsx:
        store: FirestoreStore | LocalStore = LocalStore(
            args.local_xlsx, max_rows=args.max_rows
        )
    elif args.run_id:
        store = FirestoreStore(cfg, args.run_id)
    else:
        # Cloud Run executions start argument-free: claim the oldest queued
        # run (atomic) so triggering needs no container overrides.
        run_id = claim_next_queued(cfg)
        if run_id is None:
            log.info("no queued runs — nothing to do")
            return 0
        store = FirestoreStore(cfg, run_id)

    if not args.dry_run and not cfg.skyvern_api_key:
        log.error("SKYVERN_API_KEY is not set (use --dry-run to test without it)")
        return 2

    try:
        asyncio.run(execute_run(store, cfg, resume=args.resume, dry_run=args.dry_run))
        return 0
    except Exception as exc:  # noqa: BLE001
        log.exception("run failed")
        if isinstance(store, FirestoreStore):
            try:
                store.fail_run(f"{type(exc).__name__}: {exc}")
            except Exception:  # noqa: BLE001
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
