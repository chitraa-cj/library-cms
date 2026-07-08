#!/usr/bin/env python3
"""
Scrape acharya (guru-parampara) biographies from advaitadhara.sanatana.in and
emit a structured seed file for the CMS portal's Acharyas section.

Source model:
  - /public/profiles/index.json  -> guru-shishya tree; each node has a Devanagari
    `name` and (sometimes) a `url` like "profile/acharya/0026" or
    "profile/granthakara/0081". Nodes without a url are "Details Unavailable".
  - /profile/<ref>  -> HTML page with:
        <h1 id="name">          the Devanagari name
        <div class="name"> ...  name + life-dates (e.g. "788-820 A. D.")
        <div class="bio">       परिचयः — biography, first <p> is the heading,
                                remaining <p> are paragraphs (Sanskrit prose)
        <div class="works">     कृतयः — each work is <p class="title"> plus
                                optional <p class="type">, <p class="source">,
                                <div class="remarks">

We take the CMS's canonical ordered list of acharyas, resolve each to a profile
url (with a small override map for spelling variants the tree uses), scrape and
parse the profile, and write shared/data/acharya-profiles.seed.json. Names with
no source profile still get a record with an empty biography (editable later).

Re-run offline-safe: pass --no-network to only re-derive from cached HTML in
/tmp/adv_cache if present. Normally just: python3 scripts/scrape_acharya_profiles.py
"""

import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from html import unescape

BASE = "https://advaitadhara.sanatana.in"
INDEX_URL = f"{BASE}/public/profiles/index.json?v=1.1"
OUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "shared", "data", "acharya-profiles.seed.json",
)
CACHE_DIR = "/tmp/adv_cache"

# The CMS's canonical acharya list, in guru-parampara order (deduped, order preserved).
CANONICAL = [
    "शुकः", "गौडपादः", "गोविन्दभगवत्पादः", "शङ्कराचार्यभगवत्पादः", "तोटकाचार्यः",
    "पद्मपादः", "सुरेश्वराचार्यः", "हस्तामलकः", "सर्वज्ञात्मा", "उत्तमज्ञः",
    "चित्सुखः", "तत्वबोधभगवान्", "विज्ञानात्मा", "शङ्करानन्दः", "शुद्धानन्दः",
    "श्रीहर्षः", "सुखप्रकाशः", "प्रकाशानन्दः", "सदानन्दः", "आनन्दगिरिः",
    "अनुभूतिस्वरूपः", "विद्यातीर्थः", "आनन्दभारती", "भारतीतीर्थः", "रामेश्वरभारती",
    "विद्यारण्यः", "गौडब्रह्मानन्दः", "अच्युतकृष्णानन्दः", "अन्नम्भट्टः", "उपेन्द्रानन्दः",
    "त्र्यम्बकभट्टः", "बालकृष्णानन्दः", "राघवानन्दः", "शेषविश्वेश्वरः", "सदानन्दकाश्मीरी",
    "भट्टोजिदीक्षितः", "रङ्गराजाध्वरी", "विजयराघवः", "वेङ्कटनाथः", "शेषकृष्णः",
    "सच्चिदानन्दः", "आनन्दाश्रमः", "रङ्गोजी", "अप्पय्यदीक्षितः", "धर्मराजाध्वरी",
]

# Spelling variants the source tree uses that don't normalize-match our list.
OVERRIDE_REF = {
    "शङ्कराचार्यभगवत्पादः": "profile/acharya/0026",  # tree: शङ्कराचार्याभगवत्पादः
    "रङ्गोजी": "profile/granthakara/0187",            # tree: रङ्गोजिभट्टः
}

# English/enum aliases so an acharya can be linked to Granthas (BhashyamAuthor)
# and Teekas (TeekaAuthor). Keys are canonical Devanagari names; values are the
# exact enum strings used in shared/schema.ts (bhashyamAuthors / teekaAuthors).
ENUM_ALIASES = {
    "शङ्कराचार्यभगवत्पादः": ["Sri Shankarayacharya", "Sri Shankaracharya"],
    "आनन्दगिरिः": ["Anandagiri"],
    "सुरेश्वराचार्यः": ["Sureshvaracharya"],
    "पद्मपादः": ["Padmapada"],
    "चित्सुखः": ["Chitsukha"],
    "श्रीहर्षः": ["Shriharsha"],
    "शङ्करानन्दः": ["Shankarananda"],
    "विद्यारण्यः": ["Vidyaranya"],
    "भारतीतीर्थः": ["Bharathi Theertha"],
    "अप्पय्यदीक्षितः": ["Appayya Dikshita"],
    "सदानन्दः": ["Sadanandha"],
    "गौडब्रह्मानन्दः": ["Gauda Brahmananda"],
}

# ---- Devanagari -> IAST transliteration (compact, good enough for display) ----
_VOWELS = {
    "अ": "a", "आ": "ā", "इ": "i", "ई": "ī", "उ": "u", "ऊ": "ū",
    "ऋ": "ṛ", "ॠ": "ṝ", "ऌ": "ḷ", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
}
_MATRA = {
    "ा": "ā", "ि": "i", "ी": "ī", "ु": "u", "ू": "ū", "ृ": "ṛ", "ॄ": "ṝ",
    "ॢ": "ḷ", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
}
_CONS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ṅ",
    "च": "c", "छ": "ch", "ज": "j", "झ": "jh", "ञ": "ñ",
    "ट": "ṭ", "ठ": "ṭh", "ड": "ḍ", "ढ": "ḍh", "ण": "ṇ",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "ś",
    "ष": "ṣ", "स": "s", "ह": "h", "ळ": "ḻ",
}
_SIGNS = {"ं": "ṃ", "ः": "ḥ", "ँ": "m̐", "ऽ": "'"}


def to_iast(dev: str) -> str:
    out = []
    i = 0
    s = unicodedata.normalize("NFC", dev)
    while i < len(s):
        ch = s[i]
        if ch in _CONS:
            out.append(_CONS[ch])
            # look ahead: virama, matra, or implicit 'a'
            nxt = s[i + 1] if i + 1 < len(s) else ""
            if nxt == "्":  # virama -> no vowel
                i += 2
                continue
            if nxt in _MATRA:
                out.append(_MATRA[nxt])
                i += 2
                continue
            out.append("a")
            i += 1
            continue
        if ch in _VOWELS:
            out.append(_VOWELS[ch])
        elif ch in _SIGNS:
            out.append(_SIGNS[ch])
        elif ch == "्":
            pass
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def title_case(s: str) -> str:
    return " ".join(w[:1].upper() + w[1:] if w else w for w in s.split(" "))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.strip())
    s = s.replace("<", "").replace(">", "")
    s = s.replace("ः", "")
    s = re.sub(r"\s+", "", s)
    return s


def fetch(url: str, use_network: bool) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = re.sub(r"[^A-Za-z0-9]+", "_", url)
    cache = os.path.join(CACHE_DIR, key + ".html")
    if os.path.exists(cache):
        return open(cache, encoding="utf-8").read()
    if not use_network:
        raise RuntimeError(f"no cache and --no-network for {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (CMS acharya import)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", "replace")
    open(cache, "w", encoding="utf-8").write(html)
    time.sleep(0.4)
    return html


def build_flat(node, out):
    nm = (node.get("name") or "").strip()
    if nm:
        out[norm(nm)] = (nm, node.get("url"))
    for c in node.get("children", []) or []:
        build_flat(c, out)


def strip_tags(s: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", s)).strip()


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", strip_tags(s)).strip()


def parse_profile(html: str):
    """Return dict with dates, biography sections, and works from a profile page."""
    result = {"dates": None, "biography": [], "works": []}

    # dates: inside the .name block, everything after the <h1 id="name">
    nb = re.search(r'<div class="name">(.*?)</div>\s*</div>', html, re.S)
    if nb:
        block = nb.group(1)
        block = re.sub(r"<h1[^>]*>.*?</h1>", "", block, flags=re.S)
        txt = clean(block)
        if txt:
            result["dates"] = txt

    # biography: .bio div, <p> children. First <p> ("परिचयः") is the heading.
    bio = re.search(r'<div class="bio"[^>]*>(.*?)</div>\s*(?:<div class="works"|</div>)', html, re.S)
    if bio:
        paras = re.findall(r"<p[^>]*>(.*?)</p>", bio.group(1), re.S)
        cleaned = [clean(p) for p in paras]
        cleaned = [c for c in cleaned if c]
        heading = None
        body = cleaned
        if cleaned and cleaned[0] in ("परिचयः", "परिचय:"):
            heading = cleaned[0]
            body = cleaned[1:]
        result["biography"] = [{"heading": heading or "परिचयः", "paragraphs": body}]

    # works: .works div; each work = <p class="title"> + optional type/source/remarks
    works = re.search(r'<div class="works"[^>]*>(.*?)</div>\s*</div>\s*</div>', html, re.S)
    if not works:
        works = re.search(r'<div class="works"[^>]*>(.*)', html, re.S)
    if works:
        chunk = works.group(1)
        # split on each title paragraph
        parts = re.split(r'(?=<p class="title")', chunk)
        for part in parts:
            tm = re.search(r'<p class="title"[^>]*>(.*?)</p>', part, re.S)
            if not tm:
                continue
            title = clean(tm.group(1))
            if not title:
                continue
            typ = re.search(r'<p class="type"[^>]*>(.*?)</p>', part, re.S)
            src = re.search(r'<p class="source"[^>]*>(.*?)</p>', part, re.S)
            rem = re.search(r'<div class="remarks"[^>]*>(.*?)</div>', part, re.S)
            result["works"].append({
                "title": title,
                "type": clean(typ.group(1)) if typ else None,
                "source": clean(src.group(1)) if src else None,
                "remarks": clean(rem.group(1)) if rem else None,
            })
    return result


def ascii_slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s or "acharya"


def slug_from_ref(ref, iast):
    if ref:
        return ref.replace("profile/", "").replace("/", "-")  # acharya-0026
    return "n-" + ascii_slug(iast)


def main():
    use_network = "--no-network" not in sys.argv
    index = json.loads(fetch(INDEX_URL, use_network))
    flat = {}
    build_flat(index, flat)

    # parent map (guru) for lineage context
    parent = {}

    def walk_parents(node, guru=None):
        nm = (node.get("name") or "").strip()
        if nm and guru:
            parent[norm(nm)] = guru
        for c in node.get("children", []) or []:
            walk_parents(c, nm or guru)
    walk_parents(index)

    records = []
    stats = {"sourced": 0, "empty": 0}
    for order, dev in enumerate(CANONICAL):
        key = norm(dev)
        ref = OVERRIDE_REF.get(dev)
        tree_name = dev
        if not ref and key in flat:
            tree_name, ref = flat[key]
        category = None
        profile = {"dates": None, "biography": [], "works": []}
        if ref:
            category = "acharya" if "acharya" in ref else "granthakara"
            html = fetch(f"{BASE}/{ref}", use_network)
            profile = parse_profile(html)

        has_bio = bool(profile["biography"] and profile["biography"][0]["paragraphs"])
        iast = title_case(to_iast(dev))
        guru_dev = parent.get(key)
        aliases = sorted(set(
            [iast, dev] + ENUM_ALIASES.get(dev, [])
        ))
        rec = {
            "slug": slug_from_ref(ref, iast),
            "sourceRef": ref,
            "sourceUrl": f"{BASE}/{ref}" if ref else None,
            "nameDevanagari": dev,
            "nameIast": iast,
            "nameDisplay": iast,
            "aliases": aliases,
            "enumAliases": ENUM_ALIASES.get(dev, []),
            "dates": profile["dates"],
            "lineageOrder": order,
            "guruDevanagari": guru_dev,
            "category": category,
            "biography": profile["biography"],
            "worksList": profile["works"],
            "bioStatus": "sourced" if has_bio else "empty",
        }
        records.append(rec)
        stats["sourced" if has_bio else "empty"] += 1
        flag = "BIO" if has_bio else "---"
        print(f"[{flag}] {dev:22s} {iast:26s} works={len(profile['works']):2d}  {ref or 'no-profile'}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    payload = {
        "source": "https://advaitadhara.sanatana.in/Lineage",
        "count": len(records),
        "acharyas": records,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {len(records)} records ({stats['sourced']} with bios, "
          f"{stats['empty']} empty) -> {OUT_PATH}")


if __name__ == "__main__":
    main()
