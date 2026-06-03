/**
 * Inspect all mantras in a Strapi section (orders, labels, duplicate analysis).
 * Usage: STRAPI_API_TOKEN=... node scripts/inspect_section_mantras.mjs <sectionDocumentId>
 */
import http from "node:http";

const STRAPI_HOST = process.env.STRAPI_HOST || "13.53.121.15";
const STRAPI_PORT = Number(process.env.STRAPI_PORT || 1337);
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const SECTION = process.argv[2];

if (!STRAPI_TOKEN || !SECTION) {
  console.error("Usage: STRAPI_API_TOKEN=... node scripts/inspect_section_mantras.mjs <sectionDocumentId>");
  process.exit(1);
}

function strapiReq(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: STRAPI_HOST, port: STRAPI_PORT, path, method, headers: { Authorization: `Bearer ${STRAPI_TOKEN}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function plainSanskrit(entry) {
  const blocks = entry?.Sanskrit ?? entry?.sanskrit;
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks.slice(0, 100);
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((b) => b.children ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .slice(0, 100);
}

async function fetchAllManthras(sectionDocId) {
  const all = [];
  let page = 1;
  while (true) {
    const path =
      `/api/manthras?filters[Section][documentId][$eq]=${encodeURIComponent(sectionDocId)}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=documentId` +
      `&sort=order:asc&pagination[page]=${page}&pagination[pageSize]=100`;
    const res = await strapiReq("GET", path);
    all.push(...(res.data ?? []));
    if (page >= (res.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

async function main() {
  const sec = await strapiReq("GET", `/api/sections/${SECTION}?populate[grantha][fields][0]=title&fields[0]=title`);
  console.log("Grantha:", sec.data?.grantha?.title ?? "(unknown)");
  console.log("Section:", sec.data?.title ?? SECTION);
  console.log();

  const all = await fetchAllManthras(SECTION);
  console.log(`Total mantras: ${all.length}\n`);

  for (const m of all) {
    const sk = plainSanskrit(m.ShlokaManthraEntry);
    console.log(
      `${String(m.order).padStart(8)}  ${(m.ShlokaManthraNumber ?? "").padEnd(14)}  ${m.documentId}${sk ? `  | ${sk}` : ""}`,
    );
  }

  const byOrder = new Map();
  for (const m of all) {
    const list = byOrder.get(m.order) ?? [];
    list.push(m);
    byOrder.set(m.order, list);
  }

  const dups = [...byOrder.entries()].filter(([, list]) => list.length > 1);
  if (dups.length) {
    console.log("\n=== DUPLICATE ORDERS ===");
    for (const [order, rows] of dups) {
      console.log(`\norder=${order} (${rows.length} rows):`);
      for (const r of rows) {
        const detail = await strapiReq(
          "GET",
          `/api/manthras/${r.documentId}?fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=createdAt&fields[3]=updatedAt&populate[ShlokaManthraEntry][fields][0]=Sanskrit`,
        );
        const d = detail.data ?? {};
        console.log(
          `  ${d.documentId}  label="${d.ShlokaManthraNumber}"  created=${d.createdAt}  updated=${d.updatedAt}`,
        );
        const sk = plainSanskrit(d.ShlokaManthraEntry);
        if (sk) console.log(`    sanskrit: ${sk}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
