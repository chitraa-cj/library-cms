#!/usr/bin/env python3
"""Isolation between translation and the OCR → Grantha prompt session.

No Chrome, no Gemini, no network.

  * translate_cli._cleanup_stale_chrome() is UNCHANGED for translation (the bare
    chromedriver sweep still runs) and, with HERMEX_CLEANUP_SCOPE=profile, touches only
    processes naming the configured profile — so the structure workflow can never kill
    translation's browser;
  * the real prompt_session.py, run against a stub of the browser layer:
      - stdout carries protocol lines only, even when the browser layer prints;
      - every request runs in a fresh chat;
      - it refuses to start without the scoped-cleanup flag or a profile;
      - a logged-out profile is a startup failure with reason "login";
      - SIGTERM (Node's timeout/cancel) still closes the browser and releases the lock.

Run:  npm run test:hermex-isolation
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
PASS = 0
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{' — ' + detail if detail else ''}")
        print(f"  FAIL {name}{' — ' + detail if detail else ''}")


# ── 1. translate_cli cleanup scope ───────────────────────────────────────────
print("\ntranslate_cli browser cleanup")
sys.path.insert(0, str(HERE))
import translate_cli  # noqa: E402

calls: list[list[str]] = []
real_run, real_sleep = subprocess.run, time.sleep
subprocess.run = lambda args, **kw: calls.append(list(args)) or types.SimpleNamespace(returncode=1)  # type: ignore[assignment]
time.sleep = lambda s: None  # type: ignore[assignment]
tmp = Path(tempfile.mkdtemp(prefix="hermex-iso-"))
try:
    os.environ["HERMEX_CHROME_PROFILE"] = str(tmp / "translation-profile")
    os.environ.pop("HERMEX_CHROME_PROFILE_DIR", None)
    os.environ.pop("HERMEX_CHROME_PROFILE_MARKER", None)
    os.environ.pop("HERMEX_CLEANUP_SCOPE", None)
    translate_cli._cleanup_stale_chrome()
    patterns = [c[-1] for c in calls if c[:2] == ["pkill", "-f"]]
    if sys.platform in ("darwin", "linux"):
        check("translation (unset scope) still sweeps every chromedriver, as before", "chromedriver" in patterns, str(patterns))
        check("…and its own profile", str(tmp / "translation-profile") in patterns)

        calls.clear()
        os.environ["HERMEX_CHROME_PROFILE"] = str(tmp / "structure-profile")
        os.environ["HERMEX_CLEANUP_SCOPE"] = "profile"
        translate_cli._cleanup_stale_chrome()
        scoped = [c[-1] for c in calls if c[:2] == ["pkill", "-f"]]
        check("a scoped cleanup kills only processes naming its own profile", scoped == [str(tmp / "structure-profile")], str(scoped))
        check("…never a bare 'chromedriver' (translation's driver)", "chromedriver" not in scoped)
    else:  # pragma: no cover
        check("cleanup scope (posix only)", True)
finally:
    subprocess.run, time.sleep = real_run, real_sleep  # type: ignore[assignment]
    os.environ.pop("HERMEX_CLEANUP_SCOPE", None)

# ── 2. prompt_session.py against a stub browser layer ─────────────────────────
print("\nprompt_session.py protocol")
work = tmp / "session"
work.mkdir()
shutil.copy(HERE / "prompt_session.py", work / "prompt_session.py")
log_path = work / "browser.log"
(work / "translate_cli.py").write_text(
    f'''
import os, time
LOG = {str(log_path)!r}
def _w(line):
    with open(LOG, "a") as f: f.write(line + "\\n")
class _ProfileLock:
    def __init__(self, path): self.path = path
    def acquire(self): _w("lock " + self.path)
    def release(self): _w("unlock")
def _lock_path(): return os.environ.get("HERMEX_LOCK_FILE", "")
class _G:
    is_logged_in = os.environ.get("STUB_LOGGED_IN", "1") == "1"
def _open_gemini_browser(headless):
    print("selenium noise on stdout")  # must never reach the protocol channel
    _w("open headless=%s profile=%s" % (headless, os.environ.get("HERMEX_CHROME_PROFILE")))
    return _G()
def _start_fresh_gemini_chat(g): _w("fresh-chat")
def _gemini_query_with_recovery(g, prompt, source_text, timeout):
    print("more noise")
    if prompt == "hang": time.sleep(30)
    class A: text = "reply:" + prompt
    return A()
def _close_gemini_browser(g): _w("close")
'''
)


def start(**env_over: str) -> subprocess.Popen:
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMEX_")}
    env.update(
        HERMEX_CLEANUP_SCOPE="profile",
        HERMEX_CHROME_PROFILE=str(tmp / "structure-profile"),
        HERMEX_LOCK_FILE=str(tmp / "structure-profile.lock"),
        HERMEX_SESSION_HEADLESS="1",
    )
    env.update(env_over)
    return subprocess.Popen(
        [sys.executable, "-I", str(work / "prompt_session.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )


def readline(p: subprocess.Popen) -> dict:
    line = p.stdout.readline()  # type: ignore[union-attr]
    return json.loads(line)


log_path.write_text("")
p = start()
ready = readline(p)
check("it announces readiness on stdout", ready == {"type": "ready", "loggedIn": True}, str(ready))
for i, prompt in enumerate(["first", "second"]):
    p.stdin.write(json.dumps({"id": f"id-{i}", "op": "ask", "prompt": prompt, "timeoutSec": 5}) + "\n")  # type: ignore[union-attr]
    p.stdin.flush()  # type: ignore[union-attr]
    msg = readline(p)
    check(f"answer {i + 1} carries its own correlation id", msg == {"id": f"id-{i}", "ok": True, "text": f"reply:{prompt}"}, str(msg))
p.stdin.write(json.dumps({"op": "close"}) + "\n")  # type: ignore[union-attr]
p.stdin.flush()  # type: ignore[union-attr]
out, err = p.communicate(timeout=10)
check("stdout held protocol lines only (library prints went to stderr)", out.strip() == "" and "selenium noise" in err)
log = log_path.read_text().splitlines()
check("it opened ITS profile, headless as asked", any(l == f"open headless=True profile={tmp / 'structure-profile'}" for l in log), str(log))
check("it took its own lock", f"lock {tmp / 'structure-profile.lock'}" in log)
check("every request ran in a fresh chat", log.count("fresh-chat") == 2)
check("close shut the browser and released the lock", log[-2:] == ["close", "unlock"], str(log[-2:]))
check("exit code 0 on a clean close", p.returncode == 0)

p = start(HERMEX_CLEANUP_SCOPE="")
fatal = readline(p)
p.wait(timeout=10)
check("it refuses to run without the scoped-cleanup flag", fatal.get("type") == "fatal" and p.returncode == 2)

p = start(STUB_LOGGED_IN="0")
fatal = readline(p)
p.wait(timeout=10)
check("a logged-out profile is a fatal 'login' at startup", fatal.get("reason") == "login" and "setup-structure" in fatal.get("error", ""))

log_path.write_text("")
p = start()
readline(p)
p.stdin.write(json.dumps({"id": "slow", "op": "ask", "prompt": "hang"}) + "\n")  # type: ignore[union-attr]
p.stdin.flush()  # type: ignore[union-attr]
time.sleep(0.5)
p.send_signal(signal.SIGTERM)
p.wait(timeout=10)
log = log_path.read_text().splitlines()
check("SIGTERM mid-request still closes the browser and releases the lock", log[-2:] == ["close", "unlock"], str(log))

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {len(FAILURES)} failed")
for f in FAILURES:
    print(f"  - {f}")
sys.exit(1 if FAILURES else 0)
