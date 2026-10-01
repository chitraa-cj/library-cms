#!/usr/bin/env python3
"""Deterministic tests for the pipeline's Gemini overlay handling.

No Chrome, no Gemini, no network: `_dismiss_gemini_overlays()` only talks to a
WebDriver, so the driver is faked. That makes the rules it must obey testable on
any machine, including the ones that matter most:

    * the location prompt's TEXT-labelled "Dismiss" button is clicked
    * "Use precise location" is NEVER clicked
    * nothing is clicked when no prompt is on screen
    * a button that vanishes mid-click is not an error

Run:  npm run test:hermex-overlay
      python3 python/hermex_translate/test_overlay_dismissal.py
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any


def _stub_selenium() -> None:
    """Make selenium importable without installing it.

    `_dismiss_gemini_overlays` imports `By` and `Keys` lazily, inside the function,
    and only ever passes them back to the driver — which is faked here. Stubbing
    them keeps this suite runnable on a machine (or CI job) that has no browser
    stack at all, which is the whole point of a deterministic test. A real selenium
    on the path is left alone.
    """
    if "selenium" in sys.modules:
        return
    for name in ("selenium", "selenium.webdriver", "selenium.webdriver.common"):
        sys.modules.setdefault(name, types.ModuleType(name))
    by = types.ModuleType("selenium.webdriver.common.by")
    setattr(by, "By", type("By", (), {"XPATH": "xpath", "TAG_NAME": "tag name"}))
    keys = types.ModuleType("selenium.webdriver.common.keys")
    setattr(keys, "Keys", type("Keys", (), {"ESCAPE": "\ue00c", "ENTER": "\ue007"}))
    sys.modules["selenium.webdriver.common.by"] = by
    sys.modules["selenium.webdriver.common.keys"] = keys


_stub_selenium()
sys.path.insert(0, str(Path(__file__).resolve().parent))

import translate_cli  # noqa: E402

PASS = 0
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS
    if ok:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{' — ' + detail if detail else ''}")
        print(f"  FAIL {name}{' — ' + detail if detail else ''}")


class FakeButton:
    """A button as Selenium would hand it to us."""

    def __init__(
        self,
        text: str = "",
        aria_label: str | None = None,
        displayed: bool = True,
        enabled: bool = True,
        raises: Exception | None = None,
    ) -> None:
        self.text = text
        self.aria_label = aria_label
        self._displayed = displayed
        self._enabled = enabled
        self._raises = raises
        self.clicks = 0

    def is_displayed(self) -> bool:
        return self._displayed

    def is_enabled(self) -> bool:
        return self._enabled

    def click(self) -> None:
        if self._raises is not None:
            raise self._raises
        self.clicks += 1

    # The accessible name the production XPath matches on.
    def label(self) -> str:
        return (self.aria_label or self.text or "").strip().lower()


class FakeDriver:
    """Evaluates just enough of the production XPath to be faithful.

    The real XPath matches an element whose normalized, case-folded text OR
    aria-label equals one of the decline labels. Rather than implement XPath, the
    label being searched for is recovered from the expression and compared the same
    way — so a change that loosened the match to a substring would fail these tests.
    """

    def __init__(self, buttons: list[FakeButton]) -> None:
        self.buttons = buttons
        self.scripts: list[str] = []
        self.escapes = 0

    def execute_script(self, script: str, *args: Any) -> None:
        self.scripts.append(script)

    def find_elements(self, by: Any, xpath: str) -> list[FakeButton]:
        wanted = [
            label
            for label in translate_cli._DISMISS_BUTTON_LABELS
            if f"='{label}'" in xpath
        ]
        if not wanted:
            return []
        return [b for b in self.buttons if b.label() in wanted]

    def find_element(self, by: Any, value: Any) -> Any:
        driver = self

        class Body:
            def send_keys(self, *_: Any) -> None:
                driver.escapes += 1

        return Body()


class FakeGemini:
    def __init__(self, buttons: list[FakeButton]) -> None:
        self.driver = FakeDriver(buttons)


print("\npipeline overlay dismissal")

# ── the actual failure this fixes ────────────────────────────────────────────
print("\n Gemini location prompt")
dismiss = FakeButton(text="Dismiss")  # no aria-label — the whole point
precise = FakeButton(text="Use precise location")
gemini = FakeGemini([dismiss, precise])
translate_cli._dismiss_gemini_overlays(gemini)
check("the text-labelled Dismiss button is clicked", dismiss.clicks == 1, f"clicks={dismiss.clicks}")
check("'Use precise location' is NEVER clicked", precise.clicks == 0, f"clicks={precise.clicks}")

# ── it must not become click-anything ────────────────────────────────────────
print("\n nothing else is touched")
unrelated = [
    FakeButton(text="Use precise location"),
    FakeButton(text="Allow"),
    FakeButton(text="Send message", aria_label="Send message"),
    FakeButton(text="Share"),
    FakeButton(text="Delete chat"),
    FakeButton(text="Dismiss all notifications"),  # substring — must NOT match
]
gemini = FakeGemini(unrelated)
translate_cli._dismiss_gemini_overlays(gemini)
check("no unrelated button is clicked", all(b.clicks == 0 for b in unrelated),
      ", ".join(f"{b.text}={b.clicks}" for b in unrelated if b.clicks))

# ── harmless when there is no popup ──────────────────────────────────────────
print("\n no popup present")
gemini = FakeGemini([])
translate_cli._dismiss_gemini_overlays(gemini)
check("runs clean with no buttons at all", True)
check("the existing JS overlay pass still runs", len(gemini.driver.scripts) == 1,
      f"scripts={len(gemini.driver.scripts)}")
check("the existing ESCAPE press still happens", gemini.driver.escapes == 1)

# ── the other accepted labels, and aria-label form ───────────────────────────
print("\n label handling")
for label in ("No thanks", "Not now", "Maybe later", "DISMISS", "  dismiss  "):
    b = FakeButton(text=label)
    translate_cli._dismiss_gemini_overlays(FakeGemini([b]))
    check(f"{label!r} is treated as a decline", b.clicks == 1, f"clicks={b.clicks}")

aria_only = FakeButton(text="", aria_label="Dismiss")
translate_cli._dismiss_gemini_overlays(FakeGemini([aria_only]))
check("an aria-label-only Dismiss still works", aria_only.clicks == 1)

# ── hidden / disabled / exploding buttons ────────────────────────────────────
print("\n defensive cases")
hidden = FakeButton(text="Dismiss", displayed=False)
disabled = FakeButton(text="Dismiss", enabled=False)
translate_cli._dismiss_gemini_overlays(FakeGemini([hidden, disabled]))
check("a hidden Dismiss is skipped", hidden.clicks == 0)
check("a disabled Dismiss is skipped", disabled.clicks == 0)

exploding = FakeButton(text="Dismiss", raises=RuntimeError("stale element"))
survivor = FakeButton(text="No thanks")
gemini = FakeGemini([exploding, survivor])
try:
    translate_cli._dismiss_gemini_overlays(gemini)
    check("a button that vanishes mid-click is not an error", True)
except Exception as e:  # pragma: no cover - this is the failure being guarded
    check("a button that vanishes mid-click is not an error", False, repr(e))
check("and the next prompt is still dismissed", survivor.clicks == 1)


class ExplodingDriver(FakeDriver):
    def find_elements(self, by: Any, xpath: str) -> list[FakeButton]:
        raise RuntimeError("driver went away")


gemini = FakeGemini([])
gemini.driver = ExplodingDriver([])
try:
    translate_cli._dismiss_gemini_overlays(gemini)
    check("a failing find_elements never propagates", True)
except Exception as e:  # pragma: no cover
    check("a failing find_elements never propagates", False, repr(e))

print(f"\n{PASS} passed, {len(FAILURES)} failed")
for f in FAILURES:
    print(f"  - {f}")
sys.exit(1 if FAILURES else 0)
