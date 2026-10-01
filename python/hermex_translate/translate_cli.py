#!/usr/bin/env python3
"""
Translate Upanishad / grantha text via Hermex → Gemini web UI.

Reads JSON from stdin, writes JSON to stdout:
  {
    "sourceText": "...",
    "sourceLanguage": "English" | "Sanskrit",
    "targetLanguages": ["Tamil", "Kannada", ...],
    "context": "optional label",
    "chunkSize": 5,
    "headless": false
  }

Response:
  { "ok": true, "translations": [{ "language": "Tamil", "text": "..." }, ...] }
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Any

# Labels of buttons that DECLINE a transient Gemini prompt (location access,
# feature announcements). Matched as exact, case-folded labels — never substrings:
# a loose match would eventually click the affirmative button sitting next to them
# ("Use precise location") and silently grant a permission.
_DISMISS_BUTTON_LABELS = ("dismiss", "no thanks", "not now", "maybe later")
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("No JSON on stdin")
    return json.loads(raw)


def _strip_fences(text: str) -> str:
    cleaned = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if fence:
        return fence.group(1).strip()
    return cleaned


def _parse_jsonl_objects(cleaned: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in cleaned.splitlines():
        s = line.strip()
        if not s.startswith("{"):
            continue
        s = s.rstrip(",").strip()
        try:
            obj = json.loads(s)
            if isinstance(obj, dict):
                rows.append(obj)
        except json.JSONDecodeError:
            continue
    return rows


def _parse_marker_blocks(cleaned: str, expected: set[str]) -> list[dict[str, Any]]:
    """===LANGUAGE: Tamil=== blocks — reliable for long Unicode (no JSON escaping)."""
    rows: list[dict[str, Any]] = []
    pattern = re.compile(
        r"=+\s*(?:LANGUAGE:\s*)?([^\n=]+?)\s*=+\s*\n([\s\S]*?)(?=\n=+\s*(?:LANGUAGE:)?|$)",
        re.IGNORECASE,
    )
    for m in pattern.finditer(cleaned):
        lang_raw = m.group(1).strip()
        text = m.group(2).strip()
        if not text:
            continue
        lang = lang_raw
        if lang not in expected:
            match = next((e for e in expected if e.lower() == lang_raw.lower()), None)
            if match:
                lang = match
            else:
                continue
        rows.append({"language": lang, "text": text})
    return rows


def _parse_per_language_fragments(cleaned: str, expected: set[str]) -> list[dict[str, Any]]:
    """Salvage truncated/broken JSON when Gemini returns Hebrew text but omits closing quotes."""
    rows: list[dict[str, Any]] = []
    for lang in expected:
        pat = re.compile(
            rf'"language"\s*:\s*"{re.escape(lang)}"\s*,\s*"text"\s*:\s*"',
            re.IGNORECASE,
        )
        m = pat.search(cleaned)
        if not m:
            continue
        start = m.end()
        rest = cleaned[start:]
        end_m = re.search(r'"\s*,\s*"language"\s*:\s*"', rest)
        end_m2 = re.search(r'"\s*\}\s*,?', rest)
        end = len(rest)
        if end_m:
            end = min(end, end_m.start())
        elif end_m2:
            end = min(end, end_m2.start())
        text = rest[:end].strip()
        text = text.replace('\\"', '"').replace("\\n", "\n").rstrip('",}]')
        if len(text) >= 30:
            rows.append({"language": lang, "text": text})
            _log(f"[hermex] Salvaged partial translation for {lang} ({len(text)} chars)")
    return rows


def _salvage_translations(text: str, expected: set[str]) -> list[dict[str, Any]]:
    cleaned = _strip_fences(text)
    for parser in (_parse_marker_blocks, _parse_per_language_fragments, _parse_jsonl_objects, _parse_loose_language_text_pairs):
        rows = parser(cleaned, expected) if parser != _parse_jsonl_objects else parser(cleaned)
        if rows:
            return rows
    return []


def _parse_loose_language_text_pairs(cleaned: str, expected: set[str]) -> list[dict[str, Any]]:
    """Best-effort recovery when Gemini returns broken JSON (common on long Teeka text)."""
    rows: list[dict[str, Any]] = []
    pattern = re.compile(
        r'"language"\s*:\s*"([^"]+)"\s*,\s*"text"\s*:\s*"(.*?)"\s*(?=\}\s*,|\}\s*\]|$)',
        re.DOTALL,
    )
    for m in pattern.finditer(cleaned):
        lang = m.group(1).strip()
        text = m.group(2).replace('\\"', '"').replace("\\n", "\n").strip()
        if not lang or not text:
            continue
        if lang not in expected:
            match = next((e for e in expected if e.lower() == lang.lower()), None)
            if match:
                lang = match
            else:
                continue
        rows.append({"language": lang, "text": text})
    return rows


def _extract_translations(text: str, expected: set[str]) -> list[dict[str, Any]]:
    """Parse Gemini reply: JSON array, JSONL, or loose object recovery."""
    if not text:
        return []
    cleaned = _strip_fences(text)

    # 1) Strict JSON array. Only accept a list of translation-shaped OBJECTS: Gemini
    # now appends source citation markers ("… [2]") to marker-format replies, and the
    # first-"[" → last-"]" span can then be a perfectly valid JSON array like [2] that
    # hijacks this branch and makes a complete translation parse to zero rows.
    array_body = cleaned
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        array_body = cleaned[start : end + 1]
    try:
        data = json.loads(array_body)
        if isinstance(data, list) and data and all(isinstance(r, dict) for r in data):
            return data
    except json.JSONDecodeError as e:
        _log(f"[hermex] JSON array parse failed ({e}); trying JSONL / loose parse")

    # 2) JSONL (one object per line) — preferred for long text
    jsonl_rows = _parse_jsonl_objects(cleaned)
    if jsonl_rows:
        return jsonl_rows

    # 3) ===LANGUAGE: X=== marker blocks (long text)
    marker = _parse_marker_blocks(cleaned, expected)
    if marker:
        _log(f"[hermex] Parsed {len(marker)} translation(s) via marker blocks")
        return marker

    # 4) Per-language JSON fragments (truncated response)
    fragments = _parse_per_language_fragments(cleaned, expected)
    if fragments:
        return fragments

    # 5) Loose regex recovery
    loose = _parse_loose_language_text_pairs(cleaned, expected)
    if loose:
        _log(f"[hermex] Recovered {len(loose)} translation(s) via loose parse")
        return loose

    raise ValueError(f"Could not parse translations. Snippet: {cleaned[:400]}")


def _dump_raw_response(raw: str, label: str) -> str | None:
    """Persist a Gemini reply for post-mortem (always on an unusable reply,
    or for every reply when HERMEX_RAW_DUMP=1). Empty-chunk failures are
    otherwise invisible: the parse 'succeeds' with zero rows and the raw text
    is lost."""
    try:
        import os, datetime
        out_dir = os.environ.get("HERMEX_RAW_DUMP_DIR", "logs/hermex-raw")
        os.makedirs(out_dir, exist_ok=True)
        slug = re.sub(r"[^A-Za-z0-9]+", "-", label).strip("-")[:60] or "chunk"
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        path = os.path.join(out_dir, f"{stamp}-{slug}.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        return path
    except Exception:
        return None


def _effective_chunk_size(source_text: str, chunk_size: int) -> int:
    """Long Teeka/Bhashyam JSON from Gemini breaks — use smaller chunks."""
    n = len(source_text)
    if n > 3500:
        return 1
    if n > 1500:
        return min(chunk_size, 2)
    if n > 400:
        return min(chunk_size, 2)
    return chunk_size


_MAX_SOURCE_CHARS_DEFAULT = 6000
_SOURCE_CONTEXT_TAIL_CHARS = 400
_SENTENCE_END = re.compile(r"(?<=[।॥?!])\s+|(?<=[.?!])\s+")


def _max_source_chars() -> int:
    """Largest source text handed to Gemini in ONE turn.

    An ~18.5K-char BhashyamEntry asks Gemini for a ~13K-char answer and its backend
    simply refuses: every reply is one of its canned error strings ("I seem to be
    encountering an error") however often the identical prompt is re-sent, and
    `_effective_chunk_size` has no room left to help because the language count is
    already 1. So the SOURCE is split instead of the language list. 6000 sits below
    the ~8.5K that was observed answering reliably on the EC2 box."""
    raw = (os.environ.get("HERMEX_MAX_SOURCE_CHARS") or "").strip()
    if raw.isdigit() and int(raw) >= 500:
        return int(raw)
    return _MAX_SOURCE_CHARS_DEFAULT


def _split_paragraph(para: str, max_chars: int) -> list[str]:
    """Break one over-long paragraph on sentence ends (danda included), hard-slicing last."""
    if len(para) <= max_chars:
        return [para]
    out: list[str] = []
    buf = ""
    for sentence in (s for s in _SENTENCE_END.split(para) if s and s.strip()):
        candidate = f"{buf} {sentence}".strip() if buf else sentence
        if len(candidate) <= max_chars:
            buf = candidate
            continue
        if buf:
            out.append(buf)
            buf = ""
        while len(sentence) > max_chars:
            out.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        buf = sentence
    if buf:
        out.append(buf)
    return out


def _split_source(source_text: str, max_chars: int) -> list[str]:
    """Split a long source into <=max_chars pieces, preferring blank-line boundaries.

    Paragraphs are kept whole wherever they fit, so a piece boundary normally lands
    where the text already breaks. Returns a single element when the text fits."""
    text = source_text.strip()
    if len(text) <= max_chars:
        return [text]
    parts: list[str] = []
    buf = ""
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        for piece in _split_paragraph(para, max_chars):
            candidate = f"{buf}\n\n{piece}" if buf else piece
            if len(candidate) <= max_chars:
                buf = candidate
            else:
                if buf:
                    parts.append(buf)
                buf = piece
    if buf:
        parts.append(buf)
    return parts or [text]


def _query_timeout_for_source(source_text: str, base: int) -> int:
    """Scale wait for long inputs + long multilingual outputs (Teeka can exceed 15m)."""
    scaled = 900 + len(source_text) // 4
    return min(3600, max(base, scaled))


def _is_idle_timeout(err: BaseException) -> bool:
    msg = str(err).lower()
    return "did not reach state" in msg or "state.idle" in msg or "timeout" in msg


def _is_empty_response_error(err: BaseException) -> bool:
    msg = str(err).lower()
    return "neither text" in msg or "textnor image" in msg


def _is_click_intercepted(err: BaseException) -> bool:
    msg = str(err).lower()
    return "click intercepted" in msg or "not clickable at point" in msg


class GeminiTransientError(RuntimeError):
    """Gemini replied with one of its OWN canned backend-error strings.

    Neither a refusal nor a parse problem: the request never produced an answer, so
    re-sending the identical prompt immediately is pointless. Kept as its own type so
    the retry loop can back off in minutes, and so a run can give up instead of
    grinding the same oversized prompt through every remaining chunk."""


_GEMINI_ERROR_REPLIES = (
    "i'm having a hard time fulfilling your request",
    "i seem to be encountering an error",
    "i encountered an error doing what you asked",
    "i'm having trouble",
    "something went wrong",
    "please try again later",
)


def _looks_like_gemini_error_reply(text: str) -> bool:
    """True for Gemini's short canned error replies (see GeminiTransientError).

    Length-capped on purpose: a real translation never arrives this short, and the cap
    keeps a legitimate answer that happens to *mention* an error from being discarded."""
    t = " ".join((text or "").strip().lower().split())
    if not t or len(t) > 300:
        return False
    return any(phrase in t for phrase in _GEMINI_ERROR_REPLIES)


def _is_gemini_transient(err: BaseException) -> bool:
    return isinstance(err, GeminiTransientError)


_TRANSIENT_BACKOFF_STEPS = (1, 6, 18)


def _transient_backoff_sec(attempt: int = 1) -> int:
    """Cool-off after a canned error reply, escalating with the attempt number.

    Measured on the EC2 box: a single error reply almost always clears on the very next
    send, so attempt 1 waits seconds — a flat 60s there cost ~12 minutes of pure sleep
    per mantra (roughly half of 4 parts x 6 languages). A *repeat* is the signal that
    Gemini is genuinely under pressure, and only then is a long pause worth the wall
    clock. HERMEX_TRANSIENT_BACKOFF_SEC sets the first step; later steps scale from it."""
    base = 10
    raw = (os.environ.get("HERMEX_TRANSIENT_BACKOFF_SEC") or "").strip()
    if raw.isdigit() and int(raw) > 0:
        base = int(raw)
    step = _TRANSIENT_BACKOFF_STEPS[min(max(attempt, 1), len(_TRANSIENT_BACKOFF_STEPS)) - 1]
    return base * step


def _transient_abort_after() -> int:
    """Consecutive chunk attempts ending in a canned error reply that end the job.

    Without this a Gemini outage or an account limit costs one full oversized round
    trip per language per mantra for the rest of the run. 0 disables the breaker."""
    raw = (os.environ.get("HERMEX_TRANSIENT_ABORT_AFTER") or "").strip()
    if raw.isdigit():
        return int(raw)
    return 4


def _looks_like_clipboard_or_shell_garbage(text: str) -> bool:
    """get_markdown copies via clipboard — often picks up terminal/npm text."""
    t = text.strip()
    low = t.lower()
    if not t:
        return True
    if low.startswith("npm ") or low.startswith("npx ") or low.startswith("tsx "):
        return True
    if "npm run hermex" in low:
        return True
    # An env-var ASSIGNMENT pasted in from a terminal is garbage
    # ("HERMEX_PYTHON=/path", "export HERMEX_ENABLED=1"). A bare HERMEX_* token is
    # not: the smoke test deliberately asks Gemini to answer "HERMEX_TEST_OK", and
    # rejecting that made a perfectly good round-trip look like an empty response.
    if t.startswith("export "):
        return True
    if t.startswith("HERMEX_") and "=" in t.split("\n", 1)[0]:
        return True
    return False


def _dismiss_gemini_overlays(gemini: Any) -> None:
    """Close discovery/canvas cards that block the chat input (common on gemini.google.com/app)."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    driver = gemini.driver
    try:
        driver.execute_script(
            """
            for (const sel of [
              '[aria-label="Close"]', '[aria-label="Dismiss"]',
              'button[aria-label="Close dialog"]', '.dialog-close-button',
            ]) {
              document.querySelectorAll(sel).forEach((b) => { try { b.click(); } catch (_) {} });
            }
            document.querySelectorAll('img[alt*="Canvas"]').forEach((img) => {
              const card = img.closest('div[class*="discovery"], div[class*="card"], section');
              if (card) card.style.pointerEvents = 'none';
              if (card && card.parentElement) card.parentElement.style.display = 'none';
            });
            """
        )
    except Exception:
        pass

    # Gemini's location prompt ("Use precise location for Gemini?") renders Dismiss
    # as button TEXT with no aria-label, so the selector pass above walks straight
    # past it and the card keeps intercepting clicks on rich-textarea. Match on the
    # accessible name instead, via XPath (CSS cannot select by text). XPath 1.0 has
    # no lower-case(), hence translate().
    for label in _DISMISS_BUTTON_LABELS:
        xpath = (
            "//*[self::button or @role='button']["
            f"normalize-space(translate(., '{_ASCII_UPPER}', '{_ASCII_LOWER}'))"
            f"='{label}' or "
            f"normalize-space(translate(@aria-label, '{_ASCII_UPPER}',"
            f" '{_ASCII_LOWER}'))='{label}']"
        )
        try:
            buttons = driver.find_elements(By.XPATH, xpath)
        except Exception:
            continue
        for button in buttons:
            try:
                if not button.is_displayed() or not button.is_enabled():
                    continue
                button.click()
                _log(f"[hermex] Dismissed a Gemini prompt via its '{label}' button")
                time.sleep(0.3)
            except Exception:
                # Gone, re-rendered or not interactable — the caller retries its click.
                continue

    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
    except Exception:
        pass
    time.sleep(0.8)


def _gemini_send_message(gemini: Any, message: str, *, paste: bool) -> None:
    """Send without Hermex click() — avoids Canvas discovery overlay intercepting input."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    _dismiss_gemini_overlays(gemini)
    wait = WebDriverWait(gemini.driver, 25)
    input_box = wait.until(EC.presence_of_element_located((By.TAG_NAME, "rich-textarea")))
    gemini.driver.execute_script(
        "arguments[0].scrollIntoView({block:'center', inline:'nearest'});", input_box
    )
    time.sleep(0.5)
    _dismiss_gemini_overlays(gemini)
    input_p = input_box.find_element(By.TAG_NAME, "p")
    try:
        gemini.driver.execute_script("arguments[0].focus();", input_p)
    except Exception:
        pass
    try:
        input_p.click()
    except Exception:
        # A prompt can land between the scroll above and this click. Clear it and try
        # the REAL click once more; the JS click below stays the last resort because
        # it "succeeds" even while an overlay still covers the composer.
        _dismiss_gemini_overlays(gemini)
        try:
            input_p.click()
        except Exception:
            gemini.driver.execute_script("arguments[0].click();", input_p)
    if paste:
        gemini._paste_into(message, input_p, fake_typing=False)
    else:
        gemini._type_into(message, input_p)
    gemini.sleep(1)
    input_p.send_keys(Keys.ENTER)
    # In Gemini's current input UI the box empties the instant ENTER is pressed and the
    # send button is removed, so get_state() reports IDLE until the "Stop response" button
    # appears (~1s later). Without this guard wait_until_idle() can see that momentary
    # empty-idle box and return before generation even starts → empty/stale response read.
    # Block until generation visibly starts (Stop response present) before returning.
    _wait_generation_started(gemini, timeout=15)


def _wait_generation_started(gemini: Any, timeout: float = 15) -> bool:
    """After submit, wait until Gemini's 'Stop response' button appears (generation began).

    Returns True if generation started within `timeout`. Returns False if it never
    appeared (e.g. an unusually fast/short reply that finished between polls) — callers
    fall through to wait_until_idle()/fetch, which still recover via the empty-response
    retry path."""
    from selenium.webdriver.common.by import By

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if gemini.driver.find_elements(
                By.CSS_SELECTOR, '[data-node-type="input-area"] [aria-label="Stop response"]'
            ):
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def _should_reopen_browser(err: BaseException) -> bool:
    msg = str(err).lower()
    return any(
        s in msg
        for s in (
            "no such window",
            "invalid session",
            "session not created",
            "chrome not reachable",
            "cannot connect to chrome",
            "disconnected",
            "target window already closed",
            "web view not found",
            # The chromedriver/Chrome process died: the HTTP control connection to
            # the driver is gone. These must trigger a full relaunch — a page
            # refresh on a dead driver loops forever (the connection-refused spiral
            # that fails every remaining chunk of a mantra).
            "connection refused",
            "failed to establish a new connection",
            "max retries exceeded",
            "connection aborted",
            "remote end closed connection",
            "newconnectionerror",
            "errno 61",
            "actively refused",
        )
    )


def _cleanup_stale_chrome() -> None:
    """Kill orphaned chromedriver / automation Chrome after launch failures.

    Includes the Hermex Chrome profile dir so orphaned *visible*-fallback Chrome
    windows (which the headless-only patterns miss) are reaped — these accumulate
    on long macOS runs and wedge every subsequent launch with 'cannot connect to
    chrome'. The profile marker is automation-only, so a user's personal browser
    (default profile) is never touched. Override the marker with
    HERMEX_CHROME_PROFILE_MARKER if your Chrome profile path differs."""
    import os
    import subprocess

    _log("[hermex] Cleaning up stale chromedriver before relaunch")
    profile_marker = os.environ.get("HERMEX_CHROME_PROFILE_MARKER", "hermex/chrome_profile").strip()
    if sys.platform in ("darwin", "linux"):
        patterns = [
            "chromedriver",
            "undetected_chromedriver",
            "chrome-headless",
            "Google Chrome --headless",
        ]
        if profile_marker:
            patterns.append(profile_marker)
        for pattern in patterns:
            subprocess.run(["pkill", "-f", pattern], capture_output=True)

    # Remove stale Singleton lock files — a hard-killed Chrome leaves these, and a
    # fresh Chrome on the same profile then exits immediately ('cannot connect to
    # chrome'). Chrome recreates them on a clean launch, so removal is safe.
    profile_dir = (
        os.environ.get("HERMEX_CHROME_PROFILE_DIR")
        or os.environ.get("HERMEX_CHROME_PROFILE")
        or os.path.expanduser("~/Library/Application Support/hermex/chrome_profile")
    )
    for lock in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        lock_path = os.path.join(profile_dir, lock)
        try:
            if os.path.lexists(lock_path):
                os.remove(lock_path)
                _log(f"[hermex] Removed stale {lock}")
        except OSError as lock_err:
            _log(f"[hermex] Could not remove {lock}: {lock_err}")
    time.sleep(5)


def _headless_fallback_enabled() -> bool:
    import os

    v = os.environ.get("HERMEX_HEADLESS_FALLBACK", "").strip().lower()
    if v in ("0", "false", "no"):
        return False
    if v in ("1", "true", "yes"):
        return True
    return sys.platform == "darwin"


def _disable_web_security() -> bool:
    """Whether to launch Chrome with --disable-web-security (hermex's default).

    Gemini's web app stopped accepting message sends from a browser started with
    --disable-web-security (and the IsolateOrigins/site-per-process opt-out that
    hermex pairs with it): the chat loads and reads fine, but pressing Send — or
    even switching the model — silently fails with a "Something went wrong (1)"
    toast and the prompt stays sitting in the input box. get_state() then reports
    TYPING forever, so every chunk died in _wait_idle_or_stall as a 150s
    "generation stall". Verified by A/B on 2026-09-28: identical profile/account,
    disable_web_security=True → never sends, False → answers in ~3s.
    Set HERMEX_DISABLE_WEB_SECURITY=1 to restore the old behaviour."""
    import os

    v = os.environ.get("HERMEX_DISABLE_WEB_SECURITY", "").strip().lower()
    return v in ("1", "true", "yes")


def _launch_attempts() -> int:
    """How many full launch passes to make before giving up. Long grantha runs
    on macOS wedge Chrome ('cannot connect to chrome') and only recover after a
    stale-process cleanup + wait, so retry the launch rather than failing the
    whole job (which is what cascaded 1000+ chunks into the same error)."""
    import os

    n = int(os.environ.get("HERMEX_LAUNCH_ATTEMPTS", "0") or 0)
    return n if n > 0 else 4


def _chrome_profile_dir() -> str | None:
    """The persistent Chrome profile holding the Gemini login.

    On EC2 this is /home/ubuntu/hermex-translation/chrome-profile, passed in as
    HERMEX_CHROME_PROFILE by the CMS backend. It MUST be handed to Gemini as
    data_dir: without it hermex falls back to its own default profile directory,
    which on the server is a *different*, unauthenticated profile — every query
    then fails with a login error even though `hermex:setup` was completed. Left
    unset (local dev), hermex keeps using its own default, which is where
    `npm run hermex:setup` logged in."""
    import os

    value = (os.environ.get("HERMEX_CHROME_PROFILE") or "").strip()
    return value or None


def _gemini_kwargs(headless: bool) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "headless": headless,
        "disable_web_security": _disable_web_security(),
    }
    profile = _chrome_profile_dir()
    if profile:
        kwargs["data_dir"] = profile
    return kwargs


def _open_gemini_browser(headless: bool, *, after_cleanup: bool = False) -> Any:
    from hermex import Gemini

    modes: list[bool] = [headless]
    if headless and _headless_fallback_enabled():
        modes.append(False)

    max_attempts = _launch_attempts()
    last_err: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        for mode in modes:
            # Always clean orphaned chromedriver/Chrome before a retry attempt
            # (or when the caller knows the prior session died) — a wedged port
            # is the usual cause of 'cannot connect to chrome' on launch.
            if after_cleanup or attempt > 1:
                _cleanup_stale_chrome()
            try:
                profile = _chrome_profile_dir()
                _log(
                    f"[hermex] Launching Chrome (headless={mode}, attempt {attempt}/{max_attempts}, "
                    f"profile={profile or 'hermex default'}, display={os.environ.get('DISPLAY') or 'none'})"
                )
                gemini = Gemini(**_gemini_kwargs(mode))
                gemini.open_url("https://gemini.google.com/app")
                _dismiss_gemini_overlays(gemini)
                if not getattr(gemini, "is_logged_in", True):
                    _log("[hermex] WARN: Gemini session not logged in — run: npm run hermex:setup")
                if mode is False and headless:
                    _log("[hermex] Using visible Chrome — headless launch failed (common on macOS long runs)")
                return gemini
            except Exception as e:
                last_err = e
                if not _should_reopen_browser(e):
                    raise
                _log(f"[hermex] Browser launch failed (headless={mode}, attempt {attempt}): {e}")
                if mode is headless and len(modes) > 1:
                    _log("[hermex] Retrying with visible Chrome (HERMEX_HEADLESS_FALLBACK)")
        # All modes failed this pass — escalate: clean up, back off, try again.
        if attempt < max_attempts:
            wait = min(60.0, 10.0 * attempt)
            _log(f"[hermex] All launch modes failed (attempt {attempt}/{max_attempts}) — cleanup + wait {wait:.0f}s")
            _cleanup_stale_chrome()
            time.sleep(wait)
    if last_err is not None:
        raise last_err
    raise RuntimeError("Could not open Gemini browser")


def _close_gemini_browser(gemini: Any | None) -> None:
    if gemini is None:
        return
    try:
        gemini.close()
    except Exception:
        pass


def _recover_browser_session(gemini: Any) -> None:
    """Refresh Gemini without killing Chrome — avoids window flash on retries."""
    _try_stop_generation(gemini)
    try:
        gemini.refresh_page()
        if hasattr(gemini, "wait_for_page_load"):
            gemini.wait_for_page_load(45)
        else:
            time.sleep(5)
    except Exception:
        try:
            gemini.open_url("https://gemini.google.com/app")
        except Exception:
            pass
    _dismiss_gemini_overlays(gemini)
    time.sleep(3)


def _start_fresh_gemini_chat(gemini: Any) -> None:
    """Each language batch needs a clean chat — follow-ups often omit later languages."""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    _try_stop_generation(gemini)
    opened = False
    for selector in (
        '[aria-label="New chat"]',
        'button[aria-label="New chat"]',
        'a[href="/app"]',
    ):
        try:
            btn = WebDriverWait(gemini.driver, 4).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, selector))
            )
            btn.click()
            opened = True
            break
        except Exception:
            continue
    if not opened:
        gemini.open_url("https://gemini.google.com/app")
    if hasattr(gemini, "wait_for_page_load"):
        gemini.wait_for_page_load(45)
    else:
        time.sleep(4)
    _dismiss_gemini_overlays(gemini)
    time.sleep(1)


def _gemini_fetch_response(gemini: Any) -> Any:
    """Gemini often hits IDLE before .markdown is populated — poll before giving up."""
    from hermex.models import State

    last_err: BaseException | None = None
    for attempt in range(1, 11):
        try:
            try:
                if gemini.get_state() == State.GENERATING:
                    _log("[hermex] Still generating — waiting for completion")
                    gemini.wait_until_idle(timeout=180)
            except Exception:
                pass
            try:
                gemini.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            except Exception:
                pass
            time.sleep(2 if attempt < 4 else 4)
            msg = gemini.get_last_response(get_markdown=False)
            text = (msg.text or "").strip()
            if text and not _looks_like_clipboard_or_shell_garbage(text):
                return msg
            if text and _looks_like_clipboard_or_shell_garbage(text):
                _log("[hermex] Ignoring garbage .text (likely wrong element) — retrying read…")
                raise RuntimeError("Response contained neither text nor image.")
            raise RuntimeError("Response contained neither text nor image.")
        except RuntimeError as e:
            last_err = e
            if not _is_empty_response_error(e):
                raise
            _log(f"[hermex] Response not ready yet ({attempt}/10) — waiting for text…")
        except Exception as e:
            last_err = e
            raise
    raise last_err if last_err else RuntimeError("Empty Gemini response")


def _try_stop_generation(gemini: Any) -> None:
    """Click Gemini 'Stop response' if the model is stuck generating."""
    try:
        from hermex.models import State
        from selenium.webdriver.common.by import By

        if gemini.get_state() != State.GENERATING:
            return
        btn = gemini.driver.find_element(
            By.CSS_SELECTOR,
            '[data-node-type="input-area"] [aria-label="Stop response"]',
        )
        btn.click()
        time.sleep(3)
        _log("[hermex] Clicked Stop response (stuck generation)")
    except Exception as e:
        _log(f"[hermex] Could not stop generation: {e}")


def _wait_idle_or_stall(
    gemini: Any, timeout: float, *, stall_secs: float = 150, poll: float = 2.0
) -> None:
    """Wait until Gemini is IDLE, but abort early if generation STALLS.

    The package's wait_until_idle() only polls for the IDLE state, so if Gemini hangs
    mid-stream with the 'Stop response' button stuck visible it blocks for the FULL
    (up to 1h) timeout — the multi-minute hangs seen in practice. Here we additionally
    watch the streamed <model-response> text length: if it stops growing for
    `stall_secs` while not yet idle, we raise a (recoverable) timeout so the caller
    refreshes the chat and retries within minutes instead of an hour. Legitimately slow
    generations keep growing their text, so they are never aborted."""
    from selenium.common.exceptions import TimeoutException
    from selenium.webdriver.common.by import By
    from hermex.models import State

    start = time.time()
    last_len = -1
    last_growth = time.time()
    while time.time() - start < timeout:
        try:
            state = gemini.get_state()
        except Exception:
            state = None
        if state == State.IDLE:
            return
        try:
            resps = gemini.driver.find_elements(By.TAG_NAME, "model-response")
            cur_len = len(resps[-1].text) if resps else 0
        except Exception:
            cur_len = last_len
        if cur_len != last_len:
            last_len = cur_len
            last_growth = time.time()
        elif time.time() - last_growth > stall_secs:
            raise TimeoutException(
                f"Gemini generation stall timeout — no new text for {int(stall_secs)}s"
            )
        time.sleep(poll)
    raise TimeoutException(f"Gemini idle wait timeout after {int(timeout)}s")


def _gemini_query_with_recovery(
    gemini: Any,
    prompt: str,
    *,
    source_text: str,
    timeout: int,
) -> Any:
    """Send prompt, wait for IDLE, then poll for response text (avoids premature empty reads)."""
    use_paste = len(prompt) > 1200 or len(source_text) > 500
    effective_timeout = _query_timeout_for_source(source_text, timeout)
    if use_paste:
        _log(
            f"[hermex] Long prompt ({len(prompt)} chars) — paste mode, timeout={effective_timeout}s"
        )

    last_err: BaseException | None = None
    for attempt in range(1, 4):
        try:
            _dismiss_gemini_overlays(gemini)
            _gemini_send_message(gemini, prompt, paste=use_paste)
            _wait_idle_or_stall(gemini, effective_timeout)
            msg = _gemini_fetch_response(gemini)
            reply = getattr(msg, "text", "") or ""
            if _looks_like_gemini_error_reply(reply):
                # Gemini DID answer — with its own error string. Surfacing it as a parse
                # failure (the old behaviour) hid the cause and burned the chunk's retry
                # budget on an identical re-send. See GeminiTransientError.
                raise GeminiTransientError(reply.strip()[:200])
            return msg
        except Exception as e:
            last_err = e
            recoverable = (
                _is_idle_timeout(e)
                or _is_empty_response_error(e)
                or _is_click_intercepted(e)
                or _is_gemini_transient(e)
            )
            if not recoverable or attempt >= 3:
                raise
            cool = 4
            if _is_gemini_transient(e):
                kind = "Gemini backend error reply"
                cool = _transient_backoff_sec(attempt)
            elif _is_click_intercepted(e):
                kind = "UI overlay blocked input"
            elif _is_empty_response_error(e):
                kind = "empty response"
            else:
                kind = "generation timeout"
            _log(
                f"[hermex] {kind} (attempt {attempt}/3) — refreshing chat, waiting {cool:.0f}s"
            )
            _recover_browser_session(gemini)
            time.sleep(cool)
    raise last_err if last_err else RuntimeError("Gemini query failed")


def _build_prompt(
    source_text: str,
    source_language: str,
    target_languages: list[str],
    context: str,
    *,
    part_info: tuple[int, int] | None = None,
    preceding: str = "",
) -> str:
    langs = ", ".join(target_languages)
    ctx = f"\nContext: {context}" if context else ""
    # JSON arrays break easily for 2+ languages; marker blocks are more reliable.
    use_marker_format = (
        len(target_languages) > 1 or len(source_text) > 800 or part_info is not None
    )
    part_note = ""
    if part_info:
        idx, total = part_info
        part_note = (
            f"\nThis is PART {idx} of {total} of a longer passage being translated in "
            "sequence. Translate ONLY the source text below. Do not summarise it, do not "
            "add an introduction or closing remark, and do not repeat earlier parts. Keep "
            "terminology and transliteration consistent with the preceding context.\n"
        )
    prior = ""
    if preceding.strip():
        prior = (
            "\nPreceding context — the source text immediately before this part, given for "
            'continuity only. Do NOT translate it and do NOT echo it:\n"""\n'
            + preceding.strip()
            + '\n"""\n'
        )
    if use_marker_format:
        format_rules = """Output format (CRITICAL — do NOT use JSON for long text):
Use exactly this delimiter format for each language (copy language names exactly):

===LANGUAGE: <language name>===
<translation text only — no JSON, no quotes around the block>

Example for Tamil and Hindi:
===LANGUAGE: Tamil===
<Tamil translation here>
===LANGUAGE: Hindi===
<Hindi translation here>"""
    else:
        format_rules = """Output format:
- Return ONLY a valid JSON array, no markdown:
[{"language": "<exact language name>", "text": "<translation>"}]
- Escape double quotes inside text as \\". Use \\n for line breaks inside strings."""

    return f"""You are translating sacred Upanishad / Vedantic Sanskrit literature for a multilingual library.

Source language: {source_language}
{ctx}

{part_note}{prior}
Source text:
\"\"\"
{source_text.strip()}
\"\"\"

Translate the source text into EACH of these languages: {langs}

Rules:
- Preserve philosophical meaning and reverent tone.
- Use the native script for each language (e.g. Devanagari for Hindi, Tamil script for Tamil).
- For Egyptian_Arabic use Egyptian Arabic.
- For Mandarin use simplified Chinese unless the source clearly uses traditional.
- Do not add commentary, notes, or English explanations.
{format_rules}

The "language" field must be exactly one of: {langs}
"""


def _chunk(items: list[str], size: int) -> list[list[str]]:
    if size < 1:
        size = 1
    return [items[i : i + size] for i in range(0, len(items), size)]


def _normalize_rows(rows: list[dict[str, Any]], expected: set[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        lang = (row.get("language") or row.get("LanguageOfTranslation") or "").strip()
        text = (row.get("text") or row.get("translation") or row.get("TranslationText") or "").strip()
        if not lang or not text:
            continue
        if lang not in expected:
            # fuzzy: case-insensitive match
            match = next((e for e in expected if e.lower() == lang.lower()), None)
            if match:
                lang = match
            else:
                continue
        out.append({"language": lang, "text": text})
    return out


def _translate_chunks(
    *,
    source_text: str,
    source_language: str,
    target_languages: list[str],
    context: str,
    headless: bool,
    chunk_size: int,
    query_timeout: int,
    continue_on_error: bool,
    chunk_delay_sec: float = 5.0,
    max_retries: int = 1,
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    """Returns (successful rows, per-chunk log entries)."""
    all_results: list[dict[str, str]] = []
    chunk_logs: list[dict[str, Any]] = []
    eff_size = _effective_chunk_size(source_text, chunk_size)
    if eff_size < chunk_size:
        _log(f"[hermex] Long source ({len(source_text)} chars) — chunk size {chunk_size} → {eff_size}")
    chunks = _chunk(target_languages, eff_size)

    def _parse_chunk_response(raw: str, chunk: list[str], label: str = "chunk") -> list[dict[str, str]]:
        import os

        if os.environ.get("HERMEX_RAW_DUMP") == "1":
            dumped = _dump_raw_response(raw, label)
            if dumped:
                _log(f"[hermex] Raw reply ({len(raw)} chars) saved to {dumped}")
        if not raw:
            raise RuntimeError("Empty Gemini response")
        expected = set(chunk)
        try:
            parsed = _extract_translations(raw, expected)
            rows = _normalize_rows(parsed, expected)
            if not rows:
                # A parse that "succeeded" but yielded nothing usable (wrong shape,
                # wrong language names) must still try the salvage parsers before the
                # chunk is written off as empty.
                rows = _normalize_rows(_salvage_translations(raw, expected), expected)
        except ValueError as parse_err:
            _log(f"[hermex] Parse failed ({parse_err}) — salvaging from response body")
            salvaged = _salvage_translations(raw, expected)
            rows = _normalize_rows(salvaged, expected)
            if not rows:
                dumped = _dump_raw_response(raw, label)
                raise RuntimeError(
                    f"Could not parse response (raw saved to {dumped}). Snippet: {raw[:500]}"
                ) from parse_err
        if not rows:
            dumped = _dump_raw_response(raw, label)
            _log(
                f"[hermex] No usable rows parsed from a {len(raw)}-char reply — raw saved to {dumped}"
            )
        return rows

    def _translate_one_part(
        gemini: Any,
        chunk: list[str],
        label: str,
        part: str,
        *,
        fresh_chat: bool,
        part_info: tuple[int, int] | None = None,
        preceding: str = "",
    ) -> list[dict[str, str]]:
        if fresh_chat:
            _start_fresh_gemini_chat(gemini)
        prompt = _build_prompt(
            part,
            source_language,
            chunk,
            context,
            part_info=part_info,
            preceding=preceding,
        )
        msg = _gemini_query_with_recovery(
            gemini,
            prompt,
            source_text=part,
            timeout=query_timeout,
        )
        raw = (msg.text or "").strip()
        return _parse_chunk_response(raw, chunk, label)

    def _translate_language_batch(
        gemini: Any,
        chunk: list[str],
        chunk_label: str,
        *,
        fresh_chat: bool,
    ) -> list[dict[str, str]]:
        """Translate the source for `chunk`, splitting the SOURCE when it is too long.

        A source over `_max_source_chars()` is translated part by part and the parts are
        joined back per language. A language that loses ANY part is dropped entirely —
        storing a join that is silently missing its middle would be worse than a gap,
        and the caller's single-language retry re-does all of its parts."""
        max_chars = _max_source_chars()
        parts = _split_source(source_text, max_chars)
        if len(parts) == 1:
            return _translate_one_part(
                gemini, chunk, chunk_label, parts[0], fresh_chat=fresh_chat
            )

        _log(
            f"[hermex] Source {len(source_text)} chars > {max_chars} — translating in "
            f"{len(parts)} part(s) per language"
        )
        collected: dict[str, list[str]] = {lang: [] for lang in chunk}
        for i, part in enumerate(parts):
            alive = [lang for lang in chunk if lang in collected]
            if not alive:
                return []
            part_label = f"{chunk_label} | part {i + 1}/{len(parts)}"
            _log(f"[hermex] {part_label} ({len(part)} chars) | {', '.join(alive)}")
            rows = _translate_one_part(
                gemini,
                alive,
                part_label,
                part,
                fresh_chat=True,
                part_info=(i + 1, len(parts)),
                preceding=parts[i - 1][-_SOURCE_CONTEXT_TAIL_CHARS:] if i else "",
            )
            by_lang = {r["language"]: r["text"] for r in rows}
            for lang in alive:
                text = (by_lang.get(lang) or "").strip()
                if text:
                    collected[lang].append(text)
                else:
                    _log(f"[hermex] {part_label} | {lang} missing — dropping language")
                    collected.pop(lang, None)

        return [
            {"language": lang, "text": "\n\n".join(texts)}
            for lang, texts in collected.items()
            if len(texts) == len(parts)
        ]

    def _run_one_chunk(gemini: Any, idx: int, chunk: list[str]) -> None:
        label = context or "translation"
        chunk_label = f"{label} | chunk {idx + 1}/{len(chunks)}"
        _log(f"[hermex] START {chunk_label} | languages: {', '.join(chunk)} | headless={headless}")

        rows = _translate_language_batch(gemini, chunk, chunk_label, fresh_chat=True)
        got = {r["language"] for r in rows}
        missing = [lang for lang in chunk if lang not in got]

        if missing:
            if len(missing) == len(chunk):
                _log(f"[hermex] WARN entire chunk empty — will retry languages individually")
                try:
                    import os, datetime

                    out_dir = os.environ.get("HERMEX_RAW_DUMP_DIR", "logs/hermex-raw")
                    os.makedirs(out_dir, exist_ok=True)
                    shot = os.path.join(
                        out_dir,
                        datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-empty-chunk.png",
                    )
                    gemini.driver.save_screenshot(shot)
                    _log(f"[hermex] Saved page screenshot to {shot}")
                except Exception as shot_err:
                    _log(f"[hermex] Screenshot failed: {shot_err}")
            else:
                _log(
                    f"[hermex] Partial chunk ({len(rows)}/{len(chunk)}) — retrying: {', '.join(missing)}"
                )
            for lang in missing:
                single_label = f"{chunk_label} | {lang} (single)"
                try:
                    one_rows = _translate_language_batch(
                        gemini, [lang], single_label, fresh_chat=True
                    )
                    for r in one_rows:
                        if r["language"] not in got:
                            rows.append(r)
                            got.add(r["language"])
                except Exception as e:
                    _log(f"[hermex] FAIL {single_label} | {e}")

        missing = [lang for lang in chunk if lang not in got]
        all_results.extend(rows)
        for r in rows:
            if r["language"] in chunk:
                _log(f"[hermex] OK   {chunk_label} | {r['language']} ({len(r['text'])} chars)")
        for lang in missing:
            _log(f"[hermex] FAIL {chunk_label} | {lang} | not returned by Gemini")
        chunk_logs.append(
            {
                "chunk": idx + 1,
                "languages": chunk,
                "ok": [r["language"] for r in rows if r["language"] in chunk],
                "fail": missing,
                "error": None if not missing else "partial chunk",
            }
        )
        if missing and not continue_on_error:
            raise RuntimeError(f"Missing languages in chunk: {', '.join(missing)}")

    gemini: Any | None = None
    chunks_since_browser_open = 0
    browser_restart_every = 8 if headless else 12

    def _reopen_browser(*, force_cleanup: bool = False) -> Any:
        nonlocal gemini, chunks_since_browser_open
        _close_gemini_browser(gemini)
        gemini = _open_gemini_browser(headless, after_cleanup=force_cleanup)
        chunks_since_browser_open = 0
        return gemini

    def _safe_reopen(*, force_cleanup: bool = False) -> bool:
        """Reopen without propagating. A relaunch that still fails after the
        internal launch retries must fail only the current chunk (recorded via
        continue_on_error), never crash the whole job — that crash is what
        cascaded every remaining mantra into 'session not created'."""
        try:
            _reopen_browser(force_cleanup=force_cleanup)
            return True
        except Exception as reopen_err:
            _log(f"[hermex] Browser reopen failed (continuing to next chunk): {reopen_err}")
            return False

    transient_streak = 0
    abort_after = _transient_abort_after()

    try:
        _reopen_browser()
        for idx, chunk in enumerate(chunks):
            chunk_label = f"{context or 'translation'} | chunk {idx + 1}/{len(chunks)}"
            last_err: Exception | None = None
            for attempt in range(1, max(1, max_retries) + 1):
                if chunks_since_browser_open >= browser_restart_every:
                    _log(
                        f"[hermex] Proactive browser restart after {chunks_since_browser_open} chunks"
                    )
                    if not _safe_reopen(force_cleanup=True):
                        # Could not restart now — back off and let the next attempt
                        # retry rather than running a chunk on a dead browser.
                        last_err = last_err or RuntimeError("browser restart failed")
                        if attempt < max_retries:
                            time.sleep(chunk_delay_sec * attempt)
                        continue
                try:
                    _run_one_chunk(gemini, idx, chunk)
                    last_err = None
                    transient_streak = 0
                    chunks_since_browser_open += 1
                    break
                except Exception as e:
                    last_err = e
                    transient_streak = transient_streak + 1 if _is_gemini_transient(e) else 0
                    _log(f"[hermex] FAIL {chunk_label} | attempt {attempt}/{max_retries} | {e}")
                    if abort_after and transient_streak >= abort_after:
                        # Every attempt is coming back as Gemini's own error string, so the
                        # remaining chunks would each pay a full oversized round trip for
                        # nothing. Stop the job and let the checkpoint resume it later.
                        raise RuntimeError(
                            f"Gemini returned its own backend error on {transient_streak} "
                            "consecutive chunk attempts — aborting this job rather than "
                            "re-sending for every remaining chunk. Lower "
                            "HERMEX_MAX_SOURCE_CHARS, or set HERMEX_TRANSIENT_ABORT_AFTER=0 "
                            "to disable this guard."
                        ) from e
                    if attempt < max_retries:
                        wait = chunk_delay_sec * attempt
                        if _should_reopen_browser(e):
                            _log(f"[hermex] RETRY {chunk_label} in {wait:.0f}s (reopen browser)")
                            _safe_reopen(force_cleanup=True)
                        else:
                            _log(f"[hermex] RETRY {chunk_label} in {wait:.0f}s (same browser)")
                            _recover_browser_session(gemini)
                        time.sleep(wait)
            if last_err is not None:
                chunk_logs.append(
                    {
                        "chunk": idx + 1,
                        "languages": chunk,
                        "ok": [],
                        "fail": chunk,
                        "error": str(last_err),
                    }
                )
                if not continue_on_error:
                    raise last_err
            if idx < len(chunks) - 1 and chunk_delay_sec > 0:
                time.sleep(chunk_delay_sec)
    finally:
        _close_gemini_browser(gemini)

    return all_results, chunk_logs


def run_translate_batch(req: dict[str, Any]) -> dict[str, Any]:
    jobs: list[dict[str, Any]] = list(req.get("jobs") or [])
    if not jobs:
        raise ValueError("jobs must be a non-empty array for batch mode")

    headless = bool(req.get("headless"))
    chunk_size = int(req.get("chunkSize") or 5)
    query_timeout = int(req.get("queryTimeoutSec") or 600)
    continue_on_error = bool(req.get("continueOnError", True))

    results: list[dict[str, Any]] = []
    for job in jobs:
        source_text = (job.get("sourceText") or "").strip()
        if not source_text:
            raise ValueError(f"sourceText required for job {job.get('context') or '(unknown)'}")
        target_languages: list[str] = list(job.get("targetLanguages") or [])
        context = (job.get("context") or "").strip()
        if not target_languages:
            results.append({"context": context, "translations": [], "chunks": []})
            continue
        rows, chunk_logs = _translate_chunks(
            source_text=source_text,
            source_language=(job.get("sourceLanguage") or "English").strip(),
            target_languages=target_languages,
            context=context,
            headless=headless,
            chunk_size=chunk_size,
            query_timeout=query_timeout,
            continue_on_error=continue_on_error,
            chunk_delay_sec=float(req.get("chunkDelaySec") or 5),
            max_retries=int(req.get("maxRetries") or 1),
        )
        results.append({"context": context, "translations": rows, "chunks": chunk_logs})

    return {"ok": True, "results": results}


def run_translate(req: dict[str, Any]) -> dict[str, Any]:
    if req.get("jobs"):
        return run_translate_batch(req)

    source_text = (req.get("sourceText") or "").strip()
    if not source_text:
        raise ValueError("sourceText is required")

    target_languages: list[str] = list(req.get("targetLanguages") or [])
    if not target_languages:
        raise ValueError("targetLanguages must be a non-empty array")

    rows, chunk_logs = _translate_chunks(
        source_text=source_text,
        source_language=(req.get("sourceLanguage") or "English").strip(),
        target_languages=target_languages,
        context=(req.get("context") or "").strip(),
        headless=bool(req.get("headless")),
        chunk_size=int(req.get("chunkSize") or 5),
        query_timeout=int(req.get("queryTimeoutSec") or 600),
        continue_on_error=bool(req.get("continueOnError", True)),
        chunk_delay_sec=float(req.get("chunkDelaySec") or 5),
        max_retries=int(req.get("maxRetries") or 1),
    )
    return {"ok": True, "translations": rows, "chunks": chunk_logs}


def main() -> None:
    try:
        req = _read_request()
        result = run_translate(req)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    except Exception as e:
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
