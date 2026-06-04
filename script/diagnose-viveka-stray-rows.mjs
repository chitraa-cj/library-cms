/**
 * Find misplaced Vivekachudamani rows (e.g. Shloka 2.1 on Dvitiya Adhyaya, blank 1.1.7).
 * Usage: npx tsx script/diagnose-viveka-stray-rows.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blocksToText } from "../client/src/lib/strapi-blocks.ts";

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
if (!TOKEN) {
  console.error("Set STRAPI_API_TOKEN in .env");
  process.exit(1);
}

async function strapi(path) {
  const r = await fetch(STRAPI + path, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
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

let sp = 1;
const secs = [];
while (true) {
  const r = await strapi(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=title&fields[2]=type&fields[3]=order" +
      "&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title" +
      `&pagination[pageSize]=100&pagination[page]=${sp}`,
  );
  secs.push(...(r.data ?? []));
  if (sp >= (r.meta?.pagination?.pageCount ?? 1)) break;
  sp++;
}

console.log("\n=== Sections (" + secs.length + ") ===");
for (const s of secs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
  const parent = s.parent?.title ? ` parent=${s.parent.title}` : "";
  console.log(`  ${s.documentId} | order=${s.order} | ${s.type ?? ""} | ${s.title}${parent}`);
}

let page = 1;
const mantras = [];
while (true) {
  const r = await strapi(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order" +
      "&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title&populate[Section][fields][2]=type" +
      "&populate[Section][populate][parent][fields][0]=documentId&populate[Section][populate][parent][fields][1]=title" +
      "&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry&populate[ShlokaManthraEntry][fields][1]=EnglishTranslationText" +
      `&pagination[pageSize]=100&pagination[page]=${page}`,
  );
  mantras.push(...(r.data ?? []));
  if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
  page++;
}
console.log("\nTotal mantras in Strapi:", mantras.length);

const targets = ["2.1", "1.1.7"];
for (const suf of targets) {
  const hits = mantras.filter((m) => {
    const label = String(m.ShlokaManthraNumber ?? "");
    return label.includes(suf) && (label.endsWith(suf) || label.match(new RegExp(`\\b${suf.replace(/\./g, "\\.")}\\b`)));
  });
  console.log(`\n=== Label suffix ${suf} (${hits.length} rows) ===`);
  for (const m of hits.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const sk = blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry).trim();
    const sec = m.Section;
    const path =
      sec?.parent?.title && sec?.title
        ? `${sec.parent.title} → ${sec.title}`
        : sec?.title ?? "?";
    console.log({
      documentId: m.documentId,
      ShlokaManthraNumber: m.ShlokaManthraNumber,
      order: m.order,
      section: path,
      sectionDocId: sec?.documentId,
      sanskritLen: sk.length,
      sanskritPreview: sk.slice(0, 80) || "(empty)",
    });
  }
}

const dvitiyaAdhyaya = secs.filter((s) =>
  String(s.title ?? "").toLowerCase().includes("dvitiya") &&
  String(s.type ?? "").toLowerCase().includes("adhyay"),
);
console.log("\n=== Dvitiya Adhyaya section(s) ===");
for (const s of dvitiyaAdhyaya) {
  const child = secs.filter((c) => c.parent?.documentId === s.documentId);
  const direct = mantras.filter((m) => m.Section?.documentId === s.documentId);
  console.log(s.documentId, s.title, "children:", child.length, "direct mantras:", direct.length);
  for (const m of direct) {
    console.log("  ", m.ShlokaManthraNumber, m.documentId, "order", m.order);
  }
}
