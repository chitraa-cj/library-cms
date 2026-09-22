/**
 * Add the "Anandajnana" teeka to Brihadaranyaka Upanishad manthras in Strapi.
 *
 * Source:  /tmp/bruh_teekas.json     (parsed from "Bruhadaranyaka Upanishad.docx" via /tmp/parse_bruh.py)
 *          /tmp/bruh_num2doc.json    (manthra ShlokaManthraNumber "A.B.C" -> documentId)
 * Target grantha: Brihadaranyaka Upanishad (w7pm5bs8j0wbg5vxken8r1q6)
 * Target teeka:   Anandajnana (pwisa22vaj0q0hemyyr7eps1)
 *
 * SAFETY (mirrors scripts/add-chandogya-ub-teekas.mjs):
 *  - For every target manthra we GET the FULL Teekas array deep-populated (incl. every
 *    TeekaEntry's SanskritTextEntry / IAST / English / all 43 OtherTranslations), strip
 *    Strapi internal numeric ids, and PUT back EVERY existing component UNCHANGED plus the
 *    new Anandajnana component. No existing teeka / translation / bhashyam is ever dropped.
 *  - Only the `Teekas` field is sent in the PUT, so ShlokaManthraEntry / BhashyamEntry /
 *    wordMeanings on the manthra are never touched.
 *  - Idempotent: re-running REPLACES the Anandajnana component in place (never duplicates).
 *  - Before each write, the manthra's original Teekas array is appended to a backup JSONL
 *    (/tmp/bruh_anandajnana_backup.jsonl) for rollback.
 *  - After each write, re-fetches and asserts: every pre-existing teeka still present with the
 *    same OtherTranslations count, and Anandajnana present with the expected paragraph count.
 *
 * Run:
 *   DRY_RUN=1 node scripts/add-brihadaranyaka-anandajnana-teekas.mjs         # plan, no writes
 *   ONLY=1.1.1 node scripts/add-brihadaranyaka-anandajnana-teekas.mjs        # single manthra, live
 *   node scripts/add-brihadaranyaka-anandajnana-teekas.mjs                   # full run, live
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

const TEEKA_DOC_ID = "pwisa22vaj0q0hemyyr7eps1";  // Anandajnana
const BACKUP = "/tmp/bruh_anandajnana_backup.jsonl";

const teekaBlocks = JSON.parse(fs.readFileSync("/tmp/bruh_teekas.json", "utf8"));
const num2doc = JSON.parse(fs.readFileSync("/tmp/bruh_num2doc.json", "utf8"));

function textToBlocks(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim() !== "");
  return lines.map((line) => ({ type: "paragraph", children: [{ type: "text", text: line }] }));
}

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
  return {
    teeka: t.teeka?.documentId,       // relation by documentId
    TeekaEntry: stripIds(t.TeekaEntry || {}),
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

function otCount(te) { return Array.isArray(te?.OtherTranslations) ? te.OtherTranslations.length : 0; }

function buildTargets() {
  const targets = [], problems = [];
  for (const b of teekaBlocks) {
    const docId = num2doc[b.number];
    if (!docId) { problems.push(b.number); continue; }
    targets.push({ number: b.number, docId, blocks: textToBlocks(b.text) });
  }
  return { targets, problems };
}

async function processOne(tg) {
  const m = await getManthra(tg.docId);
  const existing = m.Teekas || [];

  // Snapshot fingerprint of everything that must survive (name -> OtherTranslations count).
  const before = existing
    .filter((t) => t.teeka?.documentId !== TEEKA_DOC_ID)
    .map((t) => ({ name: t.teeka?.TeekaName, doc: t.teeka?.documentId, ot: otCount(t.TeekaEntry) }));

  const preserved = existing
    .filter((t) => t.teeka?.documentId !== TEEKA_DOC_ID)   // idempotent: drop prior Anandajnana
    .map(preserveComponent);
  const newEntry = { teeka: TEEKA_DOC_ID, TeekaEntry: { SanskritTextEntry: tg.blocks } };
  const payload = { data: { Teekas: [...preserved, newEntry] } };

  const hadOurs = existing.some((t) => t.teeka?.documentId === TEEKA_DOC_ID);
  const summary = before.map((b) => `${b.name}:OT${b.ot}`).join(", ");

  if (DRY) {
    console.log(`DRY  ${tg.number.padEnd(9)} -> ${tg.docId}  preserve[${preserved.length}]={${summary}}  Anandajnana:${tg.blocks.length} paras${hadOurs ? " (replacing)" : ""}`);
    return { ok: true, dry: true };
  }

  // Backup original Teekas before mutating (rollback safety).
  fs.appendFileSync(BACKUP, JSON.stringify({ number: tg.number, docId: tg.docId, Teekas: existing }) + "\n");

  const r = await fetch(`${U}/api/manthras/${tg.docId}`, { method: "PUT", headers: H, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`PUT ${tg.docId} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);

  // VERIFY: re-fetch and assert nothing lost + new teeka present.
  const after = await getManthra(tg.docId);
  const afterList = after.Teekas || [];
  for (const b of before) {
    const still = afterList.find((t) => t.teeka?.documentId === b.doc);
    if (!still) throw new Error(`VERIFY FAIL ${tg.number}: preserved teeka "${b.name}" MISSING after write`);
    if (otCount(still.TeekaEntry) !== b.ot) throw new Error(`VERIFY FAIL ${tg.number}: "${b.name}" OtherTranslations ${b.ot} -> ${otCount(still.TeekaEntry)}`);
  }
  const ours = afterList.find((t) => t.teeka?.documentId === TEEKA_DOC_ID);
  if (!ours) throw new Error(`VERIFY FAIL ${tg.number}: Anandajnana not present after write`);
  const gotParas = (ours.TeekaEntry?.SanskritTextEntry || []).length;
  if (gotParas !== tg.blocks.length) throw new Error(`VERIFY FAIL ${tg.number}: Anandajnana paras ${tg.blocks.length} -> ${gotParas}`);

  console.log(`✓ ${tg.number.padEnd(9)} preserved ${preserved.length} [${summary}] + Anandajnana ${tg.blocks.length} paras  (verified)`);
  return { ok: true };
}

async function main() {
  let { targets, problems } = buildTargets();
  if (ONLY) targets = targets.filter((t) => t.number === ONLY);
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE"} | teeka=Anandajnana(${TEEKA_DOC_ID}) | targets: ${targets.length}${ONLY ? ` (ONLY=${ONLY})` : ""}`);
  if (problems.length) console.log(`!! unmatched (no manthra, SKIPPED, content preserved in /tmp/bruh_teekas.json): ${problems.join(", ")}`);

  let ok = 0, fail = 0; const errors = [];
  for (const tg of targets) {
    try { await processOne(tg); ok++; }
    catch (e) { fail++; errors.push(`${tg.number}: ${e.message}`); console.error(`✗ ${tg.number}: ${e.message}`); }
    if (!DRY) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`\n=== ${DRY ? "DRY-RUN" : "DONE"} === ok:${ok} fail:${fail}`);
  if (errors.length) errors.forEach((e) => console.log("  " + e));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
