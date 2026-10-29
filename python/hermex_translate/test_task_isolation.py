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
shutil.copy(HERE / "chrome_profile_select.py", work / "chrome_profile_select.py")
# Stand-in for undetected_chromedriver: records the arguments Chrome would get.
(work / "undetected_chromedriver.py").write_text(
    "class ChromeOptions:\n"
    "    def __init__(self): self.arguments = []\n"
    "    def add_argument(self, a): self.arguments.append(a)\n"
)
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
SIGNED_OUT = LOG + ".signed-out"
class _Driver:
    # Gemini's "Sign in" link exists once the test drops the marker file (login expired).
    def find_elements(self, by, sel): return [1] if os.path.exists(SIGNED_OUT) and "Sign in" in sel else []
    @property
    def current_url(self): return os.environ.get("STUB_URL", "https://gemini.google.com/app")
class _G:
    is_logged_in = os.environ.get("STUB_LOGGED_IN", "1") == "1"
    driver = _Driver()
def _open_gemini_browser(headless):
    print("selenium noise on stdout")  # must never reach the protocol channel
    import undetected_chromedriver as uc  # what hermex does when it builds Chrome's options
    _w("open headless=%s profile=%s" % (headless, os.environ.get("HERMEX_CHROME_PROFILE")))
    _w("chrome-args " + "|".join(uc.ChromeOptions().arguments))
    if os.environ.get("STUB_LAUNCH") == "picker":
        raise RuntimeError("Message: session not created: from unknown error: unable to discover open pages")
    return _G()
def _start_fresh_gemini_chat(g): _w("fresh-chat")
def _gemini_query_with_recovery(g, prompt, source_text, timeout, attachments=None):
    print("more noise")
    if prompt == "hang": time.sleep(30)
    if attachments: _w("attach " + ",".join(attachments))
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

# Attachments (OCR) and login expiry mid-session.
log_path.write_text("")
page = tmp / "page.pdf"
page.write_bytes(b"%PDF-1.4")
p = start()
readline(p)
def ask(req: dict) -> dict:
    p.stdin.write(json.dumps({"op": "ask", "timeoutSec": 5, **req}) + "\n")  # type: ignore[union-attr]
    p.stdin.flush()  # type: ignore[union-attr]
    return readline(p)
ok = ask({"id": "a1", "prompt": "ocr", "attachments": [str(page)]})
check("an attached file reaches the Gemini helper", ok.get("ok") is True and f"attach {page}" in log_path.read_text().splitlines(), str(ok))
bad = ask({"id": "a2", "prompt": "ocr", "attachments": ["relative.pdf"]})
check("a relative or missing attachment path is refused, nothing sent", bad.get("reason") == "malformed" and bad.get("id") == "a2")
plain = ask({"id": "a3", "prompt": "no file"})
check("a request without attachments calls the helper exactly as translation does", plain.get("ok") is True and log_path.read_text().count("attach ") == 1)
Path(str(log_path) + ".signed-out").write_text("")
expired = ask({"id": "a4", "prompt": "ocr"})
p.wait(timeout=10)
check("an expired login is reported as 'login' with the fix, never as an answer", expired.get("reason") == "login" and "expired" in expired.get("error", "") and expired.get("ok") is False)
check("…and the session ends so Node stops the job", p.returncode == 4)
check("…closing the browser and releasing the lock", log_path.read_text().splitlines()[-2:] == ["close", "unlock"])

# ── 3. Chrome profile selection, profile picker, leftover browsers ───────────
print("\nChrome profile selection")
import chrome_profile_select as cps  # noqa: E402

udd = tmp / "structure-profile" / "chrome_profile"
udd.mkdir(parents=True)
(udd / "Local State").write_text(json.dumps({"profile": {"info_cache": {
    "Default": {"name": "Your Chrome"},
    "Profile 1": {"name": "xoidlabs.com", "gaia_id": "123", "user_name": "someone@example.com"},
}}}))
listed = cps.read_profiles(str(udd))
check("Local State maps directories to display names and sign-in state",
      listed == [{"directory": "Default", "name": "Your Chrome", "signedIn": False},
                 {"directory": "Profile 1", "name": "xoidlabs.com", "signedIn": True}], str(listed))
check("…without reading out the account's email", "example.com" not in json.dumps(listed) + cps.describe(listed))
check("a profile directory name is accepted", cps.validate_directory(" Profile 1 ") == "Profile 1")
for bad_dir in ("../Default", "/abs", "a/b", "..", ""):
    try:
        cps.validate_directory(bad_dir)
        check(f"a path is refused as a profile directory ({bad_dir!r})", False)
    except ValueError:
        check(f"a path is refused as a profile directory ({bad_dir!r})", True)
for url, kind in [("chrome://profile-picker/", "picker"), ("https://gemini.google.com/app", "gemini"),
                  ("https://accounts.google.com/v3/signin", "login"), ("about:blank", "other"), (None, "other")]:
    check(f"page {url!r} is classified {kind}", cps.classify_url(url) == kind)
clock = [0.0]
seen = iter(["about:blank", "about:blank", "https://gemini.google.com/app"])
check("the readiness wait polls until Gemini loads", cps.wait_for_gemini(lambda: next(seen), timeout=10, sleep=lambda s: clock.__setitem__(0, clock[0] + s), clock=lambda: clock[0]) == "gemini")
clock = [0.0]
check("…and gives up at its timeout on any other page", cps.wait_for_gemini(lambda: "about:blank", timeout=3, sleep=lambda s: clock.__setitem__(0, clock[0] + s), clock=lambda: clock[0]) == "other" and clock[0] >= 3)
check("…and stops at once on the profile picker", cps.wait_for_gemini(lambda: "chrome://profile-picker/", timeout=60, sleep=lambda s: None) == "picker")

class _FakeUc:
    class ChromeOptions:
        def __init__(self): self.arguments = []
        def add_argument(self, a): self.arguments.append(a)
fake = _FakeUc()
cps.install("Profile 1", fake)
cps.install("Profile 1", fake)  # idempotent: no doubled flag
check("install() makes every new Chrome options object open that profile, once",
      fake.ChromeOptions().arguments == ["--profile-directory=Profile 1"], str(fake.ChromeOptions().arguments))

ps_text = "\n".join([
    f"101 /opt/google/chrome/chrome --user-data-dir={udd} --profile-directory=Default",
    f"102 /opt/google/chrome/chrome --type=renderer --user-data-dir={udd}",
    f"103 /opt/google/chrome/chrome --user-data-dir={udd}2",
    f"104 /opt/google/chrome/chrome --user-data-dir={udd}/nested",
    "105 /opt/google/chrome/chrome --user-data-dir=/home/ubuntu/hermex-translation/chrome-profile/chrome_profile",
    "106 python3 prompt_session.py",
])
check("leftover-browser matching takes exactly this user-data dir",
      cps.own_browser_pids(ps_text, str(udd)) == [101, 102], str(cps.own_browser_pids(ps_text, str(udd))))

def spawn_named(arg: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", arg])

# The real session: a directory is selected and reaches Chrome's arguments.
Path(str(log_path) + ".signed-out").unlink(missing_ok=True)  # left by the login-expiry test
log_path.write_text("")
p = start(HERMEX_SESSION_PROFILE_DIRECTORY="Profile 1")
ready = readline(p)
p.stdin.write(json.dumps({"op": "close"}) + "\n")  # type: ignore[union-attr]
p.stdin.flush()  # type: ignore[union-attr]
_, err = p.communicate(timeout=10)
args_line = [l for l in log_path.read_text().splitlines() if l.startswith("chrome-args")]
check("with HERMEX_SESSION_PROFILE_DIRECTORY, Chrome is launched straight into that profile",
      ready.get("type") == "ready" and args_line == ["chrome-args --profile-directory=Profile 1"], f"{ready} {args_line}")
check("…and the choice is logged with the profile list (no email)",
      "profile-directory=Profile 1" in err and 'Profile 1 "xoidlabs.com" (signed in)' in err and "example.com" not in err)

log_path.write_text("")
p = start()
readline(p)
p.stdin.write(json.dumps({"op": "close"}) + "\n")  # type: ignore[union-attr]
p.stdin.flush()  # type: ignore[union-attr]
p.communicate(timeout=10)
check("without it, Chrome's arguments are untouched", [l for l in log_path.read_text().splitlines() if l.startswith("chrome-args")] == ["chrome-args "])

Path(str(log_path) + ".signed-out").write_text("")
p = start()
fatal = readline(p)
p.wait(timeout=10)
check("a profile Gemini shows as signed out at startup is 'login', never 'ready'", fatal.get("reason") == "login")
Path(str(log_path) + ".signed-out").unlink()

p = start(HERMEX_SESSION_PROFILE_DIRECTORY="../Default")
fatal = readline(p)
p.wait(timeout=10)
check("a path given as the profile directory is refused before Chrome starts", fatal.get("reason") == "unavailable" and p.returncode == 2)

p = start(STUB_URL="chrome://profile-picker/")
fatal = readline(p)
p.wait(timeout=10)
check("landing on the profile picker is never 'ready': a clear startup failure",
      fatal.get("type") == "fatal" and fatal.get("reason") == "unavailable"
      and "HERMEX_STRUCTURE_PROFILE_DIRECTORY" in fatal.get("error", "") and "Profile 1" in fatal.get("error", ""), str(fatal))
check("…closing the browser it opened", log_path.read_text().splitlines()[-2:] == ["close", "unlock"])

p = start(STUB_URL="https://accounts.google.com/v3/signin")
fatal = readline(p)
p.wait(timeout=10)
check("a Google sign-in page at startup is 'login'", fatal.get("reason") == "login")

t0 = time.monotonic()
p = start(STUB_URL="about:blank", HERMEX_SESSION_PAGE_TIMEOUT_SEC="1")
fatal = readline(p)
p.wait(timeout=10)
check("a browser that never reaches Gemini fails after the bounded page wait",
      fatal.get("reason") == "chrome" and "gemini.google.com" in fatal.get("error", "") and time.monotonic() - t0 < 8)

# ChromeDriver cannot attach to the picker: the launch error itself.
own = spawn_named(f"--user-data-dir={udd}")
decoy_sibling = spawn_named(f"--user-data-dir={udd}2")
decoy_translation = spawn_named("--user-data-dir=/home/ubuntu/hermex-translation/chrome-profile/chrome_profile")
time.sleep(0.3)
p = start(STUB_LAUNCH="picker")
fatal = readline(p)
p.wait(timeout=20)
time.sleep(0.3)
check("'unable to discover open pages' is explained as the profile picker, with the fix",
      fatal.get("reason") == "unavailable" and "profile picker" in fatal.get("error", "") and "Profile 1" in fatal.get("error", ""), str(fatal))
check("a failed launch stops the browser it left on this profile", own.poll() is not None)
check("…and no other Chrome: not a similarly named profile, not translation's",
      decoy_sibling.poll() is None and decoy_translation.poll() is None)
check("…and the lock is released", log_path.read_text().splitlines()[-1] == "unlock")
for d in (own, decoy_sibling, decoy_translation):
    if d.poll() is None:
        d.kill()

p = start(STUB_LAUNCH="picker", HERMEX_SESSION_PROFILE_DIRECTORY="Profile 1")
fatal = readline(p)
p.wait(timeout=20)
check("with a directory selected, the same failure stays retryable ('chrome') and says what was requested",
      fatal.get("reason") == "chrome" and "'Profile 1' was requested" in fatal.get("error", ""), str(fatal))

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {len(FAILURES)} failed")
for f in FAILURES:
    print(f"  - {f}")
sys.exit(1 if FAILURES else 0)
