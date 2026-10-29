#!/usr/bin/env python3
"""
A long-lived Hermex prompt session: one Chrome on one DEDICATED profile, many prompts.

Used by OCR (page files attached to the prompt) and the OCR → Grantha analysis
(server/hermex/prompt-session.ts). Translation does not
use it and is not affected by it: this process runs on its own Chrome profile, under
its own lock file, with the browser cleanup scoped to that profile.

Protocol — JSON lines. stdout carries ONLY protocol lines; everything else (hermex,
selenium, our own logs) goes to stderr.

  ← {"type": "ready", "loggedIn": true}                 once the browser is usable
  ← {"type": "fatal", "reason": "...", "error": "..."}   startup failed; process exits
  → {"id": "<corr id>", "op": "ask", "prompt": "...", "timeoutSec": 300,
     "attachments": ["/abs/page.pdf"]}                  attachments optional (OCR)
  ← {"id": "<corr id>", "ok": true, "text": "..."}
  ← {"id": "<corr id>", "ok": false, "reason": "...", "error": "..."}
  → {"op": "close"}                                      (or EOF) — browser closed, exit 0

Every "ask" runs in a FRESH Gemini chat, so no answer can depend on (or leak into)
another request's conversation. Requests are handled strictly one at a time.

Environment (set by the Node side, never by hand):
  HERMEX_CHROME_PROFILE / _DIR / _MARKER   the dedicated profile
  HERMEX_LOCK_FILE                         its own single-flight lock
  HERMEX_CLEANUP_SCOPE=profile             never touch another workflow's browser
  HERMEX_SESSION_PROFILE_DIRECTORY         optional: the Chrome profile inside the
                                           user-data dir (e.g. "Profile 1"); required
                                           when that dir holds more than one profile,
                                           or Chrome opens its profile picker

Readiness: "ready" is sent only once the browser is on gemini.google.com and logged in.
The profile picker, a Google login page or any other page is a startup failure with
the reason, and browsers a failed launch left on this profile are stopped.
"""

from __future__ import annotations

import json
import os
import signal
import sys
from typing import Any, TextIO

# Protocol channel first: anything printed by a library after this point lands on
# stderr, so a stray print can never corrupt a protocol line.
_PROTO: TextIO = sys.stdout
sys.stdout = sys.stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _emit(obj: dict[str, Any]) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def _log(msg: str) -> None:
    print(f"[hermex-session] {msg}", file=sys.stderr, flush=True)


def _reason(err: BaseException) -> str:
    """Same vocabulary as HermexFailureReason in server/hermex-translate.ts."""
    name = type(err).__name__
    text = f"{name} {err}".lower()
    if name == "HermexBusyError":
        return "busy"
    if name == "UploadConsentRequired" or "upload_consent_required" in text:
        # An account-level step only its owner can take: stop the job, keep pages queued.
        return "unavailable"
    if "not logged in" in text or "sign in" in text or "login" in text:
        return "login"
    if "cannot open display" in text or "no display" in text:
        return "display"
    if "timeout" in text or "timed out" in text or "stall" in text:
        return "timeout"
    if name == "GeminiTransientError":
        return "transient"
    if "neither text nor image" in text or "empty" in text:
        return "empty"
    if any(k in text for k in ("chrome", "chromedriver", "webdriver", "selenium", "session not created", "no such window")):
        return "chrome"
    return "unknown"


def _signed_out(gemini: Any) -> bool:
    """Gemini shows a "Sign in" link when the session's Google login has expired. Checked
    before and after every request, so a login page is never mistaken for an answer.
    Reads only whether the link exists — no cookie, token or page content."""
    try:
        # "css selector" is Selenium's By.CSS_SELECTOR value.
        return bool(gemini.driver.find_elements("css selector", 'a[aria-label="Sign in"]'))
    except Exception:
        return False


_LOGIN_EXPIRED = "The dedicated Gemini profile's login has expired. Log in again (npm run hermex:setup-structure), then press Retry."


def _exit_on_sigterm(_signum: int, _frame: Any) -> None:
    # Node kills a session it can no longer trust (timeout, cancel). Raising SystemExit
    # runs main()'s `finally`, which closes Chrome — otherwise the browser is orphaned
    # on the profile and the next session's launch fails on its Singleton lock.
    raise SystemExit(143)


def main() -> int:
    signal.signal(signal.SIGTERM, _exit_on_sigterm)
    if (os.environ.get("HERMEX_CLEANUP_SCOPE") or "").strip().lower() != "profile":
        _emit({"type": "fatal", "reason": "unavailable", "error": "HERMEX_CLEANUP_SCOPE=profile is required for a prompt session."})
        return 2
    if not (os.environ.get("HERMEX_CHROME_PROFILE") or "").strip():
        _emit({"type": "fatal", "reason": "unavailable", "error": "No dedicated Chrome profile was configured for this session."})
        return 2

    try:
        import translate_cli as cli  # the hardened Gemini driver translation already uses
    except Exception as e:  # pragma: no cover - environment problem
        _emit({"type": "fatal", "reason": "unavailable", "error": f"Hermex is not importable: {e}"})
        return 2

    import chrome_profile_select as profiles

    data_dir = (os.environ.get("HERMEX_CHROME_PROFILE") or "").strip()
    udd = profiles.user_data_dir(data_dir)
    try:
        directory = profiles.directory_from_env()
    except ValueError as e:
        _emit({"type": "fatal", "reason": "unavailable", "error": str(e)})
        return 2
    _log(
        f"user-data-dir={udd} profile-directory={directory or '(not set: Chrome picks)'}; "
        f"profiles: {profiles.describe(profiles.read_profiles(udd))}"
    )
    if directory:
        try:
            profiles.install(directory)
        except Exception as e:  # pragma: no cover - environment problem
            _emit({"type": "fatal", "reason": "unavailable", "error": f"Could not select Chrome profile {directory!r}: {e}"})
            return 2
    page_timeout = float(os.environ.get("HERMEX_SESSION_PAGE_TIMEOUT_SEC") or 30)

    headless = (os.environ.get("HERMEX_SESSION_HEADLESS") or "").strip().lower() in ("1", "true", "yes")
    lock = cli._ProfileLock(cli._lock_path())
    gemini = None
    locked = False
    try:
        lock.acquire()
        locked = True
        # With the lock held, a Chrome on exactly this user-data dir cannot belong to a
        # live session: it is an orphan of one Node had to SIGKILL. Launching beside it
        # fails ("cannot connect to chrome"), so stop it first — this profile only.
        import chrome_procs

        orphans = chrome_procs.browser_pids(udd, chrome_procs.list_processes())
        if orphans:
            _log(f"found {len(orphans)} leftover browser process(es) on this profile from an earlier session; stopping them")
            profiles.stop_own_browsers(data_dir)
        try:
            gemini = cli._open_gemini_browser(headless)
        except Exception as e:
            text = str(e).lower()
            # Where did the browser end up? Read its tab URL (local DevTools GET) before
            # the failed launch is cleaned up, so the failure says what actually happened.
            import chrome_procs

            landed = profiles.classify_url(chrome_procs.current_page_url(udd))
            _log(f"launch failed ({type(e).__name__}); browser was on: {landed}")
            if landed == "landing":
                _emit({"type": "fatal", "reason": "login", "error": profiles.LANDING_HINT})
                return 3
            if landed == "login":
                _emit({"type": "fatal", "reason": "login", "error": "The dedicated profile opened Google's sign-in page instead of Gemini. Log in again (npm run hermex:setup-structure)."})
                return 3
            if landed == "picker" or "unable to discover open pages" in text or "profile-picker" in text:
                # Chrome is sitting on its profile picker: no page for ChromeDriver to attach to.
                _emit({
                    "type": "fatal",
                    "reason": "chrome" if directory else "unavailable",
                    "error": f"{profiles.picker_hint(udd, directory)} (ChromeDriver: {str(e).splitlines()[0][:200]})",
                })
                return 1
            if not str(e).strip() or str(e).strip() == "Message:":
                raise RuntimeError(f"{type(e).__name__} while opening Gemini (browser was on: {landed})") from e
            raise
        page = profiles.wait_for_gemini(lambda: gemini.driver.current_url, timeout=page_timeout)
        _log(f"browser landed on: {page}")
        if page == "picker":
            _emit({"type": "fatal", "reason": "chrome" if directory else "unavailable", "error": profiles.picker_hint(udd, directory)})
            return 1
        if page == "landing":
            _emit({"type": "fatal", "reason": "login", "error": profiles.LANDING_HINT})
            return 3
        if page == "login":
            _emit({"type": "fatal", "reason": "login", "error": "The dedicated profile opened Google's sign-in page instead of Gemini. Log in again (npm run hermex:setup-structure)."})
            return 3
        if page != "gemini":
            _emit({"type": "fatal", "reason": "chrome", "error": f"The browser did not reach gemini.google.com within {page_timeout:.0f}s."})
            return 1
        if not getattr(gemini, "is_logged_in", True) or _signed_out(gemini):
            _emit({
                "type": "fatal",
                "reason": "login",
                "error": "The dedicated Gemini profile is not logged in. Run the one-time setup for it (npm run hermex:setup-structure).",
            })
            return 3
        _emit({"type": "ready", "loggedIn": True})

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                _log("ignoring a non-JSON request line")
                continue
            op = req.get("op")
            if op == "close":
                break
            if op != "ask":
                _emit({"id": req.get("id"), "ok": False, "reason": "malformed", "error": f"unknown op {op!r}"})
                continue

            req_id = req.get("id")
            prompt = req.get("prompt") or ""
            timeout = int(req.get("timeoutSec") or 300)
            attachments = req.get("attachments") or []
            if not isinstance(prompt, str) or not prompt.strip():
                _emit({"id": req_id, "ok": False, "reason": "malformed", "error": "empty prompt"})
                continue
            if not isinstance(attachments, list) or not all(
                isinstance(a, str) and os.path.isabs(a) and os.path.isfile(a) for a in attachments
            ):
                _emit({"id": req_id, "ok": False, "reason": "malformed", "error": "attachments must be existing absolute file paths"})
                continue
            try:
                cli._start_fresh_gemini_chat(gemini)
                if _signed_out(gemini):
                    _emit({"id": req_id, "ok": False, "reason": "login", "error": _LOGIN_EXPIRED})
                    return 4
                extra = {"attachments": attachments} if attachments else {}
                answer = cli._gemini_query_with_recovery(gemini, prompt, source_text=prompt, timeout=timeout, **extra)
                text = (getattr(answer, "text", None) or "").strip()
                if _signed_out(gemini):
                    _emit({"id": req_id, "ok": False, "reason": "login", "error": _LOGIN_EXPIRED})
                    return 4
                if not text:
                    raise RuntimeError("Response contained neither text nor image.")
                _emit({"id": req_id, "ok": True, "text": text})
            except Exception as e:
                reason = "login" if _signed_out(gemini) else _reason(e)
                _log(f"request {req_id} failed ({reason}): {e}")
                _emit({"id": req_id, "ok": False, "reason": reason, "error": str(e)[:500]})
                if reason in ("chrome", "login", "display"):
                    # The browser itself is gone or unusable; let Node restart the session.
                    return 4
        return 0
    except Exception as e:
        _emit({"type": "fatal", "reason": _reason(e), "error": str(e)[:500]})
        return 1
    finally:
        if gemini is not None:
            cli._close_gemini_browser(gemini)
        elif locked:
            # A launch that failed can leave Chrome (often on the profile picker) holding
            # this profile; stop exactly those processes, nothing else. We hold the
            # profile's lock, so no live session of ours can be among them.
            profiles.stop_own_browsers(data_dir)
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
