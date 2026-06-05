/**
 * Cycle the verse labels of Vedanta Paribhasha verses 1.1.3 / 1.1.4 / 1.1.5:
 *   old 1.1.3 -> 1.1.4   |   old 1.1.4 -> 1.1.5   |   old 1.1.5 -> 1.1.3
 * Content (Vaakhyaa / bhashyam / teeka) stays with each verse; only the label and the
 * sort `order` move, so reading order stays 1.1.3, 1.1.4, 1.1.5.
 *
 * Read-only by default. Set DRY_RUN=0 to apply.
 *   npx tsx script/renumber-vedanta-paribhasha-1-1-3to5.mjs
 *   DRY_RUN=0 npx tsx script/renumber-vedanta-paribhasha-1-1-3to5.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim();
    }
  } catch {
    /* ignore */
  }
}
loadEnv();

const STRAPI = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const TOKEN = process.env.STRAPI_API_TOKEN;
const DRY_RUN = process.env.DRY_RUN !== "0";
if (!TOKEN) {
  console.error("Set STRAPI_API_TOKEN in .env");
  process.exit(1);
}

async function strapi(path, init) {
  const r = await fetch(STRAPI + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${init?.method ?? "GET"} ${path}: ${await r.text()}`);
  return r.json();
}

function suffixOf(label) {
  const m = String(label ?? "").match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : "";
}
function preview(blocks) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .flatMap((b) => (b?.children ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")))
    .join(" ")
    .trim();
  return text.slice(0, 70) + (text.length > 70 ? "…" : "");
}

// 1. Grantha
const gRes = await strapi(
  "/api/granthas?filters[GranthaName][$containsi]=paribhasha&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=10",
);
const grantha = (gRes.data ?? []).find((g) => /vedanta\s*paribhasha/i.test(g.GranthaName)) ?? gRes.data?.[0];
if (!grantha) {
  console.error("Vedanta Paribhasha not found");
  process.exit(1);
}
const gid = grantha.documentId;
console.log("Grantha:", grantha.GranthaName, gid);

// 2. All mantras for this grantha
let page = 1;
const all = [];
while (true) {
  const r = await strapi(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order" +
      "&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title" +
      "&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry" +
      "&populate[ShlokaManthraEntry][fields][1]=EnglishTranslationText" +
      "&populate[BhashyamEntry][fields][0]=SanskritTextEntry" +
      `&sort[0]=order:asc&pagination[pageSize]=100&pagination[page]=${page}`,
  );
  all.push(...(r.data ?? []));
  if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
  page++;
}
console.log(`Total mantras: ${all.length}`);

const TARGET = ["1.1.3", "1.1.4", "1.1.5"];
const bySuffix = new Map();
for (const m of all) {
  const s = suffixOf(m.ShlokaManthraNumber);
  if (TARGET.includes(s)) {
    if (!bySuffix.has(s)) bySuffix.set(s, []);
    bySuffix.get(s).push(m);
  }
}

console.log("\n=== Current rows for 1.1.3 / 1.1.4 / 1.1.5 ===");
for (const s of TARGET) {
  const rows = bySuffix.get(s) ?? [];
  console.log(`\n  ${s}: ${rows.length} row(s)`);
  for (const m of rows) {
    console.log("   ", {
      documentId: m.documentId,
      label: m.ShlokaManthraNumber,
      order: m.order,
      section: m.Section?.title,
      sectionDocId: m.Section?.documentId,
      shloka: preview(m.ShlokaManthraEntry?.SanskritTextEntry),
      bhashyam: preview(m.BhashyamEntry?.SanskritTextEntry),
    });
  }
}

// Bail if any target suffix is missing or ambiguous (more than one row).
const problems = [];
for (const s of TARGET) {
  const rows = bySuffix.get(s) ?? [];
  if (rows.length !== 1) problems.push(`${s}: found ${rows.length} rows (need exactly 1)`);
}
if (problems.length > 0) {
  console.error("\n!! Cannot safely renumber — ambiguous/missing rows:");
  for (const p of problems) console.error("   - " + p);
  console.error("Resolve duplicates first (cleanup orphan/stray rows), then re-run.");
  process.exit(1);
}

const v3 = bySuffix.get("1.1.3")[0];
const v4 = bySuffix.get("1.1.4")[0];
const v5 = bySuffix.get("1.1.5")[0];

// Permutation: content keeps its documentId; label + order move to the new slot.
//   v5 -> label 1.1.3, order = v3.order   (sorts first)
//   v3 -> label 1.1.4, order = v4.order   (sorts second)
//   v4 -> label 1.1.5, order = v5.order   (sorts third)
function relabel(label) {
  // Preserve any leaf prefix (e.g. "Vaakhyaa 1.1.5"); only swap the numeric suffix.
  return (cur, newSuffix) => String(cur ?? "").replace(/(\d+(?:\.\d+)+)\s*$/, newSuffix) || newSuffix;
}
const swap = relabel();
const plan = [
  { row: v5, newLabel: swap(v5.ShlokaManthraNumber, "1.1.3"), newOrder: v3.order },
  { row: v3, newLabel: swap(v3.ShlokaManthraNumber, "1.1.4"), newOrder: v4.order },
  { row: v4, newLabel: swap(v4.ShlokaManthraNumber, "1.1.5"), newOrder: v5.order },
];

console.log("\n=== Planned changes ===");
for (const p of plan) {
  console.log(
    `  ${p.row.documentId}  "${p.row.ShlokaManthraNumber}" (order ${p.row.order})  ->  "${p.newLabel}" (order ${p.newOrder})`,
  );
}

if (DRY_RUN) {
  console.log("\nDRY RUN — no changes written. Re-run with DRY_RUN=0 to apply.");
  process.exit(0);
}

console.log("\nApplying…");
for (const p of plan) {
  await strapi(`/api/manthras/${p.row.documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data: { ShlokaManthraNumber: p.newLabel, order: p.newOrder } }),
  });
  console.log(`  updated ${p.row.documentId} -> "${p.newLabel}" (order ${p.newOrder})`);
}
console.log("Done.");
