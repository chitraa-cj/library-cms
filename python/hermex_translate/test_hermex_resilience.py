#!/usr/bin/env python3
"""Tests for the three resilience fixes in translate_cli.

No Chrome, no Gemini, no network: the browser is a fake object and selenium is
stubbed, so these run anywhere including CI.

  A  nested Singleton cleanup   — locks are removed from <data_dir>/chrome_profile,
                                  which is where Chrome actually keeps them
  B  cross-process flock        — a second process cannot drive the same profile
  C  transient -> fresh chat    — a canned backend error starts a NEW conversation
                                  instead of refreshing the failed one
  E  normal path unchanged      — a clean answer triggers no recovery at all

Run:  npm run test:hermex-resilience
      python3 python/hermex_translate/test_hermex_resilience.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent


def _stub_selenium() -> None:
    """translate_cli imports selenium lazily, inside functions — stub it out."""
    if "selenium" in sys.modules:
        return
    for name in ("selenium", "selenium.webdriver", "selenium.webdriver.common"):
        sys.modules.setdefault(name, types.ModuleType(name))
    by = types.ModuleType("selenium.webdriver.common.by")
    setattr(by, "By", type("By", (), {"XPATH": "xpath", "TAG_NAME": "tag name", "CSS_SELECTOR": "css"}))
    keys = types.ModuleType("selenium.webdriver.common.keys")
    setattr(keys, "Keys", type("Keys", (), {"ESCAPE": "", "ENTER": ""}))
    support = types.ModuleType("selenium.webdriver.support")
    ec = types.ModuleType("selenium.webdriver.support.expected_conditions")
    setattr(ec, "element_to_be_clickable", lambda *a, **k: (lambda d: True))
    setattr(ec, "presence_of_element_located", lambda *a, **k: (lambda d: True))
    ui = types.ModuleType("selenium.webdriver.support.ui")

    class _Wait:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        def until(self, *a: Any, **k: Any) -> Any:
            raise RuntimeError("no element in the stub")

    setattr(ui, "WebDriverWait", _Wait)
    sys.modules["selenium.webdriver.common.by"] = by
    sys.modules["selenium.webdriver.common.keys"] = keys
    sys.modules["selenium.webdriver.support"] = support
    sys.modules["selenium.webdriver.support.expected_conditions"] = ec
    sys.modules["selenium.webdriver.support.ui"] = ui


_stub_selenium()
sys.path.insert(0, str(HERE))

import translate_cli as tc  # noqa: E402

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


print("\nhermex resilience")

# ── A. the Singleton locks Chrome actually writes ───────────────────────────
print("\n A. nested Chrome profile cleanup")
with tempfile.TemporaryDirectory() as tmp:
    outer = Path(tmp) / "chrome-profile"
    nested = outer / "chrome_profile"
    nested.mkdir(parents=True)
    outside = Path(tmp) / "someone-elses-profile"
    outside.mkdir()

    for d in (outer, nested, outside):
        for lock in tc._SINGLETON_FILES:
            (d / lock).write_text("")
    keep = nested / "Cookies"
    keep.write_text("do not touch")

    old_env = {k: os.environ.get(k) for k in ("HERMEX_CHROME_PROFILE", "HERMEX_CHROME_PROFILE_DIR", "HERMEX_CHROME_PROFILE_MARKER")}
    os.environ["HERMEX_CHROME_PROFILE"] = str(outer)
    os.environ.pop("HERMEX_CHROME_PROFILE_DIR", None)
    # Keep pkill from touching anything on the machine running the tests.
    os.environ["HERMEX_CHROME_PROFILE_MARKER"] = ""

    dirs = tc._profile_lock_dirs()
    check("both levels are considered", dirs == [str(outer), str(nested)], str(dirs))

    real_sleep, tc.time.sleep = tc.time.sleep, lambda *_: None
    real_platform = sys.platform
    try:
        # Skip the pkill branch entirely: this test is about the lock files.
        sys.platform = "test-no-pkill"  # type: ignore[misc]
        tc._cleanup_stale_chrome()
    finally:
        sys.platform = real_platform  # type: ignore[misc]
        tc.time.sleep = real_sleep

    check("nested locks removed", not any((nested / f).exists() for f in tc._SINGLETON_FILES))
    check("outer locks removed", not any((outer / f).exists() for f in tc._SINGLETON_FILES))
    check(
        "a profile outside ours is untouched",
        all((outside / f).exists() for f in tc._SINGLETON_FILES),
    )
    check("non-lock files in the profile survive", keep.read_text() == "do not touch")

    for k, v in old_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ── B. one Hermex process per profile ───────────────────────────────────────
print("\n B. cross-process single-flight lock")
with tempfile.TemporaryDirectory() as tmp:
    lock_file = str(Path(tmp) / ".hermex.lock")

    holder_src = f"""
import sys, time
sys.path.insert(0, {str(HERE)!r})
sys.argv = ["holder"]
import types
for name in ("selenium", "selenium.webdriver", "selenium.webdriver.common"):
    sys.modules.setdefault(name, types.ModuleType(name))
by = types.ModuleType("selenium.webdriver.common.by"); by.By = object
keys = types.ModuleType("selenium.webdriver.common.keys"); keys.Keys = object
sys.modules["selenium.webdriver.common.by"] = by
sys.modules["selenium.webdriver.common.keys"] = keys
import translate_cli as tc
lock = tc._ProfileLock({lock_file!r})
lock.acquire()
print("ACQUIRED", flush=True)
sys.stdin.readline()          # hold it until the parent says stop
lock.release()
print("RELEASED", flush=True)
"""
    holder = subprocess.Popen(
        [sys.executable, "-c", holder_src],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    first_line = holder.stdout.readline().strip() if holder.stdout else ""
    check("first process acquires the lock", first_line == "ACQUIRED", repr(first_line))

    second = tc._ProfileLock(lock_file)
    try:
        second.acquire()
        check("second process is refused", False, "it acquired the lock too")
        second.release()
    except tc.HermexBusyError as e:
        check("second process is refused", True)
        check("the message says what happened", "already running" in str(e), str(e)[:80])
        check("the message is actionable", "ps -eo" in str(e))

    check("the lock file is NOT deleted while held", Path(lock_file).exists())

    if holder.stdin:
        holder.stdin.write("\n")
        holder.stdin.flush()
    holder.wait(timeout=20)

    after = tc._ProfileLock(lock_file)
    try:
        after.acquire()
        check("lock is free once the holder exits", True)
    except tc.HermexBusyError:
        check("lock is free once the holder exits", False, "still locked")
    finally:
        after.release()

    # An exception inside the guarded body must still release the lock.
    class Boom(RuntimeError):
        pass

    try:
        with tc._ProfileLock(lock_file):
            raise Boom("failure inside the locked section")
    except Boom:
        pass
    retry = tc._ProfileLock(lock_file)
    try:
        retry.acquire()
        check("an exception still releases the lock", True)
    except tc.HermexBusyError:
        check("an exception still releases the lock", False)
    finally:
        retry.release()

    # run_translate() is the entry point every caller shares, so the guard must be
    # there and not in one of the branches.
    os.environ["HERMEX_LOCK_FILE"] = lock_file
    blocker = tc._ProfileLock(lock_file)
    blocker.acquire()
    try:
        tc.run_translate({"sourceText": "x", "targetLanguages": ["Tamil"]})
        check("run_translate refuses when the profile is busy", False, "it proceeded")
    except tc.HermexBusyError:
        check("run_translate refuses when the profile is busy", True)
    except Exception as e:
        check("run_translate refuses when the profile is busy", False, type(e).__name__)
    finally:
        blocker.release()
        os.environ.pop("HERMEX_LOCK_FILE", None)

# ── C / E. transient error recovery vs the normal path ──────────────────────
print("\n C. a transient backend error starts a FRESH chat")


class FakeGemini:
    def __init__(self) -> None:
        self.driver = types.SimpleNamespace(current_url="https://gemini.google.com/app")

    def sleep(self, _t: float) -> None:
        pass


class Reply:
    def __init__(self, text: str) -> None:
        self.text = text


def run_recovery(replies: list[Any]) -> dict[str, Any]:
    """Drive _gemini_query_with_recovery against scripted replies."""
    calls = {"fresh": 0, "refresh": 0, "sends": 0, "slept": []}
    pending = list(replies)

    saved = {
        name: getattr(tc, name)
        for name in (
            "_dismiss_gemini_overlays",
            "_gemini_send_message",
            "_wait_idle_or_stall",
            "_gemini_fetch_response",
            "_start_fresh_gemini_chat",
            "_recover_browser_session",
            "_transient_backoff_sec",
        )
    }
    real_sleep = tc.time.sleep
    try:
        tc._dismiss_gemini_overlays = lambda g: None
        tc._wait_idle_or_stall = lambda *a, **k: None
        tc._transient_backoff_sec = lambda attempt=1: 0

        def send(_g: Any, _msg: str, *, paste: bool) -> None:
            calls["sends"] += 1

        def fetch(_g: Any) -> Reply:
            nxt = pending.pop(0) if pending else ""
            if nxt is EMPTY:
                # What the real _gemini_fetch_response does when the model answer
                # never materialises — it raises, it does not return a blank Reply.
                raise RuntimeError("Response contained neither text nor image.")
            return Reply(nxt)

        tc._gemini_send_message = send
        tc._gemini_fetch_response = fetch
        tc._start_fresh_gemini_chat = lambda g: calls.__setitem__("fresh", calls["fresh"] + 1)
        tc._recover_browser_session = lambda g: calls.__setitem__("refresh", calls["refresh"] + 1)
        tc.time.sleep = lambda s: calls["slept"].append(s)

        try:
            msg = tc._gemini_query_with_recovery(
                FakeGemini(), "prompt", source_text="src", timeout=60
            )
            calls["result"] = getattr(msg, "text", "")
            calls["raised"] = None
        except Exception as e:
            calls["result"] = None
            calls["raised"] = type(e).__name__
        return calls
    finally:
        for name, fn in saved.items():
            setattr(tc, name, fn)
        tc.time.sleep = real_sleep


EMPTY = object()  # scripted "the answer never arrived" (fetch raises, as in production)
CANNED = "I seem to be encountering an error. Can I try something else for you?"
GOOD = "===LANGUAGE: Tamil===\nஒளி உண்டாகுக."

r = run_recovery([CANNED, GOOD])
check("the canned error is retried and then succeeds", r["result"] == GOOD, str(r["result"])[:40])
check("a FRESH chat was started", r["fresh"] == 1, f"fresh={r['fresh']}")
check("refresh_page/recover was NOT used for it", r["refresh"] == 0, f"refresh={r['refresh']}")
check("the prompt was sent twice", r["sends"] == 2, f"sends={r['sends']}")
check("the backoff still ran", r["slept"] == [0], str(r["slept"]))

r = run_recovery([CANNED, CANNED, CANNED])
check("three canned errors give up", r["raised"] == "GeminiTransientError", str(r["raised"]))
check("a fresh chat per failed attempt (2)", r["fresh"] == 2, f"fresh={r['fresh']}")
check("never falls back to a plain refresh", r["refresh"] == 0, f"refresh={r['refresh']}")

print("\n C2. a non-transient failure still uses the old refresh path")
r = run_recovery([EMPTY, GOOD])  # fetch raises -> _is_empty_response_error
check("empty reply recovers via refresh", r["result"] == GOOD, str(r["result"])[:40])
check("refresh was used", r["refresh"] == 1, f"refresh={r['refresh']}")
check("no fresh chat for a non-transient error", r["fresh"] == 0, f"fresh={r['fresh']}")

print("\n E. the normal successful path is untouched")
r = run_recovery([GOOD])
check("one send, one answer", r["sends"] == 1 and r["result"] == GOOD)
check("no recovery of any kind", r["fresh"] == 0 and r["refresh"] == 0)
check("no backoff", r["slept"] == [], str(r["slept"]))

print("\n D. the circuit-breaker marker")
check(
    "the abort marker is a distinct token",
    tc.TRANSIENT_ABORT_MARKER == "GEMINI_BACKEND_ERROR_LIMIT",
    tc.TRANSIENT_ABORT_MARKER,
)
check(
    "the marker does not contain 'hermex'",
    "hermex" not in tc.TRANSIENT_ABORT_MARKER.lower(),
)

print(f"\n{PASS} passed, {len(FAILURES)} failed")
for f in FAILURES:
    print(f"  - {f}")
sys.exit(1 if FAILURES else 0)
