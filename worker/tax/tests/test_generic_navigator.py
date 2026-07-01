"""GenericNavigator: JSON extraction robustness and new-tab handling.

Both bugs were caught by a real production run (2026-07-01), not
invented: the model occasionally writes a sentence of reasoning before
its JSON (bare, or fenced mid-string), and one portal (Pinellas) opens
its "View an Account" link in a new tab, which repeatedly fooled the
navigator into re-clicking the same stale link because the ORIGINAL
page's DOM never changed.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import pytest

from pontus_tax.playwright_engine.generic_navigator import (
    GenericNavigator,
    _extract_json_object,
)
from pontus_tax.playwright_engine.recipes import RowContext


# -- _extract_json_object ---------------------------------------------------


def test_extract_plain_json():
    assert _extract_json_object('{"action": "done", "ref": null}') == {
        "action": "done",
        "ref": None,
    }


def test_extract_json_with_leading_prose_no_fence():
    raw = (
        'The page shows Tax Details for parcel 001-201-011-000.\n\n'
        '{"action": "done", "ref": null, "value": null, "reason": "paid"}'
    )
    assert _extract_json_object(raw) == {
        "action": "done",
        "ref": None,
        "value": None,
        "reason": "paid",
    }


def test_extract_json_with_leading_prose_and_fence():
    raw = (
        "The first result matches; I'll click View Details.\n\n"
        "```json\n"
        '{"action": "click", "ref": "e152", "value": null, "reason": "match"}\n'
        "```"
    )
    assert _extract_json_object(raw) == {
        "action": "click",
        "ref": "e152",
        "value": None,
        "reason": "match",
    }


def test_extract_returns_none_for_pure_prose():
    assert _extract_json_object("I am not sure what to do here.") is None


# -- new-tab handling ---------------------------------------------------


class _FakeLocator:
    def __init__(self, page: "_FakePage", ref: str):
        self._page = page
        self._ref = ref

    async def inner_text(self, timeout=None):
        return self._page.body_text

    async def click(self, timeout=None):
        self._page.on_click(self._ref)

    async def fill(self, value):
        pass

    async def press(self, key):
        pass


class _FakeContext:
    def __init__(self):
        self._handlers: list[Any] = []

    def on(self, event: str, handler) -> None:
        if event == "page":
            self._handlers.append(handler)

    def open_new_page(self, page: "_FakePage") -> None:
        for h in self._handlers:
            h(page)


class _FakePage:
    """A page whose body text and snapshot never change on its own —
    only `on_click` (simulating the test's scripted behavior) or
    switching to a different _FakePage changes what the navigator sees.
    """

    def __init__(self, context: _FakeContext, body_text: str, on_click=None):
        self.context = context
        self.body_text = body_text
        self.url = "https://example.com/fake"
        self._on_click = on_click or (lambda ref: None)

    def on_click(self, ref: str) -> None:
        self._on_click(ref)

    def locator(self, selector: str):
        ref = selector.split("=", 1)[-1] if "aria-ref=" in selector else selector
        return _FakeLocator(self, ref)

    async def aria_snapshot(self, mode=None):
        return f"[ref=e1] link 'View an Account' -> {self.body_text}"

    async def wait_for_load_state(self, state, timeout=None):
        pass

    async def wait_for_timeout(self, ms):
        pass

    @property
    def frames(self):
        return [self]


@asynccontextmanager
async def _fake_browser_page(initial_page: _FakePage):
    yield initial_page


class _FakeBrowser:
    def __init__(self, initial_page: _FakePage):
        self._initial_page = initial_page

    def page(self, domain, *, url=None, goto_kwargs=None):
        return _fake_browser_page(self._initial_page)


def _row() -> RowContext:
    return RowContext(
        url="https://example.com/",
        address=None,
        owner_entity=None,
        account_candidates=["R444958"],
        tax_year="2025",
        county=None,
        state=None,
    )


def test_click_opening_a_new_tab_switches_the_active_page(monkeypatch):
    """The old page's DOM never changes after the click (mirrors a
    target="_blank" link). Without the fix, the navigator would keep
    re-deciding the same click forever; with it, the SECOND decision
    must be evaluated against the NEW tab's content, not the old one.
    """
    context = _FakeContext()
    new_page = _FakePage(context, body_text="Account R444958: PAID $0.00")

    def on_click(ref):
        context.open_new_page(new_page)

    old_page = _FakePage(context, body_text="View an Account", on_click=on_click)

    seen_bodies: list[str] = []

    decisions = iter([
        {"action": "click", "ref": "e1", "value": None, "reason": "open account"},
        {"action": "done", "ref": None, "value": None, "reason": "shows PAID"},
    ])

    async def fake_decide(self, snapshot, row, step):
        seen_bodies.append(snapshot)
        return next(decisions)

    monkeypatch.setattr(GenericNavigator, "_decide", fake_decide)

    nav = GenericNavigator.__new__(GenericNavigator)  # skip __init__ (no API key needed)
    fake_browser = _FakeBrowser(old_page)

    result = asyncio.run(nav.fetch(fake_browser, "https://example.com/", _row()))

    assert "View an Account" in seen_bodies[0]
    assert "PAID" in seen_bodies[1], "second decision must see the NEW tab, not the stale old page"
    assert result.page_text == "Account R444958: PAID $0.00"
    assert result.final_url == new_page.url


def test_click_with_no_new_tab_keeps_the_same_page(monkeypatch):
    context = _FakeContext()
    page = _FakePage(context, body_text="Account R444958: PAID $0.00")

    decisions = iter([
        {"action": "done", "ref": None, "value": None, "reason": "already shows the bill"},
    ])

    async def fake_decide(self, snapshot, row, step):
        return next(decisions)

    monkeypatch.setattr(GenericNavigator, "_decide", fake_decide)

    nav = GenericNavigator.__new__(GenericNavigator)
    fake_browser = _FakeBrowser(page)

    result = asyncio.run(nav.fetch(fake_browser, "https://example.com/", _row()))

    assert result.final_url == page.url
