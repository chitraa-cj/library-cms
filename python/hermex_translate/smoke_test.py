#!/usr/bin/env python3
"""Prove the server-side Gemini session actually answers.

This is the manual test that already succeeded on EC2, turned into something the
CMS can run and parse:

    "Reply with exactly: HERMEX_TEST_OK"  ->  AssistantMessage(text='HERMEX_TEST_OK')

It drives the browser through translate_cli's own helpers (overlay dismissal,
send-with-recovery, idle wait), so a pass means the path REAL translations use
works — not just that Chrome can open the profile.

Reads optional JSON on stdin ({"headless": bool}) and writes one JSON object to
stdout, exactly like translate_cli.py, so the Node adapter can treat them alike:

    {"ok": true, "response": "HERMEX_TEST_OK", "expected": "HERMEX_TEST_OK", ...}
    {"ok": false, "error": "..."}

It spends ONE Gemini request, so it is deliberately not part of the health
endpoint's default path. Run it after a deploy, or when Gemini looks stuck.

Configuration comes from the environment (never arguments, never hard-coded):
    HERMEX_CHROME_PROFILE   persistent profile with the Gemini login
    DISPLAY                 X display for Chrome (":99" under Xvfb on EC2)
    HERMEX_SMOKE_PROMPT     override the prompt (default below)
    HERMEX_SMOKE_EXPECT     override the expected token (default HERMEX_TEST_OK)
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

EXPECTED_DEFAULT = "HERMEX_TEST_OK"
PROMPT_DEFAULT = f"Reply with exactly: {EXPECTED_DEFAULT}"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _read_request() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _response_text(answer: Any) -> str:
    """hermex returns an AssistantMessage; older builds returned a bare string."""
    if answer is None:
        return ""
    text = getattr(answer, "text", None)
    if isinstance(text, str):
        return text
    return str(answer)


def run_smoke(req: dict[str, Any]) -> dict[str, Any]:
    # Reuse the translator's own hardened browser path rather than a raw
    # Gemini().query(). gemini.google.com/app regularly floats a discovery/canvas
    # card over the chat input, and a bare query() then dies with
    # "element click intercepted" — observed on this very box. _open_gemini_browser
    # dismisses overlays and retries, and _gemini_query_with_recovery waits for
    # IDLE before reading, so the smoke test exercises exactly the code path a real
    # translation takes instead of a happier-looking shortcut.
    from translate_cli import (  # type: ignore[import-not-found]
        _close_gemini_browser,
        _gemini_query_with_recovery,
        _open_gemini_browser,
    )

    expected = (os.environ.get("HERMEX_SMOKE_EXPECT") or EXPECTED_DEFAULT).strip()
    prompt = (os.environ.get("HERMEX_SMOKE_PROMPT") or PROMPT_DEFAULT).strip()
    profile = (os.environ.get("HERMEX_CHROME_PROFILE") or "").strip()
    # Under Xvfb the browser is headful on a virtual display — the mode proven on
    # this box. The caller may still force headless.
    headless = bool(req.get("headless", False))
    timeout = int(os.environ.get("HERMEX_SMOKE_QUERY_TIMEOUT", "180"))

    _log(
        f"[hermex-smoke] display={os.environ.get('DISPLAY') or 'none'} "
        f"headless={headless} profile={profile or 'hermex default'}"
    )

    started = time.time()
    gemini = _open_gemini_browser(headless)
    try:
        _log("[hermex-smoke] browser connection established")
        if not getattr(gemini, "is_logged_in", True):
            raise RuntimeError(
                "Gemini session is not logged in — re-run the interactive Hermex setup on the server."
            )
        answer = _gemini_query_with_recovery(
            gemini, prompt, source_text=prompt, timeout=timeout
        )
    finally:
        _close_gemini_browser(gemini)

    text = _response_text(answer).strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")

    return {
        "ok": True,
        "response": text,
        "expected": expected,
        "matched": expected in text,
        "durationMs": int((time.time() - started) * 1000),
    }


def main() -> None:
    try:
        result = run_smoke(_read_request())
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        # A wrong answer is still a failed smoke test, even though the round-trip worked.
        sys.exit(0 if result.get("matched") else 2)
    except Exception as e:
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
