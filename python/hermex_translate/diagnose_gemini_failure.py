#!/usr/bin/env python3
"""Why does a part that passes in isolation fail in the real job? Controlled trials.

Runs the EXACT production prompts (built by `translate_cli._build_prompt` from the
real Strapi source) against the real Gemini session, varying ONE thing at a time, and
records each trial as a JSON line. Read-only: it GETs the source from Strapi and never
writes anything back, never touches the Chrome profile, and never runs a real job.

Hypotheses it separates:

  A  production conditions          PART 2, fresh chat each time   -> baseline failure rate
  B  position in chat               PART 2, SAME chat, repeated    -> is only the FIRST
                                                                      message in a chat bad?
  C  content                        PART 1, fresh chat each time   -> is it this part's text?
  D  size/format                    synthetic 4K / 5K, fresh chat  -> is it length or prose?

Usage (on the box, from the CMS directory):

    set -a; . ./.env; set +a
    DISPLAY=:99 HERMEX_DIAGNOSTIC=1 \\
      /home/ubuntu/hermex-translation/.venv/bin/python \\
      python/hermex_translate/diagnose_gemini_failure.py \\
      --grantha "Vedanta Paribhasha" --mantra 2.4.1 --field BhashyamEntry

Options: --repeat N (per cell, default 3), --only A,B,C,D, --lang Bengali,
--out logs/hermex-diagnostics/<timestamp>.jsonl

NEVER logged: cookies, tokens, account data, or source/translation text (only
lengths, timings, outcome, and a short head of Gemini's own reply).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import translate_cli as tc  # noqa: E402

OUTCOME_SUCCESS = "SUCCESS"
OUTCOME_CANNED = "CANNED_BACKEND_ERROR"
OUTCOME_PARSE = "PARSE_FAILURE"
OUTCOME_TIMEOUT = "TIMEOUT_OR_EMPTY"
OUTCOME_OTHER = "OTHER_ERROR"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ──────────────────────────────────────────────────────────── Strapi (read-only)
def strapi_get(path: str) -> Any:
    base = (os.environ.get("STRAPI_URL") or "").rstrip("/")
    token = os.environ.get("STRAPI_API_TOKEN") or ""
    if not base or not token:
        raise SystemExit("STRAPI_URL and STRAPI_API_TOKEN must be set (set -a; . ./.env; set +a)")
    req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - fixed host from env
        return json.loads(resp.read().decode("utf-8"))


def blocks_to_text(blocks: Any) -> str:
    """Strapi rich-text blocks -> plain text (same shape the pipeline translates)."""
    if isinstance(blocks, str):
        return blocks
    out: list[str] = []
    for block in blocks or []:
        children = block.get("children") or [] if isinstance(block, dict) else []
        out.append("".join(c.get("text", "") for c in children if isinstance(c, dict)))
    return "\n\n".join(p for p in out if p.strip())


def fetch_source(grantha: str, mantra: str, field: str) -> str:
    q = urllib.parse.quote(grantha)
    found = strapi_get(
        f"/api/granthas?filters[GranthaName][$containsi]={q}"
        "&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5"
    )
    rows = found.get("data") or []
    if not rows:
        raise SystemExit(f"No grantha matching {grantha!r}")
    g = rows[0]
    log(f"[diag] grantha {g['GranthaName']} ({g['documentId']})")

    listing = strapi_get(
        f"/api/manthras?filters[Section][grantha][documentId][$eq]={g['documentId']}"
        "&fields[0]=documentId&fields[1]=ShlokaManthraNumber"
        "&sort[0]=order:asc&pagination[pageSize]=500"
    )
    target = None
    for m in listing.get("data") or []:
        if str(m.get("ShlokaManthraNumber") or "").strip().endswith(mantra):
            target = m
            break
    if not target:
        raise SystemExit(f"No mantra ending in {mantra!r} in that grantha")
    log(f"[diag] mantra {target['ShlokaManthraNumber']} ({target['documentId']})")

    full = strapi_get(f"/api/manthras/{target['documentId']}{tc_mantra_query()}")
    entry = (full.get("data") or {}).get(field) or {}
    text = blocks_to_text(entry.get("EnglishTranslationText"))
    if not text.strip():
        raise SystemExit(f"{field}.EnglishTranslationText is empty for that mantra")
    return text


def tc_mantra_query() -> str:
    return (
        "?populate[Teekas][populate][TeekaEntry][populate]=*"
        "&populate[ShlokaManthraEntry][populate]=*"
        "&populate[BhashyamEntry][populate]=*"
    )


# ───────────────────────────────────────────────────────────────── one trial
def conversation_state(gemini: Any) -> str:
    """Whether the browser is on a NEW chat or inside an existing conversation.

    Only the shape is reported — never the conversation id, which is account data.
    """
    try:
        url = gemini.driver.current_url or ""
    except Exception:
        return "unknown"
    if re.search(r"/app/[0-9a-f]{6,}", url):
        return "existing-conversation"
    if "/app" in url:
        return "new-chat"
    return "other"


def run_trial(
    gemini: Any,
    *,
    cell: str,
    prompt: str,
    source: str,
    lang: str,
    fresh_chat: bool,
    position: int,
    timeout: int,
) -> dict[str, Any]:
    if fresh_chat:
        tc._start_fresh_gemini_chat(gemini)

    record: dict[str, Any] = {
        "cell": cell,
        "position_in_chat": position,
        "fresh_chat": fresh_chat,
        "language": lang,
        "prompt_chars": len(prompt),
        "source_chars": len(source),
        "paste": len(prompt) > 1200 or len(source) > 500,
        "fake_typing": False,
        "chat_state_before": conversation_state(gemini),
        "started_at": datetime.now().isoformat(timespec="seconds"),
    }

    started = time.time()
    try:
        # Deliberately NOT _gemini_query_with_recovery: one trial must be ONE send,
        # or the retry loop would hide the per-request outcome we are measuring.
        tc._dismiss_gemini_overlays(gemini)
        tc._gemini_send_message(gemini, prompt, paste=record["paste"])
        tc._wait_idle_or_stall(gemini, timeout)
        msg = tc._gemini_fetch_response(gemini)
        reply = (getattr(msg, "text", "") or "").strip()
        record["reply_chars"] = len(reply)
        record["reply_head"] = reply[:60]
        if tc._looks_like_gemini_error_reply(reply):
            record["outcome"] = OUTCOME_CANNED
        else:
            rows = tc._normalize_rows(tc._extract_translations(reply, {lang}), {lang})
            record["outcome"] = OUTCOME_SUCCESS if rows else OUTCOME_PARSE
            record["parsed_langs"] = [r["language"] for r in rows]
    except Exception as e:
        name = type(e).__name__
        text = str(e)
        record["reply_chars"] = 0
        record["error_type"] = name
        record["error_head"] = text[:120]
        if tc._is_empty_response_error(e) or tc._is_idle_timeout(e):
            record["outcome"] = OUTCOME_TIMEOUT
        else:
            record["outcome"] = OUTCOME_OTHER
    record["elapsed_sec"] = round(time.time() - started, 1)
    record["chat_state_after"] = conversation_state(gemini)
    return record


SYNTHETIC_SENTENCE = (
    "The knower of Brahman attains the highest, for the Self is untouched by the "
    "modifications of name and form, and the witness remains ever unchanged. "
)


def synthetic_source(target_chars: int) -> str:
    out = []
    n = 0
    while n < target_chars:
        out.append(SYNTHETIC_SENTENCE)
        n += len(SYNTHETIC_SENTENCE)
    return "".join(out)[:target_chars]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grantha", default="Vedanta Paribhasha")
    ap.add_argument("--mantra", default="2.4.1")
    ap.add_argument("--field", default="BhashyamEntry")
    ap.add_argument("--lang", default="Bengali")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--only", default="A,B,C,D")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    cells = {c.strip().upper() for c in args.only.split(",") if c.strip()}
    out_path = Path(
        args.out
        or f"logs/hermex-diagnostics/{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    source = fetch_source(args.grantha, args.mantra, args.field)
    parts = tc._split_source(source, tc._max_source_chars())
    log(f"[diag] source {len(source)} chars -> {len(parts)} parts: {[len(p) for p in parts]}")
    if len(parts) < 2:
        log("[diag] WARNING: source did not split into 2+ parts; cells A/B/C degenerate")

    def prompt_for(part: str, idx: int, total: int) -> str:
        return tc._build_prompt(
            part,
            "English",
            [args.lang],
            f"{args.grantha} — {args.mantra} — {args.field}",
            part_info=(idx, total),
        )

    p1 = prompt_for(parts[0], 1, len(parts))
    p2 = prompt_for(parts[min(1, len(parts) - 1)], 2, len(parts))
    s4 = synthetic_source(4000)
    s5 = synthetic_source(5000)
    log(
        f"[diag] PART1 prompt {len(p1)} (overhead {len(p1) - len(parts[0])}) | "
        f"PART2 prompt {len(p2)} (overhead {len(p2) - len(parts[min(1, len(parts) - 1)])})"
    )

    plan: list[tuple[str, str, str, bool]] = []  # (cell, prompt, source, fresh_chat)
    for _ in range(args.repeat):
        if "A" in cells:
            plan.append(("A_part2_freshchat", p2, parts[min(1, len(parts) - 1)], True))
    if "B" in cells:
        # First send opens the chat; the rest reuse it. Position is what matters here.
        plan.append(("B_part2_samechat", p2, parts[min(1, len(parts) - 1)], True))
        for _ in range(max(1, args.repeat - 1)):
            plan.append(("B_part2_samechat", p2, parts[min(1, len(parts) - 1)], False))
    for _ in range(args.repeat):
        if "C" in cells:
            plan.append(("C_part1_freshchat", p1, parts[0], True))
    for _ in range(max(1, args.repeat - 1)):
        if "D" in cells:
            plan.append(("D_synth4k_freshchat", prompt_for(s4, 1, 1), s4, True))
            plan.append(("D_synth5k_freshchat", prompt_for(s5, 1, 1), s5, True))

    log(f"[diag] {len(plan)} trial(s) planned -> {out_path}")

    gemini = tc._open_gemini_browser(headless=False)
    records: list[dict[str, Any]] = []
    position = 0
    try:
        warm = tc._warm_up_gemini(gemini)
        log(f"[diag] warm-up ok={warm}")
        for i, (cell, prompt, src, fresh) in enumerate(plan, 1):
            position = 1 if fresh else position + 1
            rec = run_trial(
                gemini,
                cell=cell,
                prompt=prompt,
                source=src,
                lang=args.lang,
                fresh_chat=fresh,
                position=position,
                timeout=args.timeout,
            )
            records.append(rec)
            with out_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            log(
                f"[diag] {i}/{len(plan)} {cell} pos={rec['position_in_chat']} "
                f"prompt={rec['prompt_chars']} -> {rec['outcome']} "
                f"({rec['elapsed_sec']}s, reply {rec.get('reply_chars', 0)} chars)"
            )
            time.sleep(5)
    finally:
        tc._close_gemini_browser(gemini)

    print("\n=== outcomes by cell ===")
    cells_seen: dict[str, dict[str, int]] = {}
    for r in records:
        cells_seen.setdefault(r["cell"], {}).setdefault(r["outcome"], 0)
        cells_seen[r["cell"]][r["outcome"]] += 1
    for cell, counts in cells_seen.items():
        print(f"  {cell:26s} " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    print("\n=== outcomes by position in chat ===")
    by_pos: dict[int, dict[str, int]] = {}
    for r in records:
        by_pos.setdefault(r["position_in_chat"], {}).setdefault(r["outcome"], 0)
        by_pos[r["position_in_chat"]][r["outcome"]] += 1
    for pos in sorted(by_pos):
        print(f"  position {pos}: " + ", ".join(f"{k}={v}" for k, v in sorted(by_pos[pos].items())))

    print(f"\nfull records: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
