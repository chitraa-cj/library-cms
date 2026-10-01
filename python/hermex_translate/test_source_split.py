#!/usr/bin/env python3
"""Pure-function tests for source splitting and Gemini error-reply detection.

No Chrome, no Gemini, no network — safe to run anywhere:
    python3 python/hermex_translate/test_source_split.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hermex_translate.translate_cli import (  # noqa: E402
    _build_prompt,
    _looks_like_gemini_error_reply,
    _max_source_chars,
    _split_source,
)

passed = 0
failed = 0


def check(label: str, cond: bool) -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}")


print("_split_source")
short = "Short source text."
check("text under the cap is returned whole", _split_source(short, 6000) == [short])

paras = [f"Paragraph {i} " + ("अहं ब्रह्म " * 60) for i in range(8)]
long_src = "\n\n".join(paras)
parts = _split_source(long_src, 2000)
check("long text is split", len(parts) > 1)
check("every part is within the cap", all(len(p) <= 2000 for p in parts))
check("no part is empty", all(p.strip() for p in parts))
joined = "".join(p.replace("\n\n", "") for p in parts).replace(" ", "")
check(
    "no source characters are lost",
    joined == long_src.replace("\n\n", "").replace(" ", ""),
)
check("boundaries land between paragraphs", all("Paragraph" in p for p in parts))

# A single paragraph far over the cap must still be broken up, on sentence ends.
one_para = " ".join(f"This is sentence number {i} of a very long paragraph." for i in range(200))
parts = _split_source(one_para, 1000)
check("an over-long single paragraph is split", len(parts) > 1)
check("sentence-split parts respect the cap", all(len(p) <= 1000 for p in parts))

# Devanagari danda is a sentence end too.
danda = "तत्त्वमसि। " * 400
parts = _split_source(danda, 1200)
check("danda-delimited text is split", len(parts) > 1 and all(len(p) <= 1200 for p in parts))

# No sentence boundary anywhere: hard slice rather than exceed the cap.
blob = "अ" * 5000
parts = _split_source(blob, 900)
check("boundary-free text is hard-sliced", all(len(p) <= 900 for p in parts))
check("hard slice keeps every character", sum(len(p) for p in parts) == 5000)

check("default cap is sane", 500 <= _max_source_chars() <= 20000)

print("\n_looks_like_gemini_error_reply")
for reply in (
    "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    "I seem to be encountering an error. Can I try something else for you?",
    "I encountered an error doing what you asked. Could you try again?",
    "Something went wrong. Please try again later.",
):
    check(f"detects {reply[:34]!r}...", _looks_like_gemini_error_reply(reply))

check("empty text is not an error reply", not _looks_like_gemini_error_reply(""))
check(
    "a real translation is not an error reply",
    not _looks_like_gemini_error_reply("===LANGUAGE: Bengali===\nআমি ব্রহ্ম। " * 50),
)
check(
    "a long answer that merely mentions an error survives the length cap",
    not _looks_like_gemini_error_reply(
        "Something went wrong is how one might render the phrase. " + ("x" * 400)
    ),
)

print("\n_transient_backoff_sec schedule")
from hermex_translate.translate_cli import _transient_backoff_sec  # noqa: E402

os.environ.pop("HERMEX_TRANSIENT_BACKOFF_SEC", None)
check("first retry is quick (a single hiccup usually clears)", _transient_backoff_sec(1) == 10)
check("second retry backs off hard", _transient_backoff_sec(2) == 60)
check("third retry backs off harder", _transient_backoff_sec(3) == 180)
check("escalates monotonically", _transient_backoff_sec(1) < _transient_backoff_sec(2) < _transient_backoff_sec(3))
check("out-of-range attempts are clamped", _transient_backoff_sec(0) == 10 and _transient_backoff_sec(99) == 180)
os.environ["HERMEX_TRANSIENT_BACKOFF_SEC"] = "60"
check("the env override sets the FIRST step", _transient_backoff_sec(1) == 60)
os.environ.pop("HERMEX_TRANSIENT_BACKOFF_SEC", None)

print("\n_build_prompt part framing")
p1 = _build_prompt("body text", "Sanskrit", ["Bengali"], "ctx", part_info=(2, 4), preceding="earlier text")
check("names the part number", "PART 2 of 4" in p1)
check("forbids re-translating the context", "Do NOT translate it" in p1)
check("includes the preceding tail", "earlier text" in p1)
check("uses marker format for parts", "===LANGUAGE:" in p1)
p0 = _build_prompt("body text", "Sanskrit", ["Bengali"], "ctx")
check("single-part prompt has no part note", "PART" not in p0)
check("single-part prompt has no context block", "Preceding context" not in p0)


# ---------------------------------------------------------------------------
# End-to-end multi-part flow, with Gemini replaced by a stub. Exercises the join
# and the "a language that loses one part is dropped" data-integrity rule.
# ---------------------------------------------------------------------------
from hermex_translate import translate_cli as tc  # noqa: E402


class _FakeMsg:
    def __init__(self, text: str) -> None:
        self.text = text


def _run_with_stub(reply_for, *, source: str, languages: list[str], cap: int = 2000):
    """Drive _translate_chunks with every browser/Gemini call stubbed out."""
    calls: list[dict] = []

    def fake_query(gemini, prompt, *, source_text, timeout):
        idx = len(calls) + 1
        calls.append({"prompt": prompt, "source_len": len(source_text)})
        return _FakeMsg(reply_for(idx, prompt))

    saved = {
        name: getattr(tc, name)
        for name in (
            "_open_gemini_browser",
            "_close_gemini_browser",
            "_start_fresh_gemini_chat",
            "_gemini_query_with_recovery",
        )
    }
    os.environ["HERMEX_MAX_SOURCE_CHARS"] = str(cap)
    try:
        tc._open_gemini_browser = lambda headless, after_cleanup=False: object()
        tc._close_gemini_browser = lambda gemini: None
        tc._start_fresh_gemini_chat = lambda gemini: None
        tc._gemini_query_with_recovery = fake_query
        rows, logs = tc._translate_chunks(
            source_text=source,
            source_language="Sanskrit",
            target_languages=languages,
            context="test",
            headless=True,
            chunk_size=1,
            query_timeout=60,
            continue_on_error=True,
            chunk_delay_sec=0,
            max_retries=1,
        )
        return rows, logs, calls
    finally:
        for name, fn in saved.items():
            setattr(tc, name, fn)
        os.environ.pop("HERMEX_MAX_SOURCE_CHARS", None)


big = "\n\n".join(f"Paragraph {i}. " + ("word " * 180) for i in range(10))
expected_parts = len(_split_source(big, 2000))

print("\nmulti-part flow (stubbed Gemini)")
rows, logs, calls = _run_with_stub(
    lambda idx, prompt: f"===LANGUAGE: Bengali===\nTRANSLATED-PART-{idx}",
    source=big,
    languages=["Bengali"],
)
check("source really needed splitting", expected_parts > 1)
check("one Gemini call per part", len(calls) == expected_parts)
check("each call carries only its part", all(c["source_len"] <= 2000 for c in calls))
check("one joined row is returned", len(rows) == 1 and rows[0]["language"] == "Bengali")
check(
    "parts are joined in order with a blank line",
    rows[0]["text"]
    == "\n\n".join(f"TRANSLATED-PART-{i + 1}" for i in range(expected_parts)),
)

# Drop the middle part: the language must be abandoned, not stored truncated.
rows, logs, calls = _run_with_stub(
    lambda idx, prompt: (
        "I seem to be encountering an error."
        if idx == 2
        else f"===LANGUAGE: Bengali===\nTRANSLATED-PART-{idx}"
    ),
    source=big,
    languages=["Bengali"],
)
check("a language missing one part yields no row", rows == [])
check("the failure is recorded in the chunk log", any(lg.get("fail") for lg in logs))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
