/**
 * Fix Malayalam translations mislabeled as "English" in Ishavasya Bhashyam OtherTranslations.
 *
 * Findings (whole-DB scan): 8 Bhashyam OtherTranslations entries hold pure Malayalam text
 * (0 Latin) but are labeled LanguageOfTranslation="English". All in Ishavasya upanishad.
 *   - Pattern A (single OT entry): just relabel English -> Malayalam.
 *   - Pattern B (full ~41-language AI batch present): relabel the curated Malayalam
 *     (English slot) -> Malayalam, AND drop the redundant AI-batch "Malayalam" entry so the
 *     manthra ends with exactly ONE Malayalam (no duplicate language, no mislabel).
 *
 * SAFETY: GET the full BhashyamEntry (deep), strip Strapi internal ids, keep Sanskrit /
 * IAST / EnglishTranslationText UNCHANGED, and PUT back the corrected OtherTranslations.
 * Every current BhashyamEntry is written to scripts/.backup-ishavasya-<ts>.json first.
 *
 * Run:  DRY_RUN=1 node scripts/fix-ishavasya-malayalam-mislabel.mjs   # plan only, writes backup
 *       node scripts/fix-ishavasya-malayalam-mislabel.mjs             # live
 */
import { config } from "dotenv";
import fs from "node:fs";
config();

const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
if (!T) { console.error("STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const DRY = !!process.env.DRY_RUN;
const ISHA = "j7jxq2cec6dcmqtqc3wont6c";

const flat = (b) => Array.isArray(b) ? b.map((p) => (p.children || []).map((c) => c.text || "").join("")).join(" ") : "";
const mal = (s) => (s.match(/[ഀ-ൿ]/g) || []).length;
const lat = (s) => (s.match(/[A-Za-z]/g) || []).length;
// A dominant-Malayalam entry: substantial Malayalam and essentially no Latin script.
const isMalayalam = (t) => mal(t) > 50 && lat(t) < 20;

function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (k === "id") continue; out[k] = stripIds(val); }
    return out;
  }
  return v;
}

async function getManthra(docId) {
  const q = `${U}/api/manthras/${docId}?populate[BhashyamEntry][populate][OtherTranslations][populate]=*`;
  const r = await fetch(q, { headers: H });
  if (!r.ok) throw new Error(`GET ${docId} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}

async function listIshaManthras() {
  const out = [];
  let page = 1;
  while (true) {
    const q = `${U}/api/manthras?filters[Section][grantha][documentId][$eq]=${ISHA}&pagination[page]=${page}&pagination[pageSize]=50&fields[0]=ShlokaManthraNumber`;
    const j = await (await fetch(q, { headers: H })).json();
    out.push(...(j.data || []));
    if (!j.meta || page >= j.meta.pagination.pageCount || !(j.data || []).length) break;
    page++;
  }
  return out;
}

async function main() {
  console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE"}  target grantha: Ishavasya`);
  const manthras = await listIshaManthras();
  const plan = [];
  const backup = {};

  for (const m of manthras) {
    const full = await getManthra(m.documentId);
    const be = full.BhashyamEntry;
    if (!be) continue;
    const ot = be.OtherTranslations || [];
    // find the mislabeled English-slot Malayalam entry
    const mislabeledIdx = ot.findIndex((it) => (it.LanguageOfTranslation || "").toLowerCase() === "english" && isMalayalam(flat(it.TranslationText)));
    if (mislabeledIdx < 0) continue;

    backup[m.documentId] = { number: full.ShlokaManthraNumber, BhashyamEntry: be };

    // Build corrected OtherTranslations:
    //  - relabel the mislabeled entry -> Malayalam (kept: it is the curated translation)
    //  - drop any OTHER dominant-Malayalam entry (the redundant AI-batch Malayalam) -> no dup
    const kept = [];
    let dropped = 0, relabeled = 0;
    ot.forEach((it, i) => {
      const clean = stripIds(it);
      if (i === mislabeledIdx) {
        clean.LanguageOfTranslation = "Malayalam";
        relabeled++;
        kept.push(clean);
      } else if (isMalayalam(flat(it.TranslationText))) {
        dropped++; // redundant Malayalam -> remove
      } else {
        kept.push(clean);
      }
    });

    const payload = { data: { BhashyamEntry: {
      SanskritTextEntry: stripIds(be.SanskritTextEntry),
      IASTTransliteration: stripIds(be.IASTTransliteration),
      EnglishTranslationText: stripIds(be.EnglishTranslationText),
      OtherTranslations: kept,
    } } };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    plan.push({ docId: m.documentId, number: full.ShlokaManthraNumber, before: ot.length, after: kept.length, relabeled, dropped, bytes, payload });
  }

  // write backup
  const ts = plan.length ? "run" : "empty";
  const bpath = `scripts/.backup-ishavasya-${ts}.json`;
  fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup of current BhashyamEntry written: ${bpath} (${Object.keys(backup).length} manthras)`);

  console.log(`\nPlan (${plan.length} manthras):`);
  for (const p of plan) {
    console.log(`  ${String(p.number).padEnd(14)} OT ${p.before}->${p.after}  relabel:${p.relabeled} drop:${p.dropped}  payload:${(p.bytes/1024).toFixed(1)}KB`);
  }

  if (DRY) { console.log("\nDRY-RUN: no writes."); return; }

  console.log("\nApplying...");
  let ok = 0, fail = 0;
  for (const p of plan) {
    const r = await fetch(`${U}/api/manthras/${p.docId}`, { method: "PUT", headers: H, body: JSON.stringify(p.payload) });
    if (!r.ok) { fail++; console.error(`  x ${p.number}: ${r.status} ${(await r.text()).slice(0, 200)}`); }
    else { ok++; console.log(`  ✓ ${p.number}`); }
    await new Promise((res) => setTimeout(res, 150));
  }
  console.log(`\nDONE ok:${ok} fail:${fail}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
