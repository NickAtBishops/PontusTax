"""Playwright Chromium lifecycle for the Playwright engine.

ONE headless Chromium process per worker (Cloud Run job execution). Each
recipe call borrows a fresh BrowserContext from it via the `page()`
async context manager. We use a context (not a tab on a shared context)
per row so cookies, localStorage, and any disclaimer "I agree" state
from row A do not bleed into row B on the SAME portal. Cookies are not
the right place to remember that we accepted Putnam County's terms;
each row should look like a fresh visitor.

Politeness: rows that share a portal domain run sequentially with a
delay between them (the orchestrator already groups by domain and runs
the group on one asyncio worker; we add the inter-call delay here so
the Skyvern path's polite_delay behaviour is mirrored).

Bright Data residential proxy: Cloud Run's own egress IP is in a
datacenter range that Cloudflare-fronted county portals either
challenge or silently serve degraded content to (confirmed live
2026-06-30 against the Grant Street/county-taxes.net family — every
deep link that worked perfectly from a residential connection failed
once deployed). When BRIGHT_DATA_* env vars are set (see config.py),
every browser context routes through a Bright Data residential exit
IP, geo-pinned to the US (every property in the portfolio is a US
county portal) and STICKY for the lifetime of that one context — one
property visit, one consistent IP, so mid-visit IP churn doesn't add
extra bot-suspicion on top of everything else. When unset, behavior is
unchanged (direct Cloud Run egress) — local dev never needs a Bright
Data account just to run the test suite.

This module is import-safe even when Playwright is not installed (e.g.
local dev on a machine that only runs the Skyvern engine). The import
happens lazily inside `_ensure_started`.
"""

from __future__ import annotations

import asyncio
import logging
import random
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from ..config import Config

log = logging.getLogger("pontus_tax.playwright.browser")


async def _abort_route(route: Any, request: Any) -> None:
    """Route handler for the image-blocking filter. Playwright's async
    API calls handlers as handler(route, request) — both positional
    args are required even though we don't use `request`."""
    await route.abort()


class Browser:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._playwright: Any | None = None
        self._browser: Any | None = None
        # last_call timestamp per domain, for inter-call polite delay
        self._last_call: dict[str, float] = {}
        # one asyncio.Lock per domain so two coroutines never both think
        # "domain X is idle, my turn" and race the polite delay
        self._domain_locks: dict[str, asyncio.Lock] = {}
        # Guards _ensure_started's check-then-act on self._browser. The
        # orchestrator runs distinct portal domains CONCURRENTLY (up to
        # MAX_CONCURRENCY, currently 10) via asyncio.gather, and every
        # domain's first call into page() reaches _ensure_started before
        # any of them have hit a real await suspension point yet — so
        # without this lock, multiple coroutines observe self._browser
        # is None simultaneously and each launch their own Chromium
        # process. The last assignment wins; every earlier-launched
        # browser+driver process leaks as an unreachable zombie for the
        # life of the container, since close() only closes whichever
        # browser is currently referenced.
        self._start_lock = asyncio.Lock()

    # -- lifecycle --------------------------------------------------------

    async def _ensure_started(self) -> None:
        if self._browser is not None:
            return
        async with self._start_lock:
            # Re-check after acquiring the lock: another coroutine may
            # have already finished starting the browser while we were
            # waiting for it.
            if self._browser is not None:
                return
            # Lazy import: keeps the Skyvern path import-safe on
            # machines that have not installed playwright (and means a
            # missing Chromium binary only crashes a Playwright run,
            # not a Skyvern run that happens to import this module).
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            # --no-sandbox is required inside containers; the official
            # Playwright Python image runs as root and the kernel
            # sandbox is not available. --disable-dev-shm-usage avoids
            # /dev/shm OOMs under load on small Cloud Run instances.
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            # One clear line per run, not per-row: the next time a run
            # comes back with a wall of "not a bill page" failures, this
            # answers "was the proxy even on" without having to guess.
            if self.cfg.bright_data_enabled:
                log.info(
                    "playwright chromium started — Bright Data residential "
                    "proxy ENABLED (zone=%s, country=%s)",
                    self.cfg.bright_data_zone, self.cfg.bright_data_country,
                )
            else:
                log.info(
                    "playwright chromium started — Bright Data proxy "
                    "DISABLED (BRIGHT_DATA_CUSTOMER_ID/ZONE/ZONE_PASSWORD "
                    "not set; using direct egress)"
                )

    async def close(self) -> None:
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:  # noqa: BLE001 — cleanup never blocks a run
                pass
            self._browser = None
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            except Exception:  # noqa: BLE001
                pass
            self._playwright = None
        log.info("playwright chromium closed")

    # -- politeness -------------------------------------------------------

    def domain_lock(self, domain: str) -> asyncio.Lock:
        """Mirror of SkyvernRunner.domain_lock — rows on the same portal
        run strictly sequentially, even if the caller forgot to group."""
        if domain not in self._domain_locks:
            self._domain_locks[domain] = asyncio.Lock()
        return self._domain_locks[domain]

    async def _polite_wait(self, domain: str) -> None:
        last = self._last_call.get(domain)
        if last is not None:
            # Jitter 0.75x..1.25x so a sequence of rows on one portal
            # does not look like a metronome to a WAF.
            delay = self.cfg.polite_delay * (0.75 + random.random() * 0.5)
            wait = last + delay - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
        self._last_call[domain] = time.monotonic()

    # -- proxy --------------------------------------------------------------

    def _proxy_settings(self) -> dict[str, str] | None:
        """Build a Playwright ProxySettings dict for ONE browser context,
        with a fresh sticky session — a new random residential IP per
        property visit, consistent for that visit's whole lifetime.
        Returns None when Bright Data isn't configured (cfg.bright_data_
        enabled is False), so the caller falls back to direct egress.

        Username format is Bright Data's documented convention:
          brd-customer-<id>-zone-<zone>-country-<cc>-session-<session_id>
        The session id must be alphanumeric only (Bright Data rejects
        '-' or other punctuation inside it) — token_hex() output
        satisfies that without any extra sanitizing.
        """
        if not self.cfg.bright_data_enabled:
            return None
        session_id = secrets.token_hex(8)
        username = (
            f"brd-customer-{self.cfg.bright_data_customer_id}"
            f"-zone-{self.cfg.bright_data_zone}"
            f"-country-{self.cfg.bright_data_country}"
            f"-session-{session_id}"
        )
        return {
            "server": self.cfg.bright_data_proxy_server,
            "username": username,
            "password": self.cfg.bright_data_zone_password or "",
        }

    # -- proxy-tunnel failure detection -----------------------------------

    # Chromium net-error substrings that mean the PROXY ITSELF refused or
    # dropped the CONNECT tunnel — before any HTTP response the target
    # site could have produced. This is the exact shape of two real,
    # confirmed failure modes: Bright Data's account-level "Government
    # website" compliance block (policy_20000 — applies across ISP,
    # Datacenter AND Residential zones alike per Bright Data's own docs,
    # independent of KYC status) and its intermittent proxy-peer
    # failures (same URL, same session shape, succeeds and fails minutes
    # apart — confirmed live 2026-06-30 via curl and bare Playwright).
    # Deliberately does NOT match a plain "Timeout ... exceeded" — that
    # usually means the target site itself is slow or down, and retrying
    # without the proxy would just trade that for the Cloudflare-block
    # problem the proxy exists to solve.
    _PROXY_FAILURE_SIGNATURES = (
        "err_tunnel_connection_failed",
        "err_proxy_connection_failed",
        "err_proxy_auth",
        "err_socks_connection_failed",
        "err_connection_closed",
    )

    @classmethod
    def _is_proxy_connection_failure(cls, exc: Exception) -> bool:
        message = str(exc).lower()
        return any(sig in message for sig in cls._PROXY_FAILURE_SIGNATURES)

    async def _retry_direct(
        self,
        old_context: Any,
        ua: str,
        url: str,
        goto_kwargs: dict[str, Any] | None,
        domain: str,
    ) -> tuple[Any, Any]:
        """Close the failed proxied context and redo the same navigation
        with no proxy at all. Shared by both retry triggers below (a
        goto() exception, or a goto() that "succeeded" with a 4xx/5xx
        status) since the recovery is identical either way.

        If this SECOND attempt also fails, the new context must be
        closed here before re-raising — the caller's `context` local
        only gets reassigned on a successful `return`, so a failure
        left uncaught here would leak this context past the caller's
        own cleanup, which still only knows about the FIRST context.
        """
        await old_context.close()
        context = await self._new_context(ua, use_proxy=False)
        pg = await context.new_page()
        pg.set_default_timeout(45_000)
        try:
            await pg.goto(url, **(goto_kwargs or {}))
        except Exception:  # noqa: BLE001
            await context.close()
            raise
        log.info("playwright: direct-egress retry for domain=%s succeeded", domain)
        return context, pg

    # -- context construction ----------------------------------------------

    async def _new_context(self, ua: str, *, use_proxy: bool) -> Any:
        assert self._browser is not None  # _ensure_started must have run
        context_kwargs: dict[str, Any] = dict(
            user_agent=ua,
            viewport={"width": 1366, "height": 900},
            # Skip images to cut bandwidth and speed up renders; tax
            # portals show numbers in HTML, not pictures. If a
            # particular portal needs images we can override per recipe
            # later.
            java_script_enabled=True,
        )
        proxy = self._proxy_settings() if use_proxy else None
        if proxy is not None:
            context_kwargs["proxy"] = proxy
            # Bright Data's residential network can present a different
            # cert chain than the origin server depending on the exit
            # node; without this, an otherwise-healthy proxied request
            # can fail as a generic SSL error that looks identical to a
            # real portal outage.
            context_kwargs["ignore_https_errors"] = True
        context = await self._browser.new_context(**context_kwargs)
        # Playwright's async API always invokes route handlers as
        # handler(route, request) — a 1-arg lambda raises TypeError the
        # instant any request matches, and since route dispatch runs
        # inside a detached asyncio Task (not on the await page.goto()
        # call site), that TypeError never propagates anywhere visible;
        # it just silently leaves every matched request unresolved (no
        # continue/abort ever reached) until the page tears down. Must
        # accept both positional args.
        await context.route("**/*.{png,jpg,jpeg,gif,webp,svg}", _abort_route)
        return context

    # -- the surface every recipe uses -----------------------------------

    @asynccontextmanager
    async def page(
        self,
        domain: str,
        *,
        user_agent: str | None = None,
        url: str | None = None,
        goto_kwargs: dict[str, Any] | None = None,
    ) -> AsyncIterator[Any]:
        """Yield a Playwright Page on a FRESH browser context. The context
        is closed when the block exits, so cookies and disclaimer state
        do not leak between rows.

        The polite delay is consumed BEFORE the page is yielded.

        Pass `url` (+ optional `goto_kwargs`) to have this method drive
        the FIRST navigation itself, instead of the caller doing
        `await page.goto(...)` right after opening the context. That is
        what makes the direct-egress fallback below possible: a Bright
        Data proxy-tunnel failure (see `_is_proxy_connection_failure`),
        or a proxied response that comes back with a 4xx/5xx status
        (the tunnel succeeds but the response IS the block — observed
        live as a 403), will fail the exact same way on a second
        attempt through the SAME proxy, so instead we retry once with
        the proxy removed entirely — Cloud Run's direct egress never
        touches Bright Data's network, so there's no compliance policy
        or proxy-peer state left to trip on the retry. If the caller
        does its own goto() instead (the old pattern), none of this
        applies.
        """
        await self._ensure_started()
        async with self.domain_lock(domain):
            await self._polite_wait(domain)
            # A realistic UA + viewport keeps a few portals (Cloudflare,
            # some county WAFs) from serving the "are you a bot" page.
            ua = user_agent or (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            )
            context = await self._new_context(ua, use_proxy=True)
            pg = await context.new_page()
            # Reasonable default; recipes can override per call.
            pg.set_default_timeout(45_000)
            try:
                if url is not None:
                    retry_reason: str | None = None
                    try:
                        resp = await pg.goto(url, **(goto_kwargs or {}))
                    except Exception as exc:  # noqa: BLE001
                        if not (
                            self.cfg.bright_data_enabled
                            and self._is_proxy_connection_failure(exc)
                        ):
                            raise
                        retry_reason = f"failed at the tunnel level ({exc})"
                    else:
                        # A tunnel-level block is the shape a Government-
                        # site compliance block usually takes, but not
                        # always — one was observed live returning a
                        # normal-looking HTTP 403 instead (the proxy let
                        # the request through; the response was the
                        # block). goto() doesn't raise for HTTP error
                        # statuses, so this branch is the only place that
                        # would ever catch that case.
                        if (
                            self.cfg.bright_data_enabled
                            and resp is not None
                            and resp.status >= 400
                        ):
                            retry_reason = f"returned HTTP {resp.status}"
                    if retry_reason is not None:
                        log.warning(
                            "playwright: proxied navigation to domain=%s "
                            "%s — retrying once via direct Cloud Run "
                            "egress (no Bright Data proxy)",
                            domain, retry_reason,
                        )
                        context, pg = await self._retry_direct(
                            context, ua, url, goto_kwargs, domain
                        )
                yield pg
            finally:
                try:
                    await context.close()
                except Exception:  # noqa: BLE001
                    pass
