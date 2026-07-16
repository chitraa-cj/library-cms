/**
 * Add Upanishad Brahmendra teekas to Chandogya manthras in Strapi.
 *
 * Source:  /tmp/chandogya_teekas.json   (parsed from Chandogya-Upanishad-Brahmendra.docx)
 * Targets: Chandogya manthras (grantha ms4s02bun5nw9an4ds594aoe)
 * Teeka type (Upanishad Brahmendra / Chandogya): sfxp3u74ltbkzrdpwhgzog08
 *
 * SAFETY: For every target manthra we GET the full Teekas array (deep-populated),
 * strip Strapi internal ids, and PUT back the existing components UNCHANGED plus the
 * new (or updated) Upanishad Brahmendra component. No existing teeka/translation is
 * dropped. Idempotent: re-running updates the UB component in place.
 *
 * Run:  DRY_RUN=1 node scripts/add-chandogya-ub-teekas.mjs        # no writes, prints plan
 *       node scripts/add-chandogya-ub-teekas.mjs                   # live
 *       ONLY=1.1.10 DRY_RUN=1 node scripts/add-chandogya-ub-teekas.mjs   # single manthra
 */
import { config } from "dotenv";
import fs from "node:fs";
config();

const U = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const T = process.env.STRAPI_API_TOKEN;
if (!T) { console.error("STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const DRY = !!process.env.DRY_RUN;
const ONLY = process.env.ONLY ? process.env.ONLY.trim() : null;

const UB_TEEKA_DOC_ID = "sfxp3u74ltbkzrdpwhgzog08"; // Upanishad Brahmendra / Chandogya

// OCR number corrections: marker-number -> real manthra number
const CORRECTIONS = { "5.6.4": "4.6.4", "6.14.4": "6.14.3", "3.7.7": "3.7.4" };

const teekaBlocks = JSON.parse(fs.readFileSync("/tmp/chandogya_teekas.json")).blocks;
const manthraMap = JSON.parse(fs.readFileSync("/tmp/chandogya_manthras.json"));
const num2doc = {};
for (const [k, v] of Object.entries(manthraMap)) num2doc[k.replace("Mantra ", "").trim()] = v;

// Convert extracted text (paragraphs separated by \n) to Strapi blocks rich-text.
function textToBlocks(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim() !== "");
  return lines.map((line) => ({ type: "paragraph", children: [{ type: "text", text: line }] }));
}

// Recursively strip Strapi internal numeric `id` from component objects/arrays.
function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "id") continue;
      out[k] = stripIds(val);
    }
    return out;
  }
  return v;
}

// Rebuild one existing Teeka component into a PUT-safe payload (preserve everything).
function preserveComponent(t) {
  const te = stripIds(t.TeekaEntry || {});
  return {
    teeka: t.teeka?.documentId, // relation by documentId
    TeekaEntry: te,
  };
}

async function getManthra(docId) {
  const q =
    `${U}/api/manthras/${docId}` +
    `?populate[Teekas][populate][TeekaEntry][populate]=*` +
    `&populate[Teekas][populate][teeka][fields][0]=TeekaName` +
    `&populate[Teekas][populate][teeka][fields][1]=documentId`;
  const r = await fetch(q, { headers: H });
  if (!r.ok) throw new Error(`GET ${docId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}

// Build target list: teekaNumber -> { manthraNumber, docId, block }
function buildTargets() {
  const targets = [];
  const problems = [];
  for (const b of teekaBlocks) {
    // Anchor = FIRST number in the marker (corrected). Combined ranges attach to this anchor.
    const raw = b.numbers[0];
    const corrected = CORRECTIONS[raw] || raw;
    const docId = num2doc[corrected];
    if (!docId) { problems.push({ marker: b.marker, raw, corrected }); continue; }
    targets.push({
      marker: b.marker,
      teekaNumber: raw,
      manthraNumber: corrected,
      docId,
      blocks: textToBlocks(b.text),
      charLen: b.charLen,
      allNumbers: b.numbers,
    });
  }
  return { targets, problems };
}

async function processOne(tg) {
  const m = await getManthra(tg.docId);
  const existing = m.Teekas || [];
  const preserved = existing
    .filter((t) => t.teeka?.documentId !== UB_TEEKA_DOC_ID) // drop any prior UB (idempotent replace)
    .map(preserveComponent);
  const newUB = {
    teeka: UB_TEEKA_DOC_ID,
    TeekaEntry: { SanskritTextEntry: tg.blocks },
  };
  const payload = { data: { Teekas: [...preserved, newUB] } };

  const preservedNames = existing.map((t) => t.teeka?.TeekaName);
  const hadUB = existing.some((t) => t.teeka?.documentId === UB_TEEKA_DOC_ID);

  if (DRY) {
    console.log(
      `DRY  ${tg.marker.padEnd(40)} -> Mantra ${tg.manthraNumber} (${tg.docId})  ` +
      `preserve[${preserved.length}]={${preservedNames.join(",")}}  UB:${tg.blocks.length} paras${hadUB ? " (replacing existing UB)" : ""}`
    );
    return { ok: true, dry: true };
  }
  const r = await fetch(`${U}/api/manthras/${tg.docId}`, { method: "PUT", headers: H, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`PUT ${tg.docId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  console.log(`✓ ${tg.marker.padEnd(40)} -> Mantra ${tg.manthraNumber}  (preserved ${preserved.length}, UB ${tg.blocks.length} paras)`);
  return { ok: true };
}

async function main() {
  let { targets, problems } = buildTargets();
  if (ONLY) targets = targets.filter((t) => t.manthraNumber === ONLY || t.teekaNumber === ONLY);
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE"}  | targets: ${targets.length}${ONLY ? ` (filtered ONLY=${ONLY})` : ""}`);
  if (problems.length) {
    console.log(`\n!! ${problems.length} unmatched markers (need manual review):`);
    for (const p of problems) console.log(`   ${p.marker}  (${p.raw} -> ${p.corrected})`);
  }
  let ok = 0, fail = 0; const errors = [];
  for (const tg of targets) {
    try { await processOne(tg); ok++; }
    catch (e) { fail++; errors.push(`${tg.marker}: ${e.message}`); console.error(`✗ ${tg.marker}: ${e.message}`); }
    if (!DRY) await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`\n=== ${DRY ? "DRY-RUN" : "DONE"} === ok:${ok} fail:${fail}`);
  if (errors.length) errors.forEach((e) => console.log("  " + e));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
