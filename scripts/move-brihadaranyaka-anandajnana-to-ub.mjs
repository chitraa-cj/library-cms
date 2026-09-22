/**
 * Re-attribute the mistakenly-named "Anandajnana" teeka content to the existing
 * "Upanishad Brahmendra" teeka on Brihadaranyaka Upanishad manthras.
 *
 * Grantha: Brihadaranyaka Upanishad (w7pm5bs8j0wbg5vxken8r1q6)
 * FROM teeka: Anandajnana            (pwisa22vaj0q0hemyyr7eps1)  <- created by mistake
 * TO   teeka: Upanishad Brahmendra   (rzpbrbz9ns2mb9gk5gg0c951)  <- already registered, empty
 *
 * SAFETY:
 *  - GET each manthra's full Teekas array deep-populated. Preserve EVERY other teeka
 *    component (Nyaya Nirnaya w/ its 43 OtherTranslations, Anandagiri Teeka, ...) unchanged.
 *  - Move the Anandajnana component's TeekaEntry onto the UB teeka. If a UB component with
 *    real content already exists on the manthra, MERGE (UB Sanskrit blocks first, then the
 *    moved blocks; keep UB's IAST/English/OtherTranslations) — nothing dropped.
 *  - Remove the Anandajnana component. Only the `Teekas` field is sent, so Shloka/Bhashyam/
 *    wordMeanings are untouched.
 *  - Backup original Teekas to /tmp/bruh_ub_move_backup.jsonl before each write.
 *  - Post-write verify: UB present with expected para count, Anandajnana absent, every other
 *    teeka still present with same OtherTranslations count.
 *  - Idempotent: a manthra with no Anandajnana component is skipped.
 *
 * Run:  DRY_RUN=1 node scripts/move-brihadaranyaka-anandajnana-to-ub.mjs
 *       ONLY=1.1.1 node scripts/move-brihadaranyaka-anandajnana-to-ub.mjs
 *       node scripts/move-brihadaranyaka-anandajnana-to-ub.mjs
 */
import { config } from "dotenv";
import fs from "node:fs";
config();

const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
if (!U || !T) { console.error("STRAPI_URL / STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const DRY = !!process.env.DRY_RUN;
const ONLY = process.env.ONLY ? process.env.ONLY.trim() : null;

const ANAND = "pwisa22vaj0q0hemyyr7eps1";      // Anandajnana (mistake)
const UB = "rzpbrbz9ns2mb9gk5gg0c951";         // Upanishad Brahmendra (target)
const BACKUP = "/tmp/bruh_ub_move_backup.jsonl";

const teekaBlocks = JSON.parse(fs.readFileSync("/tmp/bruh_teekas.json", "utf8"));
const num2doc = JSON.parse(fs.readFileSync("/tmp/bruh_num2doc.json", "utf8"));

function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (k === "id") continue; out[k] = stripIds(val); }
    return out;
  }
  return v;
}
const preserveComponent = (t) => ({ teeka: t.teeka?.documentId, TeekaEntry: stripIds(t.TeekaEntry || {}) });
const otCount = (te) => (Array.isArray(te?.OtherTranslations) ? te.OtherTranslations.length : 0);
const paras = (te) => (Array.isArray(te?.SanskritTextEntry) ? te.SanskritTextEntry.length : 0);
const hasContent = (te) => paras(te) > 0 || otCount(te) > 0 ||
  (te?.EnglishTranslationText || []).length > 0 || (te?.IASTTransliteration || []).length > 0;

async function getManthra(docId) {
  const q = `${U}/api/manthras/${docId}` +
    `?populate[Teekas][populate][TeekaEntry][populate]=*` +
    `&populate[Teekas][populate][teeka][fields][0]=TeekaName` +
    `&populate[Teekas][populate][teeka][fields][1]=documentId`;
  const r = await fetch(q, { headers: H });
  if (!r.ok) throw new Error(`GET ${docId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}

async function processOne(number, docId) {
  const m = await getManthra(docId);
  const existing = m.Teekas || [];
  const anand = existing.find((t) => t.teeka?.documentId === ANAND);
  if (!anand) { console.log(`•  ${number.padEnd(9)} no Anandajnana component — skip (already migrated)`); return { ok: true, skipped: true }; }

  const oldUb = existing.find((t) => t.teeka?.documentId === UB);
  const others = existing
    .filter((t) => t.teeka?.documentId !== ANAND && t.teeka?.documentId !== UB)
    .map(preserveComponent);
  const before = existing
    .filter((t) => t.teeka?.documentId !== ANAND && t.teeka?.documentId !== UB)
    .map((t) => ({ name: t.teeka?.TeekaName, doc: t.teeka?.documentId, ot: otCount(t.TeekaEntry) }));

  const anandEntry = stripIds(anand.TeekaEntry || {});
  let mergedEntry, mergeNote = "";
  if (oldUb && hasContent(oldUb.TeekaEntry)) {
    const ub = stripIds(oldUb.TeekaEntry);
    mergedEntry = { ...ub, SanskritTextEntry: [ ...(ub.SanskritTextEntry || []), ...(anandEntry.SanskritTextEntry || []) ] };
    mergeNote = ` (MERGED with existing UB ${paras(ub)}+${paras(anandEntry)} paras)`;
  } else {
    mergedEntry = anandEntry;
  }

  const newTeekas = [...others, { teeka: UB, TeekaEntry: mergedEntry }];
  const summary = before.map((b) => `${b.name}:OT${b.ot}`).join(", ");

  if (DRY) {
    console.log(`DRY  ${number.padEnd(9)} keep[${others.length}]={${summary}}  Anandajnana->UB ${paras(mergedEntry)} paras${mergeNote}`);
    return { ok: true, dry: true };
  }

  fs.appendFileSync(BACKUP, JSON.stringify({ number, docId, Teekas: existing }) + "\n");
  const r = await fetch(`${U}/api/manthras/${docId}`, { method: "PUT", headers: H, body: JSON.stringify({ data: { Teekas: newTeekas } }) });
  if (!r.ok) throw new Error(`PUT ${docId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const after = await getManthra(docId);
  const list = after.Teekas || [];
  if (list.some((t) => t.teeka?.documentId === ANAND)) throw new Error(`VERIFY FAIL ${number}: Anandajnana still present`);
  const ubAfter = list.find((t) => t.teeka?.documentId === UB);
  if (!ubAfter) throw new Error(`VERIFY FAIL ${number}: Upanishad Brahmendra missing after write`);
  if (paras(ubAfter.TeekaEntry) !== paras(mergedEntry)) throw new Error(`VERIFY FAIL ${number}: UB paras ${paras(mergedEntry)} -> ${paras(ubAfter.TeekaEntry)}`);
  for (const b of before) {
    const still = list.find((t) => t.teeka?.documentId === b.doc);
    if (!still) throw new Error(`VERIFY FAIL ${number}: preserved teeka "${b.name}" MISSING`);
    if (otCount(still.TeekaEntry) !== b.ot) throw new Error(`VERIFY FAIL ${number}: "${b.name}" OT ${b.ot} -> ${otCount(still.TeekaEntry)}`);
  }
  console.log(`✓ ${number.padEnd(9)} kept ${others.length} [${summary}] + UB ${paras(mergedEntry)} paras${mergeNote}  (verified)`);
  return { ok: true };
}

async function main() {
  let targets = teekaBlocks.map((b) => b.number).filter((n) => num2doc[n]).map((n) => ({ number: n, docId: num2doc[n] }));
  if (ONLY) targets = targets.filter((t) => t.number === ONLY);
  console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE"} | Anandajnana(${ANAND}) -> Upanishad Brahmendra(${UB}) | targets: ${targets.length}${ONLY ? ` (ONLY=${ONLY})` : ""}`);
  let ok = 0, fail = 0, skip = 0; const errors = [];
  for (const tg of targets) {
    try { const r = await processOne(tg.number, tg.docId); if (r.skipped) skip++; else ok++; }
    catch (e) { fail++; errors.push(`${tg.number}: ${e.message}`); console.error(`✗ ${tg.number}: ${e.message}`); }
    if (!DRY) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`\n=== ${DRY ? "DRY-RUN" : "DONE"} === ok:${ok} skip:${skip} fail:${fail}`);
  if (errors.length) errors.forEach((e) => console.log("  " + e));
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
