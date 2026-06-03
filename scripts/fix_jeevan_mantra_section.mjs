/**
 * Fix Jeevan Mukthanandhalahari (Prathama Adhyaya section) mantra order/labels.
 *
 * Deletes 4 orphan/duplicate rows, then reassigns order + ShlokaManthraNumber
 * for the remaining 18 mantras.
 *
 * Usage:
 *   STRAPI_API_TOKEN=... node scripts/fix_jeevan_mantra_section.mjs          # dry-run
 *   STRAPI_API_TOKEN=... node scripts/fix_jeevan_mantra_section.mjs --apply  # execute
 */
import http from "node:http";

const STRAPI_HOST = process.env.STRAPI_HOST || "13.53.121.15";
const STRAPI_PORT = Number(process.env.STRAPI_PORT || 1337);
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const SECTION = "nnx5jsuxvpaa75nstlclpff2";
const STRAPI_SORT_GAP = 100_000;
const APPLY = process.argv.includes("--apply");

/** Rows to delete — verified 2026-06-03 via inspect_section_mantras.mjs */
const DELETE_DOC_IDS = [
  "s7kbgxk7orvax658cdvnjmh5", // order 650000, empty insert-between orphan
  "c09jee5b5kxbnaqkabgnt3m5", // order 700000 dup; keep u4c960 (Mantra 1.7)
  "mfn0eino49mlipnossmcn7eh", // order 800000 dup; newer race (2026-06-03T04:31)
  "y00t7ekrcw7cb9x0z7fz8v8w", // order 900000 dup; newer race (2026-06-03T04:32)
];

if (!STRAPI_TOKEN) {
  console.error("Set STRAPI_API_TOKEN");
  process.exit(1);
}

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: STRAPI_HOST,
        port: STRAPI_PORT,
        path,
        method,
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { _raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchAllManthras(sectionDocId) {
  const all = [];
  let page = 1;
  while (true) {
    const path =
      `/api/manthras?filters[Section][documentId][$eq]=${encodeURIComponent(sectionDocId)}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=documentId` +
      `&sort=order:asc&pagination[page]=${page}&pagination[pageSize]=100`;
    const { body: res } = await strapiReq("GET", path);
    all.push(...(res.data ?? []));
    if (page >= (res.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

async function main() {
  console.log(`Section ${SECTION} | mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const before = await fetchAllManthras(SECTION);
  console.log(`Before: ${before.length} mantras`);

  const dupBefore = new Map();
  for (const m of before) {
    const list = dupBefore.get(m.order) ?? [];
    list.push(m);
    dupBefore.set(m.order, list);
  }
  for (const [order, list] of dupBefore.entries()) {
    if (list.length > 1) {
      console.log(`  duplicate order ${order}: ${list.map((x) => x.documentId).join(", ")}`);
    }
  }

  console.log("\n── Deletes ──");
  for (const docId of DELETE_DOC_IDS) {
    const row = before.find((m) => m.documentId === docId);
    console.log(
      `  DELETE ${docId} order=${row?.order ?? "?"} label="${row?.ShlokaManthraNumber ?? "?"}"`,
    );
    if (APPLY) {
      const { status, body } = await strapiReq("DELETE", `/api/manthras/${docId}`);
      if (status >= 200 && status < 300) console.log("    ✓ deleted");
      else console.error("    ✗ failed", status, JSON.stringify(body).slice(0, 120));
    }
  }

  const remaining = APPLY
    ? await fetchAllManthras(SECTION)
    : before.filter((m) => !DELETE_DOC_IDS.includes(m.documentId));

  remaining.sort((a, b) => {
    const d = a.order - b.order;
    if (d !== 0) return d;
    return String(a.documentId).localeCompare(String(b.documentId));
  });

  console.log(`\nAfter deletes: ${remaining.length} mantras (expected 18)`);

  const plan = remaining.map((m, idx) => {
    const pos = idx + 1;
    const wantOrder = pos * STRAPI_SORT_GAP;
    const wantLabel = `Mantra 1.${pos}`;
    return {
      docId: m.documentId,
      currentOrder: m.order,
      currentLabel: m.ShlokaManthraNumber,
      wantOrder,
      wantLabel,
      needsFix: m.order !== wantOrder || (m.ShlokaManthraNumber ?? "").trim() !== wantLabel,
    };
  });

  const toFix = plan.filter((p) => p.needsFix);
  console.log(`\n── Updates (${toFix.length} rows) ──`);
  for (const p of toFix) {
    console.log(
      `  ${p.docId}: ${p.currentOrder}→${p.wantOrder}, "${p.currentLabel}"→"${p.wantLabel}"`,
    );
    if (APPLY) {
      const { status, body } = await strapiReq("PUT", `/api/manthras/${p.docId}`, {
        data: { order: p.wantOrder, ShlokaManthraNumber: p.wantLabel },
      });
      if (status >= 200 && status < 300) process.stdout.write("    ✓\n");
      else console.error("    ✗", status, JSON.stringify(body).slice(0, 120));
    }
  }

  if (APPLY) {
    const after = await fetchAllManthras(SECTION);
    console.log(`\nFinal count: ${after.length}`);
    const dupAfter = after.reduce((acc, m) => {
      acc[m.order] = (acc[m.order] ?? 0) + 1;
      return acc;
    }, {});
    const dupOrders = Object.entries(dupAfter).filter(([, c]) => c > 1);
    console.log(`Duplicate orders: ${dupOrders.length === 0 ? "none ✓" : dupOrders.join(", ")}`);
    for (const m of after) {
      console.log(`  ${m.order}  ${m.ShlokaManthraNumber}  ${m.documentId}`);
    }
  } else {
    console.log("\nDry run complete. Re-run with --apply to execute.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
