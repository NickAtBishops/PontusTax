"""Skyvern execution layer.

One browser session per portal DOMAIN (several rows share a portal — reuse
the session, don't hammer), polite delays between tasks on the same domain,
transient-5xx backoff (the session endpoint 504s while their pool warms),
and a single run_attempt() primitive the orchestrator drives.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any

from .config import Config

log = logging.getLogger("pontus_tax.skyvern")

TERMINAL_FAILURE = {"failed", "terminated", "timed_out", "canceled"}
SESSION_CREATE_BACKOFFS = (2, 5, 10)


@dataclass
class AttemptResult:
    output: Any
    status: str | None
    run_id: str | None
    recording_url: str | None
    app_url: str | None
    failure_reason: str | None
    downloaded_files: list[Any] = field(default_factory=list)


def coerce_output(raw: Any) -> dict[str, Any]:
    """Skyvern output can be a dict, list, or JSON string — normalize."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return {"page_outcome": "error", "bills": [], "notes": raw[:2000]}
    if isinstance(raw, list):
        raw = raw[0] if raw and isinstance(raw[0], dict) else {}
    if not isinstance(raw, dict):
        return {"page_outcome": "error", "bills": []}
    raw.setdefault("bills", [])
    return raw


class SkyvernRunner:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._client = None
        self._sessions: dict[str, str] = {}
        self._domain_locks: dict[str, asyncio.Lock] = {}
        self._last_call: dict[str, float] = {}

    def _sdk(self):
        if self._client is None:
            from skyvern import Skyvern  # lazy: keeps tests dependency-free

            if not self.cfg.skyvern_api_key:
                raise RuntimeError("SKYVERN_API_KEY is not set")
            self._client = Skyvern(api_key=self.cfg.skyvern_api_key)
        return self._client

    def domain_lock(self, domain: str) -> asyncio.Lock:
        """Rows on the same portal run strictly sequentially."""
        if domain not in self._domain_locks:
            self._domain_locks[domain] = asyncio.Lock()
        return self._domain_locks[domain]

    async def _polite_wait(self, domain: str) -> None:
        last = self._last_call.get(domain)
        if last is not None:
            delay = self.cfg.polite_delay * (0.75 + random.random() * 0.5)
            wait = last + delay - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
        self._last_call[domain] = time.monotonic()

    async def session_for(self, domain: str) -> str | None:
        """Shared browser session per domain (keeps disclaimers/cookies).
        Transient 5xx → retry, then degrade to per-task ephemeral browsers."""
        if domain in self._sessions:
            return self._sessions[domain] or None
        from skyvern.client.core.api_error import ApiError

        client = self._sdk()
        attempts = len(SESSION_CREATE_BACKOFFS) + 1
        for i in range(attempts):
            try:
                session = await client.create_browser_session(
                    proxy_location=self.cfg.proxy_location
                )
                sid = session.browser_session_id
                self._sessions[domain] = sid
                log.info("browser session %s for %s", sid, domain)
                return sid
            except ApiError as exc:
                transient = exc.status_code is not None and exc.status_code >= 500
                if not transient or i == attempts - 1:
                    log.warning(
                        "create_browser_session failed for %s (status=%s) — "
                        "running without a shared session",
                        domain, exc.status_code,
                    )
                    self._sessions[domain] = ""
                    return None
                await asyncio.sleep(SESSION_CREATE_BACKOFFS[i])
        self._sessions[domain] = ""
        return None

    async def run_attempt(
        self,
        domain: str,
        url: str,
        prompt: str,
        schema: dict[str, Any],
        title: str,
    ) -> AttemptResult:
        client = self._sdk()
        await self._polite_wait(domain)
        session_id = await self.session_for(domain)

        kwargs: dict[str, Any] = dict(
            url=url,
            prompt=prompt,
            data_extraction_schema=schema,
            engine=self.cfg.skyvern_engine,
            max_steps=self.cfg.max_steps,
            proxy_location=self.cfg.proxy_location,
            wait_for_completion=True,
            timeout=self.cfg.attempt_timeout,
            title=title[:120],
        )
        if session_id:
            kwargs["browser_session_id"] = session_id

        run = await client.run_task(**kwargs)
        status = getattr(run, "status", None)
        log.info("skyvern %s → %s", getattr(run, "run_id", "?"), status)

        if status in TERMINAL_FAILURE:
            output: Any = {
                "page_outcome": "error",
                "bills": [],
                "notes": f"skyvern status={status}; "
                         f"reason={getattr(run, 'failure_reason', None)}",
            }
        else:
            output = getattr(run, "output", None)

        return AttemptResult(
            output=output,
            status=status,
            run_id=getattr(run, "run_id", None),
            recording_url=getattr(run, "recording_url", None),
            app_url=getattr(run, "app_url", None),
            failure_reason=getattr(run, "failure_reason", None),
            downloaded_files=list(getattr(run, "downloaded_files", None) or []),
        )

    async def download_bill_pdf(
        self,
        domain: str,
        url: str,
        goal: str,
    ) -> AttemptResult:
        """Type F portals: the bill exists only as a PDF — downloading the
        target-year bill is the one permitted artifact (§11). Python's
        download_files doesn't support wait_for_completion; poll get_run."""
        client = self._sdk()
        await self._polite_wait(domain)
        session_id = await self.session_for(domain)

        run = await client.download_files(
            navigation_goal=goal,
            url=url,
            browser_session_id=session_id or None,
            proxy_location=self.cfg.proxy_location,
            download_suffix=".pdf",
        )
        run_id = getattr(run, "run_id", None)
        status = getattr(run, "status", None)
        deadline = time.monotonic() + self.cfg.attempt_timeout
        while (
            run_id
            and status not in TERMINAL_FAILURE
            and status != "completed"
            and time.monotonic() < deadline
        ):
            await asyncio.sleep(10)
            run = await client.get_run(run_id)
            status = getattr(run, "status", None)

        return AttemptResult(
            output=getattr(run, "output", None),
            status=status,
            run_id=run_id,
            recording_url=getattr(run, "recording_url", None),
            app_url=getattr(run, "app_url", None),
            failure_reason=getattr(run, "failure_reason", None),
            downloaded_files=list(getattr(run, "downloaded_files", None) or []),
        )

    async def close_all(self) -> None:
        if self._client is None:
            return
        for domain, sid in self._sessions.items():
            if not sid:
                continue
            try:
                await self._client.close_browser_session(sid)
                log.info("closed session %s (%s)", sid, domain)
            except Exception:  # noqa: BLE001
                pass
        self._sessions.clear()
