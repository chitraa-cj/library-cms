/**
 * Fix Vivekachudamani Prathama Khanda:
 * 1. Re-assign orphaned mantras (1.1.4, 1.1.5, 1.1.7) back to correct section
 * 2. Delete 204 duplicate older records (keeping newest for each shloka number)
 *
 * Usage: node scripts/fix_viveka_duplicates.mjs
 */
import http from "node:http";

const STRAPI_HOST  = "13.53.121.15";
const STRAPI_PORT  = 1337;
const TOKEN        = process.env.STRAPI_API_TOKEN;
const SECTION_DOC  = "g7wjis56amxgmrnk1w4i9ucr"; // Prathama Khanda
const CONCURRENCY  = 6;

if (!TOKEN) { console.error("No STRAPI_API_TOKEN"); process.exit(1); }

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: { _raw: d.slice(0, 150) } }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("Timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const strapiGet    = (p)       => strapiReq("GET",    p, null);
const strapiPut    = (p, data) => strapiReq("PUT",    p, { data });
const strapiDelete = (p)       => strapiReq("DELETE", p, null);

// Fetch ALL mantras in a section across all pages
async function fetchAllMantras(sectionDocId) {
  const items = [];
  let page = 1;
  while (true) {
    const url = `/api/manthras?filters[Section][documentId][$eq]=${sectionDocId}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=updatedAt` +
      `&sort=updatedAt:desc&pagination[page]=${page}&pagination[pageSize]=100`;
    const r = await strapiGet(url);
    items.push(...(r.body?.data ?? []));
    const totalPages = r.body?.meta?.pagination?.pageCount ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return items;
}

// Run tasks in batches of CONCURRENCY
async function runBatch(items, fn) {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

async function main() {
  // ── Step 1: Re-assign orphaned mantras ──────────────────────────────────
  console.log("Step 1: Re-assigning orphaned mantras to Prathama Khanda…");
  const orphaned = [
    { name: "Shloka 1.1.4", docId: "huf01yr6z6xfhzwl0a7ngiy6", order: 4 },
    { name: "Shloka 1.1.5", docId: "mdxi9j3ertfj1nj3vy0gxw2r", order: 5 },
    { name: "Shloka 1.1.7", docId: "a0ddvsz2s9z6sykbqdsclevm", order: 7 },
  ];

  for (const m of orphaned) {
    const r = await strapiPut(`/api/manthras/${m.docId}`, {
      Section: SECTION_DOC,
      order: m.order,
    });
    if (r.status === 200) {
      console.log(`  [OK] ${m.name} → re-assigned to Prathama Khanda (order ${m.order})`);
    } else {
      console.log(`  [FAIL] ${m.name} → HTTP ${r.status}:`, JSON.stringify(r.body).slice(0, 100));
    }
  }

  // ── Step 2: Fetch all mantras and find duplicates ────────────────────────
  console.log("\nStep 2: Fetching all Prathama Khanda mantras to find duplicates…");
  const all = await fetchAllMantras(SECTION_DOC);
  console.log(`  Total mantras: ${all.length}`);

  // Group by ShlokaManthraNumber — sorted descending by updatedAt so index 0 = newest
  const byNum = {};
  for (const m of all) {
    const n = m.ShlokaManthraNumber;
    if (!byNum[n]) byNum[n] = [];
    byNum[n].push(m);
  }

  // Collect the OLDER copies to delete (all but the newest per number)
  const toDelete = [];
  for (const [num, copies] of Object.entries(byNum)) {
    if (copies.length <= 1) continue;
    // copies are sorted desc by updatedAt (newest first from sort=updatedAt:desc)
    const keepers = copies.slice(0, 1);   // keep newest
    const dupes   = copies.slice(1);      // delete the rest
    toDelete.push(...dupes.map(d => ({ name: num, docId: d.documentId, updated: d.updatedAt?.slice(0,10) })));
  }

  console.log(`  Duplicates to delete: ${toDelete.length}`);

  // ── Step 3: Delete duplicate older records ───────────────────────────────
  console.log("\nStep 3: Deleting older duplicate records…");
  let deleted = 0, failed = 0;

  await runBatch(toDelete, async (m) => {
    const r = await strapiDelete(`/api/manthras/${m.docId}`);
    if (r.status === 200 || r.status === 204) {
      deleted++;
      if (deleted % 50 === 0) console.log(`  Deleted ${deleted}/${toDelete.length}…`);
    } else {
      console.log(`  [FAIL] ${m.name} (${m.docId}) → HTTP ${r.status}:`, JSON.stringify(r.body).slice(0, 100));
      failed++;
    }
  });

  console.log(`\n  Deleted: ${deleted}, Failed: ${failed}`);

  // ── Step 4: Verify ───────────────────────────────────────────────────────
  console.log("\nStep 4: Verifying final state…");
  const final = await fetchAllMantras(SECTION_DOC);
  const finalByNum = {};
  for (const m of final) {
    const n = m.ShlokaManthraNumber;
    if (!finalByNum[n]) finalByNum[n] = [];
    finalByNum[n].push(m);
  }
  const remainingDups = Object.entries(finalByNum).filter(([, a]) => a.length > 1);
  const orders = final.map(m => m.order).sort((a, b) => a - b);
  const gaps = [];
  const uniqueOrders = [...new Set(orders)].sort((a, b) => a - b);
  for (let i = 1; i < uniqueOrders.length; i++) {
    if (uniqueOrders[i] - uniqueOrders[i-1] > 1) {
      for (let g = uniqueOrders[i-1]+1; g < uniqueOrders[i]; g++) gaps.push(g);
    }
  }

  console.log(`  Total mantras after cleanup: ${final.length}`);
  console.log(`  Remaining duplicates: ${remainingDups.length}`);
  console.log(`  Gaps in order: ${gaps.length}`, gaps.slice(0, 10));

  // Show first 10 mantras in order
  const sorted = final.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  console.log("\n  First 10 mantras (by order):");
  sorted.slice(0, 10).forEach(m => console.log(`    order: ${String(m.order).padStart(4)} | ${m.ShlokaManthraNumber}`));

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
