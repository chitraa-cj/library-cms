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


# ── 1. browser cleanup is scoped by construction ─────────────────────────────
print("\nbrowser cleanup (real mock processes)")
sys.path.insert(0, str(HERE))
import chrome_procs  # noqa: E402
import translate_cli  # noqa: E402

tmp = Path(tempfile.mkdtemp(prefix="hermex-iso-"))
BIN = tmp / "bin"
BIN.mkdir()
for exe in ("chrome", "chromedriver"):
    (BIN / exe).symlink_to(sys.executable)
SLEEP = ["-c", "import time; time.sleep(120)"]
TR_DATA = tmp / "hermex-translation" / "chrome-profile"
OCR_DATA = tmp / "hermex-structure" / "chrome-profile"
TR_UDD, OCR_UDD = TR_DATA / "chrome_profile", OCR_DATA / "chrome_profile"
for d in (TR_UDD, OCR_UDD):
    d.mkdir(parents=True)
spawned: list[subprocess.Popen] = []


def fake(exe: str, *args: str) -> subprocess.Popen:
    p = subprocess.Popen([str(BIN / exe), *SLEEP, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    spawned.append(p)
    return p


def orphan_driver() -> int:
    """A chromedriver whose parent is NOT the cleaning process (its shell exits at once)."""
    out = subprocess.run(
        ["/bin/sh", "-c", f'"{BIN / "chromedriver"}" -c "import time; time.sleep(120)" --port=9515 >/dev/null 2>&1 & echo $!'],
        capture_output=True, text=True,
    ).stdout.strip()
    return int(out)


def alive(pid: int) -> bool:
    for p in spawned:
        if p.pid == pid:
            return p.poll() is None
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


real_sleep = time.sleep
try:
    tr_main = fake("chrome", f"--user-data-dir={TR_UDD}", "--profile-directory=Default")
    tr_renderer = fake("chrome", "--type=renderer", f"--user-data-dir={TR_UDD}")
    ocr_main = fake("chrome", f"--user-data-dir={OCR_UDD}", "--profile-directory=Profile 1")
    unrelated = fake("chrome", f"--user-data-dir={tmp / 'someone-else'}")
    sibling = fake("chrome", f"--user-data-dir={TR_UDD}2")
    # A shell/grep/monitor whose command line merely MENTIONS the profile path.
    onlooker = subprocess.Popen([sys.executable, *SLEEP, f"grep --user-data-dir={TR_UDD}"])
    spawned.append(onlooker)
    my_driver = fake("chromedriver", "--port=9516")  # started by this (cleaning) process
    stray_driver = orphan_driver()
    real_sleep(0.5)

    procs = chrome_procs.list_processes()
    check("process listing sees the mock Chrome with its exact user-data dir",
          chrome_procs.browser_pids(str(TR_UDD), procs) == sorted([tr_main.pid, tr_renderer.pid]),
          str(chrome_procs.browser_pids(str(TR_UDD), procs)))

    # Translation's recovery: no HERMEX_CLEANUP_SCOPE at all (as translation runs it).
    for k in ("HERMEX_CLEANUP_SCOPE", "HERMEX_CHROME_PROFILE_DIR", "HERMEX_CHROME_PROFILE_MARKER"):
        os.environ.pop(k, None)
    os.environ["HERMEX_CHROME_PROFILE"] = str(TR_DATA)
    translate_cli.time.sleep = lambda s: None  # type: ignore[assignment]
    translate_cli._cleanup_stale_chrome()
    real_sleep(0.5)
    check("translation cleanup stops translation's leftover browser (main + renderer)", not alive(tr_main.pid) and not alive(tr_renderer.pid))
    check("…never OCR's browser", alive(ocr_main.pid))
    check("…never an unrelated Chrome, nor a similarly named profile", alive(unrelated.pid) and alive(sibling.pid))
    check("…never a process that merely mentions the path (shell, grep, monitor)", alive(onlooker.pid))
    check("…stops the ChromeDriver it started itself", not alive(my_driver.pid))
    check("…never a ChromeDriver it cannot prove it owns", alive(stray_driver))

    # OCR's recovery: the mirror image.
    tr_again = fake("chrome", f"--user-data-dir={TR_UDD}")
    real_sleep(0.3)
    os.environ["HERMEX_CHROME_PROFILE"] = str(OCR_DATA)
    os.environ["HERMEX_CLEANUP_SCOPE"] = "profile"
    translate_cli._cleanup_stale_chrome()
    real_sleep(0.5)
    check("OCR cleanup stops OCR's leftover browser", not alive(ocr_main.pid))
    check("…never translation's browser", alive(tr_again.pid))

    # The cleaning process and its ancestors are never candidates, even if they match.
    me = os.getpid()
    fake_procs = [
        chrome_procs.Proc(me, 4242, (str(BIN / "chrome"), f"--user-data-dir={TR_UDD}")),
        chrome_procs.Proc(4242, 1, (str(BIN / "chrome"), f"--user-data-dir={TR_UDD}")),
        chrome_procs.Proc(5000, 1, (str(BIN / "chrome"), f"--user-data-dir={TR_UDD}")),
    ]
    check("cleanup can never select its own process or an ancestor", chrome_procs.browser_pids(str(TR_UDD), fake_procs, me=me) == [5000])
    ps_text = f"10 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x/Application Support/p --no-first-run\n11 1 /usr/bin/grep --user-data-dir=/x/Application Support/p"
    check("ps fallback: a path with spaces still matches exactly, and grep does not",
          chrome_procs.browser_pids("/x/Application Support/p", chrome_procs.parse_ps(ps_text), me=1) == [10])
    os.environ.pop("HERMEX_CLEANUP_SCOPE", None)

    # Singleton files: never removed while their browser may be alive.
    host = __import__("socket").gethostname()
    sdir = tmp / "singletons"
    sdir.mkdir()

    def lock_to(owner: str) -> None:
        for n in chrome_procs.SINGLETON_FILES:
            target = sdir / n
            if os.path.lexists(target):
                target.unlink()
        os.symlink(owner, sdir / "SingletonLock")
        (sdir / "SingletonSocket").write_text("")
        (sdir / "SingletonCookie").write_text("")

    live_owner = fake("chrome", f"--user-data-dir={sdir}")
    real_sleep(0.3)
    lock_to(f"{host}-{live_owner.pid}")
    removed, why = chrome_procs.remove_stale_singletons(str(sdir))
    check("a live browser's singleton files are kept", removed == [] and os.path.lexists(sdir / "SingletonLock"), why)
    live_owner.kill()
    live_owner.wait()
    lock_to(f"{host}-{os.getpid()}")
    removed, why = chrome_procs.remove_stale_singletons(str(sdir))
    check("…kept while the recorded owner pid is alive", removed == [] and "alive" in why, why)
    lock_to(f"some-other-host-{live_owner.pid}")
    removed, why = chrome_procs.remove_stale_singletons(str(sdir))
    check("…kept when the lock belongs to another host", removed == [] and "host" in why, why)
    lock_to(f"{host}-{live_owner.pid}")  # dead pid now
    removed, why = chrome_procs.remove_stale_singletons(str(sdir))
    check("stale singleton files are removed once the owner is verified dead",
          sorted(removed) == sorted(chrome_procs.SINGLETON_FILES) and not os.path.lexists(sdir / "SingletonLock"), why)
    (sdir / "Cookies").write_text("keep")
    check("…and nothing else in the profile is touched", (sdir / "Cookies").read_text() == "keep")

    # Locks: one profile = one owner; different profiles at the same time.
    holder_src = (
        "import sys, time; sys.path.insert(0, %r); import translate_cli as t\n"
        "l = t._ProfileLock(sys.argv[1]); l.acquire(); print('held', flush=True); time.sleep(60)"
    ) % str(HERE)
    tr_lock, ocr_lock = str(tmp / "hermex-translation" / ".hermex.lock"), str(OCR_DATA) + ".lock"
    holders = [subprocess.Popen([sys.executable, "-c", holder_src, f], stdout=subprocess.PIPE, text=True) for f in (tr_lock, ocr_lock)]
    spawned.extend(holders)
    check("translation and OCR hold their own locks at the same time", all(h.stdout.readline().strip() == "held" for h in holders))  # type: ignore[union-attr]
    try:
        translate_cli._ProfileLock(ocr_lock).acquire()
        check("a second session on the same profile is refused as busy", False)
    except translate_cli.HermexBusyError:
        check("a second session on the same profile is refused as busy", True)
    holders[1].kill()
    holders[1].wait()
    second = translate_cli._ProfileLock(ocr_lock)
    second.acquire()
    check("…and the lock frees itself when its holder dies (no file deletion needed)", os.path.exists(ocr_lock))
    second.release()
    check("lock files of the two workflows never resolve to the same path", os.path.realpath(tr_lock) != os.path.realpath(ocr_lock))
finally:
    translate_cli.time.sleep = real_sleep  # type: ignore[assignment]
    for p in spawned:
        if p.poll() is None:
            p.kill()
    try:
        os.kill(stray_driver, signal.SIGKILL)
    except Exception:
        pass
    os.environ.pop("HERMEX_CLEANUP_SCOPE", None)
    os.environ.pop("HERMEX_CHROME_PROFILE", None)


# ── 1b. the production scenario: one workflow's launch fails while the other runs ──
print("\nlaunch failure in one workflow while the other's browser runs")
import types as _types  # noqa: E402

SESSION = tmp / "mock_session.py"
SESSION.write_text(
    "import subprocess, sys, time\n"
    "bin_dir, udd = sys.argv[1], sys.argv[2]\n"
    "sleep = ['-c', 'import time; time.sleep(120)']\n"
    "chrome = subprocess.Popen([bin_dir + '/chrome', *sleep, '--user-data-dir=' + udd, '--remote-debugging-port=0'])\n"
    "renderer = subprocess.Popen([bin_dir + '/chrome', *sleep, '--type=renderer', '--user-data-dir=' + udd])\n"
    "driver = subprocess.Popen([bin_dir + '/chromedriver', *sleep, '--port=0'])\n"
    "print(chrome.pid, renderer.pid, driver.pid, flush=True)\n"
    "time.sleep(120)\n"
)


def live_session(udd: Path) -> tuple[subprocess.Popen, list[int]]:
    """A running worker session: its Chrome (main + renderer) and its ChromeDriver,
    all children of the session process — the shape undetected_chromedriver produces."""
    p = subprocess.Popen([sys.executable, str(SESSION), str(BIN), str(udd)], stdout=subprocess.PIPE, text=True)
    pids = [int(x) for x in p.stdout.readline().split()]  # type: ignore[union-attr]
    session_children.extend(pids)
    return p, pids


class _LaunchFails:
    """Stands in for hermex.Gemini: every launch dies the way the box logged it."""
    launches = 0

    def __init__(self, **kwargs):
        _LaunchFails.launches += 1
        raise RuntimeError("Message: session not created: cannot connect to chrome at 127.0.0.1:48941\n"
                           "from unknown error: unable to discover open pages")


def failing_launch(data_dir: Path, scope: str | None) -> None:
    os.environ["HERMEX_CHROME_PROFILE"] = str(data_dir)
    for k in ("HERMEX_CHROME_PROFILE_DIR", "HERMEX_CHROME_PROFILE_MARKER", "HERMEX_CLEANUP_SCOPE"):
        os.environ.pop(k, None)
    if scope is not None:
        os.environ["HERMEX_CLEANUP_SCOPE"] = scope
    os.environ["HERMEX_LAUNCH_ATTEMPTS"] = "2"
    sys.modules["hermex"] = _types.SimpleNamespace(Gemini=_LaunchFails)  # type: ignore[assignment]
    _LaunchFails.launches = 0
    try:
        translate_cli._open_gemini_browser(False)
    except RuntimeError:
        pass


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a zombie is dead for our purposes
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(st) and not st.startswith("Z")
    except Exception:
        return True


real_sleep2 = time.sleep
translate_cli.time.sleep = lambda s: None  # type: ignore[assignment]
saved_hermex = sys.modules.get("hermex")
sessions: list[subprocess.Popen] = []
session_children: list[int] = []  # killing a session does not kill its children
try:
    for scope, label in ((None, "unset (as on the box)"), ("profiel", "misspelled"), ("global", "an unexpected value")):
        ocr_session, (ocr_chrome, ocr_renderer, ocr_driver) = live_session(OCR_UDD)
        sessions.append(ocr_session)
        tr_orphan = fake("chrome", f"--user-data-dir={TR_UDD}")      # what the failed launch left
        tr_own_driver = fake("chromedriver", "--port=0")              # started by the failing process
        real_sleep2(0.4)
        failing_launch(TR_DATA, scope)
        real_sleep2(0.4)
        check(f"[HERMEX_CLEANUP_SCOPE {label}] translation's failed launch retried and cleaned up", _LaunchFails.launches == 2)
        check(f"[HERMEX_CLEANUP_SCOPE {label}] …OCR's Chrome (main + renderer) is still alive",
              pid_alive(ocr_chrome) and pid_alive(ocr_renderer))
        check(f"[HERMEX_CLEANUP_SCOPE {label}] …OCR's ChromeDriver is still alive", pid_alive(ocr_driver))
        check(f"[HERMEX_CLEANUP_SCOPE {label}] …translation's own leftover Chrome and driver are stopped",
              not pid_alive(tr_orphan.pid) and not pid_alive(tr_own_driver.pid))
        ocr_session.kill()
        for pid in (ocr_chrome, ocr_renderer, ocr_driver):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    # Reverse: OCR's launch fails while translation runs.
    for scope, label in (("profile", "as the OCR session sets it"), (None, "unset")):
        tr_session, (tr_chrome, tr_renderer, tr_driver) = live_session(TR_UDD)
        sessions.append(tr_session)
        ocr_orphan = fake("chrome", f"--user-data-dir={OCR_UDD}")
        real_sleep2(0.4)
        failing_launch(OCR_DATA, scope)
        import chrome_profile_select as _cps  # the OCR session's own failed-launch cleanup
        _cps.stop_own_browsers(str(OCR_DATA), grace=1.0)
        real_sleep2(0.4)
        check(f"[OCR fails, scope {label}] translation's Chrome and ChromeDriver are still alive",
              pid_alive(tr_chrome) and pid_alive(tr_renderer) and pid_alive(tr_driver))
        check(f"[OCR fails, scope {label}] …OCR's own leftover Chrome is stopped", not pid_alive(ocr_orphan.pid))
        tr_session.kill()
        for pid in (tr_chrome, tr_renderer, tr_driver):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    # Lock files are never removed from under a live browser, whatever the caller's env.
    live_tr, (tr_chrome2, _r, _d) = live_session(TR_UDD)
    sessions.append(live_tr)
    real_sleep2(0.3)
    if os.path.lexists(TR_UDD / "SingletonLock"):
        (TR_UDD / "SingletonLock").unlink()
    os.symlink(f"{__import__('socket').gethostname()}-{tr_chrome2}", TR_UDD / "SingletonLock")
    (TR_UDD / "SingletonSocket").write_text("")
    removed, why = chrome_procs.remove_stale_singletons(str(TR_UDD))
    check("singleton files of a profile with a live Chrome are left alone, with the reason", removed == [] and "running" in why, why)
    live_tr.kill()
finally:
    translate_cli.time.sleep = real_sleep2  # type: ignore[assignment]
    if saved_hermex is None:
        sys.modules.pop("hermex", None)
    else:
        sys.modules["hermex"] = saved_hermex
    for p in sessions:
        if p.poll() is None:
            p.kill()
    for pid in session_children:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    for k in ("HERMEX_CHROME_PROFILE", "HERMEX_CLEANUP_SCOPE", "HERMEX_LAUNCH_ATTEMPTS"):
        os.environ.pop(k, None)
    for p in spawned:
        if p.poll() is None:
            p.kill()


# ── 1c. OCR file upload against Gemini's current UI (no browser) ───────────────
print("\nOCR upload: current Gemini upload UI")


def _install_selenium_stubs() -> dict:
    """Minimal selenium stand-ins (the test Python has no selenium installed)."""
    saved = {k: sys.modules.get(k) for k in list(sys.modules) if k == "selenium" or k.startswith("selenium.")}

    class TimeoutException(Exception):
        pass

    class By:
        CSS_SELECTOR = "css selector"
        TAG_NAME = "tag name"

    class Keys:
        ESCAPE = "\ue00c"
        ENTER = "\ue007"

    def element_to_be_clickable(locator):
        def check(driver):
            el = driver.find_element(*locator)
            return el if el is not None and el.is_displayed() and el.is_enabled() else False
        return check

    class WebDriverWait:
        def __init__(self, driver, timeout):
            self.driver = driver

        def until(self, cond):
            value = cond(self.driver)
            if not value:
                raise TimeoutException("")
            return value

    mods = {
        "selenium": _types.ModuleType("selenium"),
        "selenium.common": _types.ModuleType("selenium.common"),
        "selenium.common.exceptions": _types.SimpleNamespace(TimeoutException=TimeoutException),
        "selenium.webdriver": _types.ModuleType("selenium.webdriver"),
        "selenium.webdriver.common": _types.ModuleType("selenium.webdriver.common"),
        "selenium.webdriver.common.by": _types.SimpleNamespace(By=By),
        "selenium.webdriver.common.keys": _types.SimpleNamespace(Keys=Keys),
        "selenium.webdriver.support": _types.ModuleType("selenium.webdriver.support"),
        "selenium.webdriver.support.expected_conditions": _types.SimpleNamespace(element_to_be_clickable=element_to_be_clickable),
        "selenium.webdriver.support.ui": _types.SimpleNamespace(WebDriverWait=WebDriverWait),
    }
    sys.modules.update(mods)  # type: ignore[arg-type]
    return saved


class _El:
    def __init__(self, text: str = "", buttons: list | None = None):
        self.text, self.clicks, self.keys, self.buttons = text, 0, [], buttons or []

    def click(self):
        self.clicks += 1

    def send_keys(self, value):
        self.keys.append(value)

    def is_displayed(self):
        return True

    def is_enabled(self):
        return True

    def find_elements(self, by, sel):
        return list(self.buttons)


class _GeminiPage:
    """What the EC2 probe saw: 'Upload & tools' + the uploader entry, then three unnamed inputs."""

    def __init__(self, consent: bool, inputs: list[dict]):
        self.menu, self.trigger = _El(), _El()
        self.cancel, self.agree = _El("Cancel"), _El("Agree")
        self.dialog = _El(buttons=[self.cancel, self.agree]) if consent else None
        self.inputs = inputs
        self.input_els = [_El() for _ in inputs]
        self.active = _El()
        self.switch_to = _types.SimpleNamespace(active_element=self.active)
        self.patched = self.restored = False

    def find_elements(self, by, sel):
        return [self.menu] if 'aria-label="Upload & tools"' in sel else []

    def find_element(self, by, sel):
        return self.trigger if "uploader-images-files-button-advanced" in sel else None

    def execute_script(self, script, *args):
        if "window.__restoreFileClick = " in script:
            self.patched = True
        elif "__restoreFileClick()" in script:
            self.restored = True
        elif "creating content from images and files" in script:
            return self.dialog if (self.dialog and self.trigger.clicks) else None
        elif "map(i => ({name" in script:
            return self.inputs if self.trigger.clicks else []
        elif "querySelectorAll('input[type=file]')];" in script:
            return self.input_els
        elif "return arguments[0].style.display" in script:
            return "none"
        return None


saved_selenium = _install_selenium_stubs()
try:
    seen = [{"name": "", "accept": ".txt,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"}, {"name": "", "accept": "image/*,video/*"},
            {"name": "", "accept": ".txt,.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"}]
    check("the document input is chosen by what it accepts (Gemini no longer names it Filedata)",
          translate_cli._pick_file_input(seen, ["/x/pages-1-1.pdf"]) == 0)
    check("…an image uses an input that accepts it", translate_cli._pick_file_input([seen[1]], ["/x/page-1.png"]) == 0)
    check("…the legacy Filedata input still wins when present",
          translate_cli._pick_file_input([seen[1], {"name": "Filedata", "accept": ""}], ["/x/a.pdf"]) == 1)
    check("…and no input that cannot take the file is used", translate_cli._pick_file_input([seen[1]], ["/x/a.pdf"]) is None)

    pdf = tmp / "pages-1-1.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    page = _GeminiPage(consent=False, inputs=seen)
    translate_cli._upload_attachments(_types.SimpleNamespace(driver=page), [str(pdf)])
    check("upload: menu opened, 'Upload files' clicked, the file sent to the document input",
          page.menu.clicks == 1 and page.trigger.clicks == 1 and page.input_els[0].keys == [os.path.realpath(pdf)])
    check("…the OS-dialog suppression is installed and always removed", page.patched and page.restored)

    page = _GeminiPage(consent=True, inputs=seen)
    err = None
    try:
        translate_cli._upload_attachments(_types.SimpleNamespace(driver=page), [str(pdf)])
    except translate_cli.UploadConsentRequired as e:
        err = e
    check("Gemini's one-time upload notice ends the request with an explicit error",
          err is not None and translate_cli.UPLOAD_CONSENT_MARKER in str(err) and "Agree" in str(err))
    check("…the notice is closed with Cancel — never Agree", page.cancel.clicks == 1 and page.agree.clicks == 0)
    check("…nothing was uploaded", all(not e.keys for e in page.input_els) and page.restored)
    check("…it is not treated as retryable (no timeout/transient wording)",
          not translate_cli._is_idle_timeout(err) and not translate_cli._is_gemini_transient(err))  # type: ignore[arg-type]
    _stdout = sys.stdout
    import prompt_session as _ps  # noqa: E402  (it rebinds sys.stdout for its protocol)
    sys.stdout = _stdout
    check("…and the session reports it as 'unavailable' (job stops, pages stay queued)", _ps._reason(err) == "unavailable")  # type: ignore[arg-type]
finally:
    for k in [k for k in sys.modules if k == "selenium" or k.startswith("selenium.")]:
        del sys.modules[k]
    sys.modules.update({k: v for k, v in saved_selenium.items() if v is not None})


# ── 2. prompt_session.py against a stub browser layer ─────────────────────────
print("\nprompt_session.py protocol")
work = tmp / "session"
work.mkdir()
shutil.copy(HERE / "prompt_session.py", work / "prompt_session.py")
shutil.copy(HERE / "chrome_profile_select.py", work / "chrome_profile_select.py")
shutil.copy(HERE / "chrome_procs.py", work / "chrome_procs.py")
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
    if os.environ.get("STUB_LAUNCH") == "timeout":
        # Like hermex: the launch starts Chrome, then WebDriverWait times out on the chat box.
        if os.environ.get("STUB_SPAWN"):
            import json as _j, subprocess as _sp
            child = _sp.Popen(_j.loads(os.environ["STUB_SPAWN"]), stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, start_new_session=True)
            _w("spawned %d" % child.pid)
            time.sleep(1.0)
        raise TimeoutError("Message: ")
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
                  ("https://gemini.google.com/app/1a2b3c", "gemini"), ("https://gemini.google.com/u/1/app", "gemini"),
                  ("https://gemini.google.com/", "landing"), ("https://gemini.google.com", "landing"),
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
    f"101 1 /opt/google/chrome/chrome --user-data-dir={udd} --profile-directory=Default",
    f"102 101 /opt/google/chrome/chrome --type=renderer --user-data-dir={udd}",
    f"103 1 /opt/google/chrome/chrome --user-data-dir={udd}2",
    f"104 1 /opt/google/chrome/chrome --user-data-dir={udd}/nested",
    "105 1 /opt/google/chrome/chrome --user-data-dir=/home/ubuntu/hermex-translation/chrome-profile/chrome_profile",
    f"106 1 python3 prompt_session.py --user-data-dir={udd}",
])
matched = chrome_procs.browser_pids(str(udd), chrome_procs.parse_ps(ps_text), me=1)
check("leftover-browser matching takes exactly this user-data dir, Chrome executables only", matched == [101, 102], str(matched))

def spawn_named(arg: str) -> subprocess.Popen:
    return subprocess.Popen([str(BIN / "chrome"), "-c", "import time; time.sleep(60)", arg])

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

p = start(STUB_URL="https://gemini.google.com/")
fatal = readline(p)
p.wait(timeout=10)
check("Gemini's public start page (no chat app for this profile) is 'login' with the reason, never 'ready'",
      fatal.get("reason") == "login" and "public start page" in fatal.get("error", ""), str(fatal))

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
decoy_translation = spawn_named(f"--user-data-dir={TR_UDD}")
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

# A Chrome orphaned on this profile by an earlier, SIGKILLed session is stopped before launch.
orphan = spawn_named(f"--user-data-dir={udd}")
bystander = spawn_named(f"--user-data-dir={TR_UDD}")
time.sleep(0.3)
p = start()
ready = readline(p)
p.stdin.write(json.dumps({"op": "close"}) + "\n")  # type: ignore[union-attr]
p.stdin.flush()  # type: ignore[union-attr]
_, err = p.communicate(timeout=20)
check("an orphaned browser on this profile is stopped before launching, then the session is ready",
      ready.get("type") == "ready" and orphan.wait(timeout=10) is not None and "leftover browser" in err)
check("…translation's browser is left running", bystander.poll() is None)
bystander.kill()

# A launch that times out waiting for the chat box: the session reads where the browser
# really is (its DevTools tab list) before cleaning it up.
import socket as _socket  # noqa: E402

def free_port() -> int:
    with _socket.socket() as s_:
        s_.bind(("127.0.0.1", 0))
        return s_.getsockname()[1]

DEVTOOLS = tmp / "devtools_mock.py"
DEVTOOLS.write_text(
    "import http.server, json, sys\n"
    "a = dict(x.lstrip('-').split('=', 1) for x in sys.argv[1:] if '=' in x)\n"
    "body = json.dumps([{'type': 'page', 'url': a['page-url']}]).encode()\n"
    "class H(http.server.BaseHTTPRequestHandler):\n"
    "    def do_GET(self):\n"
    "        self.send_response(200); self.end_headers(); self.wfile.write(body)\n"
    "    def log_message(self, *x): pass\n"
    "http.server.HTTPServer(('127.0.0.1', int(a['remote-debugging-port'])), H).serve_forever()\n"
)

def devtools_cmd(url: str) -> list[str]:
    return [str(BIN / "chrome"), str(DEVTOOLS), f"--user-data-dir={udd}", f"--remote-debugging-port={free_port()}", f"--page-url={url}"]

def spawned_pid() -> int:
    return int([l for l in log_path.read_text().splitlines() if l.startswith("spawned ")][-1].split()[1])

probe = subprocess.Popen(devtools_cmd("https://gemini.google.com/"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
renderer = subprocess.Popen([str(BIN / "chrome"), "-c", "import time; time.sleep(60)", "--type=renderer", f"--user-data-dir={udd}", f"--remote-debugging-port={free_port()}"])
time.sleep(0.8)
check("the tab URL is read from the browser process, not a renderer", cps.classify_url(chrome_procs.current_page_url(str(udd))) == "landing")
probe.kill()
renderer.kill()
probe.wait()
renderer.wait()

log_path.write_text("")
p = start(STUB_LAUNCH="timeout", STUB_SPAWN=json.dumps(devtools_cmd("https://gemini.google.com/")))
fatal = readline(p)
_, err = p.communicate(timeout=20)
check("a launch timeout on Gemini's start page is reported as 'login' with the real reason, not 'timeout'",
      fatal.get("reason") == "login" and "public start page" in fatal.get("error", ""), str(fatal))
check("…the landing page is in the session's log", "browser was on: landing" in err)
check("…and the browser the failed launch left is stopped", not alive(spawned_pid()))

log_path.write_text("")
p = start(STUB_LAUNCH="timeout", STUB_SPAWN=json.dumps(devtools_cmd("about:blank")))
fatal = readline(p)
p.communicate(timeout=20)
check("an empty Selenium timeout still says where the browser was", fatal.get("reason") == "timeout" and "browser was on: other" in fatal.get("error", ""), str(fatal))
check("…and that browser is stopped too", not alive(spawned_pid()))

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
