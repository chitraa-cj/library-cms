#!/usr/bin/env python3
"""
Scrape the advaitadhara Lineage profiles that are NOT yet in acharya_profiles.

The Lineage tree colours its nodes by profile kind: blue = profile/acharya/*
(अद्वैताचार्याः), green = profile/granthakara/* (अद्वैतग्रन्थकर्ताः), black = no
profile. scrape_acharya_profiles.py only took a fixed list of 45 names, so most
green nodes never came in. This walks the whole tree, drops every node already
present (by source_ref, or by normalized Devanagari name / alias), scrapes the
rest and writes seed-format records for script/import-acharyas-insert-only.ts.

  python3 scripts/scrape_lineage_missing.py \
      --existing <export.json>   # {"rows": [...acharya_profiles rows...]}
      --kind granthakara         # granthakara | acharya | all
      --out <records.json>

Names that only *nearly* match an existing acharya (a known spelling variant) are
listed in SKIP_AS_EXISTING and reported, never emitted — the import must not
create a second profile for someone we already have.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scrape_acharya_profiles as sap  # noqa: E402

# Tree url -> the existing profile it duplicates (a spelling variant of a name we
# already have, so normalized matching cannot see it).
SKIP_AS_EXISTING = {
    "profile/granthakara/0075": "ज्ञानघनपादः",   # tree: ज्ञानघनः (Tattvaśuddhi)
    "profile/granthakara/0099": "नल्लकविः",      # tree: नल्लासुधीः (pupil of Sadāśiva Brahmendra)
}

# New rows sort after the 45 lineage-ordered ones, in tree order.
LINEAGE_ORDER_BASE = 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--existing", required=True)
    ap.add_argument("--kind", choices=["granthakara", "acharya", "all"], default="granthakara")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache-dir", default=sap.CACHE_DIR)
    args = ap.parse_args()
    sap.CACHE_DIR = args.cache_dir

    rows = json.load(open(args.existing, encoding="utf-8"))["rows"]
    have_ref = {r["source_ref"] for r in rows if r.get("source_ref")}
    have_name = set()
    for r in rows:
        for n in [r["name_devanagari"], *(r.get("aliases") or [])]:
            have_name.add(sap.norm(n))
    have_slug = {r["slug"] for r in rows}

    index = json.loads(sap.fetch(sap.INDEX_URL, True))
    nodes = []

    def walk(node, guru=None):
        nm = (node.get("name") or "").strip()
        if nm:
            nodes.append((nm, node.get("url"), guru))
        for c in node.get("children", []) or []:
            walk(c, nm or guru)
    walk(index)

    records, skipped, seen = [], [], set()
    for pos, (name, ref, guru) in enumerate(nodes):
        if not ref or ref in seen:
            continue
        kind = "granthakara" if "granthakara" in ref else "acharya"
        if args.kind != "all" and kind != args.kind:
            continue
        seen.add(ref)
        if ref in have_ref or sap.norm(name) in have_name:
            continue
        if ref in SKIP_AS_EXISTING:
            skipped.append({"sourceRef": ref, "name": name, "existing": SKIP_AS_EXISTING[ref]})
            continue

        profile = sap.parse_profile(sap.fetch(f"{sap.BASE}/{ref}", True))
        has_bio = bool(profile["biography"] and profile["biography"][0]["paragraphs"])
        iast = sap.title_case(sap.to_iast(name))
        slug = sap.slug_from_ref(ref, iast)
        if slug in have_slug:
            skipped.append({"sourceRef": ref, "name": name, "existing": f"slug {slug}"})
            continue
        records.append({
            "slug": slug,
            "sourceRef": ref,
            "sourceUrl": f"{sap.BASE}/{ref}",
            "nameDevanagari": name,
            "nameIast": iast,
            "nameDisplay": iast,
            "aliases": sorted({iast, name}),
            "dates": profile["dates"],
            "lineageOrder": LINEAGE_ORDER_BASE + pos,
            "guruDevanagari": guru,
            "category": kind,
            "biography": profile["biography"],
            "worksList": profile["works"],
            "bioStatus": "sourced" if has_bio else "empty",
        })
        flag = "BIO" if has_bio else "---"
        print(f"[{flag}] {name:24s} {iast:28s} works={len(profile['works']):2d}  {ref}  guru={guru}")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"source": "https://advaitadhara.sanatana.in/Lineage", "count": len(records),
                   "skipped": skipped, "acharyas": records}, f, ensure_ascii=False, indent=2)
    print(f"\n{len(records)} new records -> {args.out}")
    for s in skipped:
        print(f"SKIPPED {s['sourceRef']} {s['name']} (already have: {s['existing']})")


if __name__ == "__main__":
    main()
