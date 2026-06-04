/**
 * Diagnose Atma Bodha mantra counts: raw Strapi vs suffix dedupe.
 * Usage: node script/diagnose-atma-bodha-count.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
}

function mantraNumberSuffix(title) {
  const t = (title ?? "").trim();
  const m = t.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

loadEnv();
const base = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const token = process.env.STRAPI_TOKEN;
if (!token) {
  console.error("STRAPI_TOKEN missing in .env");
  process.exit(1);
}
const headers = { Authorization: `Bearer ${token}` };

const gRes = await fetch(
  `${base}/api/granthas?filters[GranthaName][$containsi]=atma%20bodha&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5`,
  { headers },
);
const gJson = await gRes.json();
const grantha = gJson.data?.[0];
if (!grantha?.documentId) {
  console.error("Atma Bodha not found");
  process.exit(1);
}
console.log("Grantha:", grantha.GranthaName, grantha.documentId);

const mBase = new URL(`${base}/api/manthras`);
mBase.searchParams.set("filters[Section][grantha][documentId][$eq]", grantha.documentId);
mBase.searchParams.set("fields[0]", "documentId");
mBase.searchParams.set("fields[1]", "ShlokaManthraNumber");
mBase.searchParams.set("fields[2]", "order");
mBase.searchParams.set("populate[Section][fields][0]", "documentId");
mBase.searchParams.set("populate[Section][fields][1]", "title");
mBase.searchParams.set("sort[0]", "order:asc");
mBase.searchParams.set("pagination[pageSize]", "100");

const all = [];
let page = 1;
while (true) {
  mBase.searchParams.set("pagination[page]", String(page));
  const r = await fetch(mBase, { headers });
  const j = await r.json();
  all.push(...(j.data ?? []));
  if (page >= (j.meta?.pagination?.pageCount ?? 1)) break;
  page++;
}

console.log("Raw Strapi mantras:", all.length);

const bySection = new Map();
for (const m of all) {
  const sid = m.Section?.documentId ?? "(none)";
  if (!bySection.has(sid)) bySection.set(sid, []);
  bySection.get(sid).push(m);
}
console.log("Sections with mantras:");
for (const [sid, list] of bySection) {
  const title = list[0]?.Section?.title ?? "?";
  console.log(`  ${title} (${sid.slice(0, 12)}…): ${list.length} rows`);
}

const suffixCounts = new Map();
for (const m of all) {
  const s = mantraNumberSuffix(m.ShlokaManthraNumber) ?? "(no suffix)";
  suffixCounts.set(s, (suffixCounts.get(s) ?? 0) + 1);
}
const dups = [...suffixCounts.entries()].filter(([, c]) => c > 1);
console.log("Unique suffixes:", suffixCounts.size);
console.log("Duplicate suffix groups:", dups.length);
if (dups.length) {
  console.log("  examples:", dups.slice(0, 8));
}

const leafCounts = new Map();
for (const m of all) {
  const t = (m.ShlokaManthraNumber ?? "").trim();
  const leaf = t.match(/^(.+?)\s+[\d.]+$/)?.[1] ?? "(none)";
  leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
}
console.log("Leaf prefixes:", Object.fromEntries(leafCounts));

console.log("First 5 labels:", all.slice(0, 5).map((m) => m.ShlokaManthraNumber));
console.log("Last 5 labels:", all.slice(-5).map((m) => m.ShlokaManthraNumber));
