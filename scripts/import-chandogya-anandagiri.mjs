/**
 * Import Anandagiri Teeka (Sanskrit text) into Chandogya manthras from CSV.
 *
 * Source:  Chandogya-Anandagiri Teeka v1.0.csv   (cols: "Verse No", "Anandagiri Teeka")
 * Grantha: Chandogya Upanishad            d1qot3ne769frkku15ncymvy
 * Teeka:   Anandagiri Teeka (Chandogya)   thyunbfuwin9ltj12on892yy
 *
 * SAFETY (per user requirement — hinder NOTHING else):
 *   For every target manthra we GET the full Teekas array (deep-populated), strip
 *   Strapi internal ids, and PUT back EVERY existing teeka/bhashyam component UNCHANGED
 *   and IN ORDER. We only touch the Anandagiri component: overwrite its SanskritTextEntry
 *   with the CSV text (preserving any IAST/English/Other sub-fields), or append a new
 *   Anandagiri component if the manthra has none. BhashyamEntry / ShlokaManthraEntry /
 *   wordMeanings are never part of the payload, so they are never modified.
 *   Idempotent: re-running re-writes the same Anandagiri Sanskrit.
 *
 * Run:  DRY_RUN=1 node scripts/import-chandogya-anandagiri.mjs          # plan, no writes
 *       ONLY=4.2.1 node scripts/import-chandogya-anandagiri.mjs         # single manthra (live)
 *       ONLY=4.2.1 DRY_RUN=1 node scripts/import-chandogya-anandagiri.mjs
 *       node scripts/import-chandogya-anandagiri.mjs                    # full live import
 */
import { config } from "dotenv";
import fs from "node:fs";
import { parseCSV } from "./lib-csv.mjs";
config();

const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
if (!T) { console.error("STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const DRY = !!process.env.DRY_RUN;
const ONLY = process.env.ONLY ? process.env.ONLY.trim() : null;

const GRANTHA = "d1qot3ne769frkku15ncymvy";
const ANANDAGIRI = "thyunbfuwin9ltj12on892yy";
const CSV_FILE = "Chandogya-Anandagiri Teeka v1.0.csv";
const BACKUP_FILE = "scripts/.backup-chandogya-anandagiri-run.json";

async function api(url, opts) {
  const r = await fetch(url, { headers: H, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} ${opts?.method || "GET"} ${url}\n${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// CSV cell (newline-separated lines) -> Strapi blocks rich-text (one paragraph per non-empty line).
function textToBlocks(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim() !== "");
  return lines.map((line) => ({ type: "paragraph", children: [{ type: "text", text: line }] }));
}

// Recursively strip Strapi internal numeric `id`.
function stripIds(v) {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (k === "id") continue; out[k] = stripIds(val); }
    return out;
  }
  return v;
}

// Rebuild an existing Teeka component into a PUT-safe payload, unchanged.
function preserveComponent(t) {
  const comp = { TeekaEntry: stripIds(t.TeekaEntry || {}) };
  if (t.teeka?.documentId) comp.teeka = t.teeka.documentId; // relation by documentId
  return comp;
}

async function getManthraTeekas(docId) {
  const q =
    `${U}/api/manthras/${docId}` +
    `?populate[Teekas][populate][TeekaEntry][populate]=*` +
    `&populate[Teekas][populate][teeka][fields][0]=TeekaName` +
    `&populate[Teekas][populate][teeka][fields][1]=documentId`;
  return (await api(q)).data;
}

// Build ShlokaManthraNumber(without "Mantra ") -> documentId for all Chandogya manthras.
async function buildManthraMap() {
  const num2doc = {}; let page = 1, total = 0;
  while (true) {
    const b = await api(`${U}/api/manthras?filters[Section][grantha][documentId][$eq]=${GRANTHA}&fields[0]=ShlokaManthraNumber&pagination[page]=${page}&pagination[pageSize]=100`);
    for (const m of b.data) {
      const num = (m.ShlokaManthraNumber || "").replace(/^Mantra\s*/i, "").trim();
      if (num2doc[num]) console.warn(`  !! duplicate manthra number in Strapi: ${num}`);
      num2doc[num] = m.documentId;
    }
    total = b.meta.pagination.total;
    if (page * 100 >= total) break;
    page++;
  }
  return num2doc;
}

function loadTargets(num2doc) {
  const rows = parseCSV(fs.readFileSync(CSV_FILE, "utf8"));
  const data = rows.slice(1).filter((r) => (r[0] || "").trim());
  const targets = [], missing = [];
  for (const r of data) {
    const verse = r[0].trim();
    const docId = num2doc[verse];
    if (!docId) { missing.push(verse); continue; }
    targets.push({ verse, docId, blocks: textToBlocks(r[1] || "") });
  }
  return { targets, missing };
}

async function processOne(tg, backupSink) {
  const m = await getManthraTeekas(tg.docId);
  const existing = m.Teekas || [];
  if (!DRY) backupSink[tg.verse] = { docId: tg.docId, Teekas: existing }; // full pre-change snapshot

  // Preserve every component in order; overwrite ONLY the Anandagiri Sanskrit text.
  let found = false;
  const rebuilt = existing.map((t) => {
    if (t.teeka?.documentId === ANANDAGIRI) {
      found = true;
      const te = stripIds(t.TeekaEntry || {});
      te.SanskritTextEntry = tg.blocks; // overwrite sanskrit only; keep IAST/English/Other
      return { teeka: ANANDAGIRI, TeekaEntry: te };
    }
    return preserveComponent(t);
  });
  if (!found) rebuilt.push({ teeka: ANANDAGIRI, TeekaEntry: { SanskritTextEntry: tg.blocks } });

  const otherNames = existing.filter((t) => t.teeka?.documentId !== ANANDAGIRI).map((t) => t.teeka?.TeekaName);
  const action = found ? "update" : "add";

  if (DRY) {
    console.log(`DRY  ${tg.verse.padEnd(9)} ${action.padEnd(6)} Anandagiri ${String(tg.blocks.length).padStart(3)} paras | preserve[${otherNames.length}]={${otherNames.join(",")}}`);
    return { ok: true, action };
  }

  await api(`${U}/api/manthras/${tg.docId}`, { method: "PUT", body: JSON.stringify({ data: { Teekas: rebuilt } }) });

  // Verify: re-GET and confirm other teekas intact + Anandagiri now populated.
  const after = await getManthraTeekas(tg.docId);
  const at = after.Teekas || [];
  const otherBefore = existing.filter((t) => t.teeka?.documentId !== ANANDAGIRI).map((t) => t.teeka?.documentId).sort();
  const otherAfter = at.filter((t) => t.teeka?.documentId !== ANANDAGIRI).map((t) => t.teeka?.documentId).sort();
  const anaAfter = at.find((t) => t.teeka?.documentId === ANANDAGIRI);
  const anaParas = anaAfter?.TeekaEntry?.SanskritTextEntry?.length || 0;
  const otherOk = JSON.stringify(otherBefore) === JSON.stringify(otherAfter);
  if (!otherOk) throw new Error(`VERIFY FAIL other teekas changed! before=${otherBefore} after=${otherAfter}`);
  if (anaParas !== tg.blocks.length) throw new Error(`VERIFY FAIL Anandagiri paras ${anaParas} != ${tg.blocks.length}`);
  console.log(`✓ ${tg.verse.padEnd(9)} ${action.padEnd(6)} Anandagiri ${String(anaParas).padStart(3)} paras | preserved ${otherAfter.length} other teekas ✓`);
  return { ok: true, action };
}

async function main() {
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE"}  server=${U}${ONLY ? `  ONLY=${ONLY}` : ""}`);
  const num2doc = await buildManthraMap();
  let { targets, missing } = loadTargets(num2doc);
  if (ONLY) targets = targets.filter((t) => t.verse === ONLY);
  console.log(`Targets: ${targets.length}${missing.length ? `  | UNMATCHED verses (skipped): ${missing.length} -> ${missing.join(", ")}` : "  | all verses matched"}`);
  if (!targets.length) { console.log("Nothing to do."); return; }

  const backupSink = {};
  let ok = 0, fail = 0, added = 0, updated = 0; const errors = [];
  for (const tg of targets) {
    try {
      const r = await processOne(tg, backupSink);
      ok++; if (r.action === "add") added++; else updated++;
    } catch (e) {
      fail++; errors.push(`${tg.verse}: ${e.message}`); console.error(`✗ ${tg.verse}: ${e.message}`);
      if (!DRY) { // persist backup-so-far and stop to avoid further risk
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(backupSink, null, 1));
        console.error(`\nStopped after error. Backup of touched manthras -> ${BACKUP_FILE}`);
        break;
      }
    }
    if (!DRY) await new Promise((r) => setTimeout(r, 100));
  }
  if (!DRY) fs.writeFileSync(BACKUP_FILE, JSON.stringify(backupSink, null, 1));
  console.log(`\n=== ${DRY ? "DRY-RUN" : "DONE"} === ok:${ok} (add:${added} update:${updated}) fail:${fail}`);
  if (!DRY) console.log(`Pre-change backup of touched manthras: ${BACKUP_FILE}`);
  if (errors.length) errors.forEach((e) => console.log("  " + e));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
