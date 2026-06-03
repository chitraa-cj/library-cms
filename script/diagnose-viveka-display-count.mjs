/**
 * Diagnose Vivekachudamani mantra display count (raw Strapi vs client dedupe).
 * Usage: npx tsx script/diagnose-viveka-display-count.mjs
 */
import { normalizeManthrasForMantrasTab } from "../client/src/lib/grantha-structure-sync.ts";

const STRAPI = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const TOKEN = process.env.STRAPI_API_TOKEN;
if (!TOKEN) {
  console.error("Set STRAPI_API_TOKEN");
  process.exit(1);
}

async function strapi(path) {
  const r = await fetch(STRAPI + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.json();
}

const gRes = await strapi(
  "/api/granthas?filters[GranthaName][$containsi]=vivekachudamani&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5",
);
const grantha = gRes.data?.[0];
if (!grantha) {
  console.error("Vivekachudamani not found");
  process.exit(1);
}
const gid = grantha.documentId;
console.log("Grantha:", grantha.GranthaName, gid);

let page = 1;
const all = [];
while (true) {
  const r = await strapi(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order" +
      "&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title" +
      "&populate[Section][populate][grantha][fields][0]=documentId" +
      "&populate[Section][populate][grantha][fields][1]=GranthaName" +
      `&pagination[pageSize]=100&pagination[page]=${page}`,
  );
  all.push(...(r.data ?? []));
  if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
  page++;
}

let sp = 1;
const secs = [];
while (true) {
  const r = await strapi(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=title" +
      "&populate[parent][fields][0]=documentId" +
      "&populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName" +
      `&pagination[pageSize]=100&pagination[page]=${sp}`,
  );
  secs.push(...(r.data ?? []));
  if (sp >= (r.meta?.pagination?.pageCount ?? 1)) break;
  sp++;
}

const normalized = all.map((m) => ({
  documentId: m.documentId,
  ShlokaManthraNumber: m.ShlokaManthraNumber,
  order: m.order,
  ShlokaManthraEntry: m.ShlokaManthraEntry,
  section: m.Section
    ? { documentId: m.Section.documentId, title: m.Section.title }
    : null,
  grantha: m.Section?.grantha ?? null,
}));

const sectionsNorm = secs.map((s) => ({
  documentId: s.documentId,
  title: s.title,
  parent: s.parent ? { documentId: s.parent.documentId } : undefined,
  grantha: s.grantha,
}));

console.log("\n=== Counts ===");
console.log("Strapi raw (this grantha):", normalized.length);
console.log("Sections loaded:", sectionsNorm.length);
console.log("After normalizeManthrasForMantrasTab:", normalizeManthrasForMantrasTab(normalized, sectionsNorm).length);
console.log("If only page 1 loaded (100 rows):", normalizeManthrasForMantrasTab(normalized.slice(0, 100), sectionsNorm).length);
