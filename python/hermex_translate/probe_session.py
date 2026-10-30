#!/usr/bin/env python3
"""What does Gemini actually show this Chrome profile? A second-by-second record.

For "translation fails on every chunk" when the log only says `Warm-up query failed
(TimeoutException)` / `Gemini backend error reply`: those lines name a symptom, never
what was on screen. This opens the profile EXACTLY as the worker does (same launch,
same profile directory selection, same send path) but without the warm-up, then sends
two short prompts and records, once a second: the input-area state, whether Stop is
showing, the head of Gemini's latest reply, and any banner/dialog/toast text. It saves
screenshots along the way.

It takes the profile's single-flight lock, so the worker must be stopped first:

    pm2 stop cms-translation-worker
    cd ~/library/library-cms && set -a; . ./.env; set +a
    HERMEX_CHROME_PROFILE_DIR="$HERMEX_CHROME_PROFILE" \\
    HERMEX_SESSION_PROFILE_DIRECTORY="${HERMEX_TRANSLATION_PROFILE_DIRECTORY:-}" \\
      "$HERMEX_PYTHON" python/hermex_translate/probe_session.py
    pm2 start cms-translation-worker

Sends only the two fixed prompts below. NEVER logged: cookies, tokens, the account's
name or email (only whether an account control is present).
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chrome_profile_select as profiles  # noqa: E402
import translate_cli as tc  # noqa: E402

PROMPTS = [
    ("short", "Reply with the single word READY.", False),
    (
        "translation",
        # The shape and size of a real chunk (paste mode, >1200 chars), public-domain text.
        "Translate the following Sanskrit verse into Tamil, Malayalam and Gujarati. "
        "Answer with one line per language in the form LANGUAGE: translation.\n\n"
        + "ईशा वास्यमिदं सर्वं यत्किञ्च जगत्यां जगत्। तेन त्यक्तेन भुञ्जीथा मा गृधः कस्यस्विद्धनम्॥\n" * 8,
        True,
    ),
]

# Everything that can carry an on-page error, limit or consent message.
NOTICE_SELECTORS = (
    '[role="alert"], [role="alertdialog"], [role="dialog"], [role="status"], '
    "snack-bar-container, simple-snack-bar, .mat-mdc-snack-bar-container, mat-dialog-container"
)

OUT_DIR = Path(os.environ.get("HERMEX_PROBE_DIR") or "logs/hermex-diagnostics")
STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")


def emit(kind: str, **data: Any) -> None:
    print(json.dumps({"t": datetime.now().strftime("%H:%M:%S"), "kind": kind, **data}, ensure_ascii=False), flush=True)


def head(text: str | None, n: int = 160) -> str:
    return " ".join((text or "").split())[:n]


def screenshot(gemini: Any, name: str) -> None:
    path = OUT_DIR / f"probe-{STAMP}-{name}.png"
    try:
        gemini.driver.save_screenshot(str(path))
        emit("screenshot", path=str(path))
    except Exception as e:
        emit("screenshot", error=str(e)[:200])


def page_snapshot(gemini: Any) -> dict[str, Any]:
    """Where the page is and what it is showing — no account identifiers."""
    from selenium.webdriver.common.by import By

    d = gemini.driver
    snap: dict[str, Any] = {}
    try:
        snap["url"] = d.current_url
        snap["page"] = profiles.classify_url(d.current_url)
    except Exception as e:
        snap["url_error"] = str(e)[:200]

    def count(css: str) -> int:
        try:
            return len(d.find_elements(By.CSS_SELECTOR, css))
        except Exception:
            return -1

    snap["account_control"] = count('a[aria-label*="Google Account"], a[href*="SignOutOptions"]') > 0
    snap["sign_in_link"] = count('a[href*="ServiceLogin"], a[aria-label="Sign in"]') > 0
    snap["input_box"] = count("rich-textarea") > 0
    try:
        area = d.find_elements(By.CSS_SELECTOR, '[data-node-type="input-area"]')
        labels = []
        if area:
            for el in area[0].find_elements(By.CSS_SELECTOR, "[aria-label]"):
                label = el.get_attribute("aria-label") or ""
                if label and label not in labels:
                    labels.append(label[:60])
        snap["input_area_labels"] = labels
    except Exception as e:
        snap["input_area_error"] = str(e)[:200]
    # The model / mode picker shows which model this account is on ("Fast", "2.5 Flash"…).
    try:
        snap["mode_buttons"] = [
            head(b.text, 40)
            for b in d.find_elements(By.CSS_SELECTOR, '[data-test-id*="mode"], button[aria-label*="mode" i]')
            if (b.text or "").strip()
        ][:4]
    except Exception:
        pass
    snap["notices"] = notices(gemini)
    return snap


def notices(gemini: Any) -> list[str]:
    from selenium.webdriver.common.by import By

    out: list[str] = []
    try:
        for el in gemini.driver.find_elements(By.CSS_SELECTOR, NOTICE_SELECTORS):
            try:
                if not el.is_displayed():
                    continue
            except Exception:
                continue
            text = head(el.text, 200)
            if text and text not in out:
                out.append(text)
    except Exception:
        pass
    return out[:6]


def sample(gemini: Any) -> dict[str, Any]:
    from selenium.webdriver.common.by import By

    d = gemini.driver
    row: dict[str, Any] = {}
    try:
        row["state"] = str(gemini.get_state()).split(".")[-1]
    except Exception as e:
        row["state"] = f"ERROR {type(e).__name__}"
    try:
        box = d.find_elements(By.TAG_NAME, "rich-textarea")
        row["input_chars"] = len(box[0].text) if box else None
    except Exception:
        row["input_chars"] = None
    try:
        resps = d.find_elements(By.TAG_NAME, "model-response")
        row["responses"] = len(resps)
        row["last_reply"] = head(resps[-1].text) if resps else ""
        row["last_reply_len"] = len(resps[-1].text) if resps else 0
    except Exception:
        pass
    row["notices"] = notices(gemini)
    return row


def run_prompt(gemini: Any, name: str, prompt: str, paste: bool, seconds: int = 150) -> None:
    emit("prompt", name=name, chars=len(prompt), paste=paste)
    sent_at = time.time()
    try:
        tc._gemini_send_message(gemini, prompt, paste=paste)
    except Exception as e:
        emit("send_error", name=name, error=f"{type(e).__name__}: {str(e)[:300]}")
        screenshot(gemini, f"{name}-send-error")
        return
    emit("sent", name=name, after_s=round(time.time() - sent_at, 1))

    last = None
    idle_with_reply = 0
    shot_mid = False
    while time.time() - sent_at < seconds:
        row = sample(gemini)
        key = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key != last:  # only state CHANGES, so the record stays readable
            emit("sample", name=name, at_s=round(time.time() - sent_at, 1), **row)
            last = key
        if not shot_mid and time.time() - sent_at > 10:
            screenshot(gemini, f"{name}-10s")
            shot_mid = True
        if row.get("state") == "IDLE" and row.get("last_reply_len"):
            idle_with_reply += 1
            if idle_with_reply >= 3:
                break
        else:
            idle_with_reply = 0
        time.sleep(1)

    final = sample(gemini)
    emit(
        "result",
        name=name,
        seconds=round(time.time() - sent_at, 1),
        state=final.get("state"),
        reply=final.get("last_reply"),
        reply_len=final.get("last_reply_len"),
        classified_as_backend_error=tc._looks_like_gemini_error_reply(final.get("last_reply") or ""),
        notices=final.get("notices"),
    )
    screenshot(gemini, f"{name}-end")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data_dir = tc._configured_profile_dir()
    udd = profiles.user_data_dir(data_dir)
    directory = profiles.directory_from_env()
    emit(
        "profile",
        user_data_dir=udd,
        profile_directory=directory or "(not set: Chrome picks)",
        profiles=profiles.read_profiles(udd),
        display=os.environ.get("DISPLAY"),
        disable_web_security=tc._disable_web_security(),
    )
    if directory:
        profiles.install(directory)

    lock = tc._ProfileLock(tc._lock_path())
    try:
        lock.acquire()
    except tc.HermexBusyError as e:
        emit("busy", error=str(e), hint="pm2 stop cms-translation-worker, then run this again")
        return 2

    gemini = None
    try:
        tc._cleanup_stale_chrome()
        tc._isolate_chromedriver()
        from hermex import Gemini

        gemini = Gemini(**tc._gemini_kwargs(False))
        gemini.open_url("https://gemini.google.com/app")
        time.sleep(8)
        emit("loaded", logged_in_per_hermex=getattr(gemini, "is_logged_in", None), **page_snapshot(gemini))
        screenshot(gemini, "loaded")
        tc._dismiss_gemini_overlays(gemini)
        emit("after_dismiss", **page_snapshot(gemini))

        for name, prompt, paste in PROMPTS:
            if name != PROMPTS[0][0]:
                tc._start_fresh_gemini_chat(gemini)
            run_prompt(gemini, name, prompt, paste)
        return 0
    except Exception as e:
        emit("fatal", error=f"{type(e).__name__}: {str(e)[:400]}")
        if gemini is not None:
            screenshot(gemini, "fatal")
        return 1
    finally:
        tc._close_gemini_browser(gemini)
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
