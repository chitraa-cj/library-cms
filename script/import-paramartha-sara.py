#!/usr/bin/env python3
"""
Import Paramartha Sara mantras (verses 1-87) into Strapi.

Source: the .docx in the project root. The doc contains TWO passes of all 87
verses; pass 2 (after the "Here is the complete Paramārthasāra..." header) is the
clean/definitive version and is the one we import. Three verses in pass 2 have
stray IAST words left inside the Devanagari (prāha / tamaḥ / svapuṣpam āsādya);
we substitute the correct Devanagari taken from pass 1.

Layout: each verse = Devanagari (2 padas, 2nd ends with "॥ N") followed by its
English translation paragraph.

Target (live, verified):
  Grantha "Paramartha Sara"  i2dgdp9ken486ozyv3t1wmvj
  Section "Prathama Adhyaya" v5vn87jufhvw0gnobe6d43fw
  Existing placeholder mantra "Shloka 1.1" (junk "test" text) -> overwritten.

Usage:
  python3 script/import-paramartha-sara.py --dry-run     # parse + preview, no writes
  python3 script/import-paramartha-sara.py               # push to Strapi
"""
import os, re, sys, glob, json, zipfile, urllib.request, urllib.error

# ── config ──────────────────────────────────────────────────────────────────
SECTION_DOC = "v5vn87jufhvw0gnobe6d43fw"
PLACEHOLDER_DOC = "ly231ah2bkp37my85xo5naxq"   # existing "Shloka 1.1" to overwrite
SORT_GAP = 100_000
DRY_RUN = "--dry-run" in sys.argv

def load_env():
    env = {}
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env

ENV = load_env()
STRAPI_URL = ENV.get("STRAPI_URL", "http://13.53.121.15:1337")
TOKEN = ENV.get("STRAPI_API_TOKEN", "")

# ── docx parse ────────────────────────────────────────────────────────────────
def doc_paragraphs():
    fn = next(iter(glob.glob("*.docx")), None)
    if not fn:
        sys.exit("No .docx found in project root")
    xml = zipfile.ZipFile(fn).read("word/document.xml").decode("utf-8")
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    out = []
    for p in paras:
        t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S))
        for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'")]:
            t = t.replace(a, b)
        t = t.strip()
        if t:
            out.append(t)
    return out, fn

DEV = re.compile(r"[ऀ-ॿ]")
LAT = re.compile(r"[A-Za-z]")
def is_dev(t):
    return len(DEV.findall(t)) > 3

# Pass 2 has three kinds of corruption in the Devanagari, all cross-checked
# against pass 1 and verified to produce the correct reading:
#   1. Whole IAST words left untranslated (prāha / tamaḥ / svapuṣpam āsādya).
#   2. Stray Bengali glyphs — the Bengali block (U+0980..09FF) is offset exactly
#      +0x80 from Devanagari (U+0900..097F), so a -0x80 shift restores the akṣara.
#   3. A Latin "ḥ" (U+1E25) used in place of the Devanagari visarga "ः".
IAST_FIXES = {
    "prāha": "प्राह",
    "tamaḥ": "तमः",
    "svapuṣpam āsādya": "स्वपुष्पमासाद्य",
}
def fix_skt(s):
    for bad, good in IAST_FIXES.items():     # word-level fixes first
        s = s.replace(bad, good)
    out = []                                  # then mechanical script normalization
    for ch in s:
        o = ord(ch)
        if 0x0980 <= o <= 0x09FF:             # Bengali -> Devanagari
            out.append(chr(o - 0x80))
        elif ch == "ḥ":                       # Latin h-with-dot -> visarga
            out.append("ः")
        else:
            out.append(ch)
    return "".join(out)

# Allowed in normalized Sanskrit: Devanagari, ASCII space, danda/double-danda,
# avagraha, common quotes/punct/digits used as verse markers.
_ALLOWED_NON_DEV = set(" ।॥ऽ'\"().,:;-–—/0123456789’‘‌‍")
def stray_chars(s):
    bad = []
    for ch in s:
        o = ord(ch)
        if 0x0900 <= o <= 0x097F or 0x0966 <= o <= 0x096F:
            continue
        if ch in _ALLOWED_NON_DEV:
            continue
        bad.append(ch)
    return bad

def parse_pass2(paras):
    # Pass 2 begins at the title that follows the "Here is the complete..." header.
    hdr = next(i for i, t in enumerate(paras) if t.startswith("Here is the complete"))
    # first verse line is the Devanagari right after the title line
    start = hdr + 2
    seq = paras[start:]
    verses = []
    i, n = 0, len(seq)
    while i < n:
        t = seq[i]
        if is_dev(t):
            sk = [t]
            m = re.search(r"॥\s*([\d०-९]+)", t)
            while not m and i + 1 < n and is_dev(seq[i + 1]):
                i += 1; sk.append(seq[i]); m = re.search(r"॥\s*([\d०-९]+)", seq[i])
            num = m.group(1) if m else None
            eng = []
            while i + 1 < n and not is_dev(seq[i + 1]):
                i += 1; eng.append(seq[i])
            if num is not None:        # drop trailing colophon (no number)
                verses.append({"num": int(num), "skt": [fix_skt(x) for x in sk], "eng": eng})
        i += 1
    return verses

# ── strapi blocks ─────────────────────────────────────────────────────────────
def blocks(lines):
    return [{"type": "paragraph", "children": [{"type": "text", "text": ln}]} for ln in lines]

def build_payload(v):
    return {
        "ShlokaManthraNumber": f"Shloka 1.{v['num']}",
        "order": v["num"] * SORT_GAP,
        "Section": SECTION_DOC,
        "ShlokaManthraEntry": {
            "SanskritTextEntry": blocks(v["skt"]),
            "EnglishTranslationText": blocks(v["eng"]),
        },
    }

# ── http ────────────────────────────────────────────────────────────────────
def req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(STRAPI_URL + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {TOKEN}")
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {path}: {e.read().decode()[:300]}")

# ── main ──────────────────────────────────────────────────────────────────────
def main():
    paras, fn = doc_paragraphs()
    verses = parse_pass2(paras)
    print(f"Source: {fn}")
    print(f"Parsed verses: {len(verses)}  (numbers {verses[0]['num']}..{verses[-1]['num']})")
    nums = [v["num"] for v in verses]
    assert nums == list(range(1, 88)), f"unexpected verse numbering: {nums}"
    # strict sanity: after normalization no non-Devanagari letters may remain
    leftover = {}
    for v in verses:
        for ln in v["skt"]:
            st = stray_chars(ln)
            if st:
                leftover[v["num"]] = sorted(set(st))
    print(f"Sanskrit lines per verse: {sorted(set(len(v['skt']) for v in verses))}; "
          f"English paras per verse: {sorted(set(len(v['eng']) for v in verses))}")
    print(f"Verses with stray non-Devanagari chars (should be empty): {leftover}")
    if leftover:
        sys.exit("Refusing to import: Sanskrit still contains non-Devanagari characters.")

    if DRY_RUN:
        for v in (verses[0], verses[2], verses[44], verses[70], verses[-1]):
            p = build_payload(v)
            print(f"\n--- {p['ShlokaManthraNumber']} (order {p['order']}) ---")
            print("  SKT:", " / ".join(v["skt"]))
            print("  ENG:", " ".join(v["eng"])[:160])
        print("\n[DRY RUN] no writes performed.")
        return

    if not TOKEN:
        sys.exit("STRAPI_API_TOKEN not set in .env")

    # Verse 1 -> overwrite the existing placeholder; 2..87 -> create new.
    v1 = verses[0]
    p1 = build_payload(v1)
    print(f"Updating placeholder {PLACEHOLDER_DOC} -> {p1['ShlokaManthraNumber']}")
    req(f"/api/manthras/{PLACEHOLDER_DOC}", "PUT", {"data": p1})
    created = 1
    for v in verses[1:]:
        p = build_payload(v)
        req("/api/manthras", "POST", {"data": p})
        created += 1
        if created % 10 == 0:
            print(f"  ...{created}/87")
    print(f"DONE: 1 updated + {created-1} created = {created} mantras in Prathama Adhyaya.")

if __name__ == "__main__":
    main()
