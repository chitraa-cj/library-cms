/**
 * Trim Anubhuthi Prakasha: cap Chapter 4 at verse 4.90 and Chapter 5 at verse 5.100.
 *
 * Current state (whole-DB scan):
 *   - Ch4 "Chaturtha Adhyaya" (aqbt51w9xjrm10xwt2y8wrnq): verses 4.1 .. 4.187  (187)
 *   - Ch5 "Panchama Adhyaya"  (w18j4xzxdc0k47ngxdw7e5bq): verses 5.1 .. 5.199  (199)
 *
 * Action: PERMANENTLY DELETE every manthra whose minor verse number exceeds the cap
 *   - Ch4: delete 4.91 .. 4.187   (97 manthras)
 *   - Ch5: delete 5.101 .. 5.199  (99 manthras)
 * Every other chapter of this grantha, and every other grantha, is left untouched.
 *
 * SAFETY: each targeted manthra is deep-populated and written to
 *   scripts/.backup-anubhuthi-trim-<run>.json BEFORE any delete. The manthra number is
 *   parsed from ShlokaManthraNumber ("Shloka 4.91" -> chapter 4, verse 91); a verse that
 *   cannot be parsed is skipped and reported, never deleted.
 *
 * Run:  DRY_RUN=1 node scripts/trim-anubhuthi-prakasha-ch4-ch5.mjs   # plan + backup, no deletes
 *       node scripts/trim-anubhuthi-prakasha-ch4-ch5.mjs             # live delete
 */
import { config } from "dotenv";
import fs from "node:fs";
config();

const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
if (!U || !T) { console.error("STRAPI_URL / STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}`, "Content-Type": "application/json" };
const DRY = !!process.env.DRY_RUN;

// section documentId -> { name, cap }  (keep verses with minor <= cap)
const CHAPTERS = {
  aqbt51w9xjrm10xwt2y8wrnq: { name: "Ch4 Chaturtha Adhyaya", chapter: 4, cap: 90 },
  w18j4xzxdc0k47ngxdw7e5bq: { name: "Ch5 Panchama Adhyaya", chapter: 5, cap: 100 },
};

// "Shloka 4.91" / "4.91" -> { chap: 4, verse: 91 }
function parseNum(s) {
  const m = String(s || "").match(/(\d+)\s*\.\s*(\d+)/);
  return m ? { chap: Number(m[1]), verse: Number(m[2]) } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listSection(sec) {
  const out = [];
  let page = 1;
  while (true) {
    const q = `${U}/api/manthras?filters[Section][documentId][$eq]=${sec}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&pagination[page]=${page}&pagination[pageSize]=100`;
    const j = await (await fetch(q, { headers: H })).json();
    out.push(...(j.data || []));
    const p = j.meta?.pagination;
    if (!p || page >= p.pageCount || !(j.data || []).length) break;
    page++;
  }
  return out;
}

// Deep-populate a manthra so the backup is restorable.
async function getFull(docId) {
  const q = `${U}/api/manthras/${docId}?` + [
    "populate[Section]=true",
    "populate[ShlokaManthraEntry][populate]=*",
    "populate[BhashyamEntry][populate]=*",
    "populate[Teekas][populate]=*",
    "populate[wordMeanings][populate]=*",
  ].join("&");
  const r = await fetch(q, { headers: H });
  if (!r.ok) throw new Error(`GET ${docId} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}

async function main() {
  console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE DELETE"}  grantha: Anubhuthi Prakasha\n`);

  const toDelete = [];
  const skipped = [];
  for (const [sec, cfg] of Object.entries(CHAPTERS)) {
    const rows = await listSection(sec);
    let kept = 0;
    for (const m of rows) {
      const pn = parseNum(m.ShlokaManthraNumber);
      if (!pn || pn.chap !== cfg.chapter) { skipped.push({ sec: cfg.name, num: m.ShlokaManthraNumber, docId: m.documentId, reason: pn ? `chap ${pn.chap} != ${cfg.chapter}` : "unparseable" }); continue; }
      if (pn.verse > cfg.cap) toDelete.push({ sec, secName: cfg.name, docId: m.documentId, num: m.ShlokaManthraNumber, verse: pn.verse });
      else kept++;
    }
    const del = toDelete.filter((d) => d.sec === sec).length;
    console.log(`${cfg.name}: total ${rows.length}  keep ${kept} (<=${cfg.chapter}.${cfg.cap})  delete ${del}`);
  }
  if (skipped.length) {
    console.log(`\n! ${skipped.length} manthra(s) skipped (not deleted):`);
    skipped.forEach((s) => console.log(`    ${s.sec}  ${s.num}  (${s.reason})`));
  }
  toDelete.sort((a, b) => (a.secName < b.secName ? -1 : 1) || a.verse - b.verse);
  console.log(`\nTotal to delete: ${toDelete.length}`);
  console.log(`  Ch4: ${toDelete.filter((d) => d.secName.startsWith("Ch4")).map((d) => d.verse).sort((a, b) => a - b).join(", ") || "(none)"}`);
  console.log(`  Ch5: ${toDelete.filter((d) => d.secName.startsWith("Ch5")).map((d) => d.verse).sort((a, b) => a - b).join(", ") || "(none)"}`);

  // Backup every targeted record (deep) BEFORE any delete.
  console.log(`\nBacking up ${toDelete.length} full records...`);
  const backup = {};
  for (const d of toDelete) {
    backup[d.docId] = { num: d.num, section: d.secName, record: await getFull(d.docId) };
    process.stdout.write(".");
  }
  const bpath = `scripts/.backup-anubhuthi-trim-run.json`;
  fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${bpath} (${Object.keys(backup).length} records, ${(fs.statSync(bpath).size / 1024).toFixed(0)} KB)`);

  if (DRY) { console.log("\nDRY-RUN: no deletes performed."); return; }

  console.log(`\nDeleting...`);
  let ok = 0, fail = 0;
  for (const d of toDelete) {
    const r = await fetch(`${U}/api/manthras/${d.docId}`, { method: "DELETE", headers: H });
    if (!r.ok) { fail++; console.error(`  x ${d.num}: ${r.status} ${(await r.text()).slice(0, 160)}`); }
    else { ok++; if (ok % 20 === 0) process.stdout.write(`  ${ok}/${toDelete.length}\n`); }
    await sleep(120);
  }
  console.log(`\nDONE  deleted:${ok}  failed:${fail}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
