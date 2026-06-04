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
import re
import sys
import time
from typing import Any


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
        r"===\s*(?:LANGUAGE:\s*)?([^\n=]+?)\s*===\s*\n([\s\S]*?)(?=\n===\s*(?:LANGUAGE:)?|$)",
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

    # 1) Strict JSON array
    array_body = cleaned
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        array_body = cleaned[start : end + 1]
    try:
        data = json.loads(array_body)
        if isinstance(data, list) and data:
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
    if t.startswith("HERMEX_") or t.startswith("export "):
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
        gemini.driver.execute_script("arguments[0].click();", input_p)
    if paste:
        gemini._paste_into(message, input_p, fake_typing=False)
    else:
        gemini._type_into(message, input_p)
    gemini.sleep(1)
    input_p.send_keys(Keys.ENTER)


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
        )
    )


def _cleanup_stale_chrome() -> None:
    """Kill orphaned chromedriver / helper Chrome after repeated launch failures."""
    import subprocess

    _log("[hermex] Cleaning up stale chromedriver before relaunch")
    if sys.platform in ("darwin", "linux"):
        for pattern in (
            "chromedriver",
            "undetected_chromedriver",
            "chrome-headless",
            "Google Chrome --headless",
        ):
            subprocess.run(["pkill", "-f", pattern], capture_output=True)
    time.sleep(5)


def _headless_fallback_enabled() -> bool:
    import os

    v = os.environ.get("HERMEX_HEADLESS_FALLBACK", "").strip().lower()
    if v in ("0", "false", "no"):
        return False
    if v in ("1", "true", "yes"):
        return True
    return sys.platform == "darwin"


def _open_gemini_browser(headless: bool, *, after_cleanup: bool = False) -> Any:
    from hermex import Gemini

    modes: list[bool] = [headless]
    if headless and _headless_fallback_enabled():
        modes.append(False)

    last_err: BaseException | None = None
    for mode in modes:
        if after_cleanup or last_err is not None:
            _cleanup_stale_chrome()
        try:
            _log(f"[hermex] Launching Chrome (headless={mode})")
            gemini = Gemini(headless=mode)
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
            _log(f"[hermex] Browser launch failed (headless={mode}): {e}")
            if mode is headless and len(modes) > 1:
                _log("[hermex] Retrying with visible Chrome (HERMEX_HEADLESS_FALLBACK)")
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
            gemini.wait_until_idle(timeout=effective_timeout)
            return _gemini_fetch_response(gemini)
        except Exception as e:
            last_err = e
            recoverable = (
                _is_idle_timeout(e)
                or _is_empty_response_error(e)
                or _is_click_intercepted(e)
            )
            if not recoverable or attempt >= 3:
                raise
            if _is_click_intercepted(e):
                kind = "UI overlay blocked input"
            elif _is_empty_response_error(e):
                kind = "empty response"
            else:
                kind = "generation timeout"
            _log(f"[hermex] {kind} (attempt {attempt}/3) — refreshing chat")
            _recover_browser_session(gemini)
            time.sleep(4)
    raise last_err if last_err else RuntimeError("Gemini query failed")


def _build_prompt(
    source_text: str,
    source_language: str,
    target_languages: list[str],
    context: str,
) -> str:
    langs = ", ".join(target_languages)
    ctx = f"\nContext: {context}" if context else ""
    # JSON arrays break easily for 2+ languages; marker blocks are more reliable.
    use_marker_format = len(target_languages) > 1 or len(source_text) > 800
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

    def _parse_chunk_response(raw: str, chunk: list[str]) -> list[dict[str, str]]:
        if not raw:
            raise RuntimeError("Empty Gemini response")
        expected = set(chunk)
        try:
            parsed = _extract_translations(raw, expected)
            rows = _normalize_rows(parsed, expected)
        except ValueError as parse_err:
            _log(f"[hermex] Parse failed ({parse_err}) — salvaging from response body")
            salvaged = _salvage_translations(raw, expected)
            rows = _normalize_rows(salvaged, expected)
            if not rows:
                raise RuntimeError(f"Could not parse response. Snippet: {raw[:500]}") from parse_err
        return rows

    def _translate_language_batch(
        gemini: Any,
        chunk: list[str],
        chunk_label: str,
        *,
        fresh_chat: bool,
    ) -> list[dict[str, str]]:
        if fresh_chat:
            _start_fresh_gemini_chat(gemini)
        prompt = _build_prompt(source_text, source_language, chunk, context)
        msg = _gemini_query_with_recovery(
            gemini,
            prompt,
            source_text=source_text,
            timeout=query_timeout,
        )
        raw = (msg.text or "").strip()
        return _parse_chunk_response(raw, chunk)

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
                    _reopen_browser(force_cleanup=True)
                try:
                    _run_one_chunk(gemini, idx, chunk)
                    last_err = None
                    chunks_since_browser_open += 1
                    break
                except Exception as e:
                    last_err = e
                    _log(f"[hermex] FAIL {chunk_label} | attempt {attempt}/{max_retries} | {e}")
                    if attempt < max_retries:
                        wait = chunk_delay_sec * attempt
                        if _should_reopen_browser(e):
                            _log(f"[hermex] RETRY {chunk_label} in {wait:.0f}s (reopen browser)")
                            _reopen_browser(force_cleanup=True)
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
