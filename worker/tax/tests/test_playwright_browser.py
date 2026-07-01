"""Bright Data proxy-tunnel failure fallback (browser.py).

When the FIRST navigation to a domain fails at the proxy TUNNEL level —
the exact shape of Bright Data's "Government website" compliance block
(policy_20000, applies regardless of KYC status) or an intermittent
proxy-peer failure — Browser.page(url=...) must retry once via direct
Cloud Run egress instead of failing the whole row. A plain navigation
timeout must NOT trigger this: that usually means the target site itself
is slow or down, and retrying without the proxy would just reintroduce
the Cloudflare-block problem the proxy exists to solve.
"""

from __future__ import annotations

import asyncio

import pytest

from pontus_tax.config import Config
from pontus_tax.playwright_engine.browser import Browser


class _FakePage:
    def __init__(self, goto_error: Exception | None):
        self._goto_error = goto_error
        self.goto_calls: list[str] = []

    async def goto(self, url, **kwargs):
        self.goto_calls.append(url)
        if self._goto_error is not None:
            raise self._goto_error

    def set_default_timeout(self, ms):
        pass


class _FakeContext:
    def __init__(self, use_proxy: bool, goto_error: Exception | None):
        self.use_proxy = use_proxy
        self._goto_error = goto_error
        self.closed = False
        self.page: _FakePage | None = None

    async def route(self, pattern, handler):
        pass

    async def new_page(self):
        self.page = _FakePage(self._goto_error)
        return self.page

    async def close(self):
        self.closed = True


class _FakeBrowser:
    """Stands in for Playwright's real Browser. `new_context` records
    whether a `proxy` kwarg was passed. The FIRST context created fails
    its goto with `first_goto_error`; every context after that succeeds
    — mirroring "the proxied tunnel fails, a proxy-less retry works"."""

    def __init__(self, first_goto_error: Exception | None):
        self.first_goto_error = first_goto_error
        self.contexts: list[_FakeContext] = []

    async def new_context(self, **kwargs):
        use_proxy = "proxy" in kwargs
        error = self.first_goto_error if not self.contexts else None
        ctx = _FakeContext(use_proxy, error)
        self.contexts.append(ctx)
        return ctx


def _wire_fake_browser(browser: Browser, fake: _FakeBrowser) -> None:
    async def _fake_ensure_started():
        browser._browser = fake

    browser._ensure_started = _fake_ensure_started  # type: ignore[method-assign]


def _bright_data_config() -> Config:
    return Config(
        bright_data_customer_id="cust",
        bright_data_zone="zone",
        bright_data_zone_password="pw",
    )


def _disabled_config() -> Config:
    return Config(
        bright_data_customer_id=None,
        bright_data_zone=None,
        bright_data_zone_password=None,
    )


def test_proxy_tunnel_failure_falls_back_to_direct_egress():
    cfg = _bright_data_config()
    browser = Browser(cfg)
    fake = _FakeBrowser(Exception("net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/"))
    _wire_fake_browser(browser, fake)

    async def run():
        async with browser.page("example.com", url="https://example.com/") as page:
            return page

    page = asyncio.run(run())

    assert len(fake.contexts) == 2, "should open a second context after the tunnel failure"
    assert fake.contexts[0].use_proxy is True
    assert fake.contexts[1].use_proxy is False, "the retry must go out with no proxy at all"
    assert fake.contexts[0].closed is True, "the failed proxied context must not leak"
    assert page is fake.contexts[1].page


def test_plain_timeout_does_not_fall_back():
    cfg = _bright_data_config()
    browser = Browser(cfg)
    fake = _FakeBrowser(Exception("Timeout 45000ms exceeded."))
    _wire_fake_browser(browser, fake)

    async def run():
        async with browser.page("example.com", url="https://example.com/"):
            pass

    with pytest.raises(Exception, match="Timeout"):
        asyncio.run(run())

    assert len(fake.contexts) == 1, "a non-proxy-tunnel error must not trigger a retry"


def test_no_fallback_when_bright_data_disabled():
    cfg = _disabled_config()
    browser = Browser(cfg)
    fake = _FakeBrowser(Exception("net::ERR_TUNNEL_CONNECTION_FAILED"))
    _wire_fake_browser(browser, fake)

    async def run():
        async with browser.page("example.com", url="https://example.com/"):
            pass

    with pytest.raises(Exception, match="ERR_TUNNEL_CONNECTION_FAILED"):
        asyncio.run(run())

    assert len(fake.contexts) == 1, "with no proxy configured there is nothing to fall back from"


def test_direct_retry_also_failing_propagates():
    cfg = _bright_data_config()
    browser = Browser(cfg)

    class _AlwaysFailBrowser(_FakeBrowser):
        async def new_context(self, **kwargs):
            use_proxy = "proxy" in kwargs
            ctx = _FakeContext(use_proxy, self.first_goto_error)
            self.contexts.append(ctx)
            return ctx

    fake = _AlwaysFailBrowser(Exception("net::ERR_TUNNEL_CONNECTION_FAILED"))
    _wire_fake_browser(browser, fake)

    async def run():
        async with browser.page("example.com", url="https://example.com/"):
            pass

    with pytest.raises(Exception, match="ERR_TUNNEL_CONNECTION_FAILED"):
        asyncio.run(run())

    assert len(fake.contexts) == 2, "one proxied attempt + one direct retry, then give up"
    assert all(ctx.closed for ctx in fake.contexts), "no context should leak even on failure"
