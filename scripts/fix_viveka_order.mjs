/**
 * Fix Vivekachudamani Prathama Khanda manthra order values in Strapi.
 *
 * After insert-between operations the `order` field drifted out of sync with
 * the ShlokaManthraNumber label. This script:
 *   1. Fetches ALL manthras in the Prathama Khanda section
 *   2. Extracts the trailing integer from each ShlokaManthraNumber
 *   3. PUTs each manthra whose order != that integer with the correct value
 *
 * Run:  node scripts/fix_viveka_order.mjs
 */
import http from "node:http";

const STRAPI_HOST   = "13.53.121.15";
const STRAPI_PORT   = 1337;
const STRAPI_TOKEN  = process.env.STRAPI_API_TOKEN;
// Vivekachudamani → Prathama Adhyaya → Prathama Khanda
const SECTION_DOC_ID = "g7wjis56amxgmrnk1w4i9ucr";
const PAGE_SIZE      = 100;
const CONCURRENCY    = 4;

if (!STRAPI_TOKEN) { console.error("No STRAPI_API_TOKEN env var"); process.exit(1); }

// ── HTTP helper ────────────────────────────────────────────────────────────
function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method,
      headers: {
        Authorization: `Bearer ${STRAPI_TOKEN}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data, status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Fetch all manthras in the section (paginated) ─────────────────────────
// NOTE: Strapi needs unencoded brackets AND $ in filter keys.
// Only encode the VALUES, not the keys.
function buildQs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function fetchAllManthras() {
  const all = [];
  let page = 1;
  while (true) {
    // Use page-based pagination only (mixing page & offset causes Strapi 400)
    const path =
      `/api/manthras` +
      `?filters[Section][documentId][$eq]=${SECTION_DOC_ID}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=documentId` +
      `&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}` +
      `&sort=order:asc`;
    const res = await strapiReq("GET", path);
    const items = res?.data ?? [];
    all.push(...items);
    const total = res?.meta?.pagination?.total ?? 0;
    process.stdout.write(`\r  Fetched ${all.length} / ${total}   `);
    if (items.length < PAGE_SIZE || all.length >= total) break;
    page++;
  }
  console.log();
  return all;
}

// ── Concurrency helper ────────────────────────────────────────────────────
async function runConcurrent(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching manthras for section ${SECTION_DOC_ID} ...`);
  const manthras = await fetchAllManthras();
  console.log(`Total fetched: ${manthras.length}`);

  if (manthras.length === 0) {
    console.error("No manthras found — check SECTION_DOC_ID or Strapi connection.");
    process.exit(1);
  }

  // Extract trailing integer from ShlokaManthraNumber
  const parsed = manthras.map(m => {
    const num = m.ShlokaManthraNumber ?? m.attributes?.ShlokaManthraNumber ?? "";
    const ord = m.order ?? m.attributes?.order;
    const docId = m.documentId ?? m.id;
    const match = String(num).match(/(\d+)$/);
    const expectedOrder = match ? parseInt(match[1], 10) : null;
    return { docId, num, currentOrder: ord, expectedOrder };
  });

  // Report what we found
  console.log("\n── Current state around 214-230 ────────────────────────────────");
  parsed
    .filter(p => p.expectedOrder != null && p.expectedOrder >= 213 && p.expectedOrder <= 230)
    .sort((a, b) => (a.currentOrder ?? 0) - (b.currentOrder ?? 0))
    .forEach(p => {
      const ok = p.currentOrder === p.expectedOrder ? "✓" : "✗ WRONG";
      console.log(`  ${p.num} | currentOrder=${p.currentOrder} → expectedOrder=${p.expectedOrder} ${ok}`);
    });

  // Find those that need fixing
  const toFix = parsed.filter(
    p => p.expectedOrder != null && p.currentOrder !== p.expectedOrder
  );

  console.log(`\n── Manthras that need order correction: ${toFix.length} ────────────`);
  toFix.forEach(p => console.log(`  ${p.num}: order ${p.currentOrder} → ${p.expectedOrder}  (${p.docId})`));

  if (toFix.length === 0) {
    console.log("Nothing to fix — all orders are correct.");
    return;
  }

  // Find duplicates or missing in the range around the problem area
  const nums = new Set(parsed.map(p => p.expectedOrder).filter(Boolean));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const missing = [];
  for (let n = min; n <= max; n++) {
    if (!nums.has(n)) missing.push(n);
  }
  if (missing.length > 0) {
    console.log(`\n⚠  Missing ShlokaManthraNumbers in sequence: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` (+${missing.length - 20} more)` : ""}`);
  }

  console.log(`\nApplying fixes (concurrency=${CONCURRENCY}) ...`);
  let fixed = 0, errored = 0;

  const tasks = toFix.map(p => async () => {
    try {
      const res = await strapiReq(
        "PUT",
        `/api/manthras/${p.docId}`,
        { data: { order: p.expectedOrder } }
      );
      if (res?.data?.documentId || res?.data?.id) {
        process.stdout.write(`\r  ✓ ${++fixed} fixed   `);
      } else {
        console.error(`\n  ✗ ${p.num} (${p.docId}): unexpected response`, JSON.stringify(res).slice(0, 120));
        errored++;
      }
    } catch (e) {
      console.error(`\n  ✗ ${p.num} (${p.docId}): ${e.message}`);
      errored++;
    }
  });

  await runConcurrent(tasks, CONCURRENCY);
  console.log(`\n\nDone. Fixed: ${fixed}, Errors: ${errored}`);

  if (errored === 0) {
    console.log("\n✅ All order values corrected. Reload the Strapi admin panel to verify.");
  } else {
    console.log("\n⚠  Some updates failed — run again to retry.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
