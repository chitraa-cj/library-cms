/**
 * Find all Strapi rows for Vivekachudamani suffix 1.1.5 and compare Mantras-tab vs Grantha-link picks.
 * Usage: npx tsx script/diagnose-viveka-1-1-5.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  dedupePublishedMantrasForDisplay,
  findStrapiMantraByVerseSuffix,
  normalizeManthrasForMantrasTab,
  pickBestStrapiMantraRefForLink,
  resolvePortalMantraToStrapiDoc,
  scoreStrapiManthraRowContent,
} from "../client/src/lib/grantha-structure-sync.ts";
import { blocksToText } from "../client/src/lib/strapi-blocks.ts";
import { buildMantraShlokaIndexFromSections } from "../client/src/lib/strapi-mantra-hydration.ts";

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
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

const SUFFIX = "1.1.5";

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
      "&populate[Section][populate][parent][fields][0]=documentId&populate[Section][populate][parent][fields][1]=title" +
      "&populate[Section][populate][grantha][fields][0]=documentId&populate[Section][populate][grantha][fields][1]=GranthaName" +
      "&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry&populate[ShlokaManthraEntry][fields][1]=EnglishTranslationText" +
      `&pagination[pageSize]=100&pagination[page]=${page}`,
  );
  all.push(...(r.data ?? []));
  if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
  page++;
}

const hits = all.filter((m) => {
  const label = String(m.ShlokaManthraNumber ?? "");
  const parts = label.match(/(\d+(?:\.\d+)+)/);
  return parts?.[1] === SUFFIX;
});

console.log(`\n=== All CMS rows with suffix ${SUFFIX} (${hits.length}) ===\n`);
for (const m of hits.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
  const sk = blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry).trim();
  const en = blocksToText(m.ShlokaManthraEntry?.EnglishTranslationText).trim();
  const score = scoreStrapiManthraRowContent(m.ShlokaManthraEntry);
  console.log({
    documentId: m.documentId,
    ShlokaManthraNumber: m.ShlokaManthraNumber,
    order: m.order,
    section: m.Section?.title,
    sectionDocId: m.Section?.documentId,
    parentSection: m.Section?.parent?.title,
    contentScore: score,
    sanskritPreview: sk.slice(0, 80) + (sk.length > 80 ? "…" : ""),
    englishPreview: en.slice(0, 60) + (en.length > 60 ? "…" : ""),
  });
}

let sp = 1;
const secs = [];
while (true) {
  const r = await strapi(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(gid)}` +
      "&fields[0]=documentId&fields[1]=title" +
      "&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title" +
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

const mantrasTabRows = normalizeManthrasForMantrasTab(normalized, sectionsNorm);
const tabWinner = mantrasTabRows.find(
  (m) => String(m.ShlokaManthraNumber ?? "").includes(SUFFIX),
);
console.log("\n=== Mantras tab winner (after normalizeManthrasForMantrasTab) ===");
if (tabWinner) {
  const sk = blocksToText(tabWinner.ShlokaManthraEntry?.SanskritTextEntry).trim();
  console.log({
    documentId: tabWinner.documentId,
    ShlokaManthraNumber: tabWinner.ShlokaManthraNumber,
    section: tabWinner.section?.title,
    sectionDocId: tabWinner.section?.documentId,
    sanskritPreview: sk.slice(0, 100),
  });
} else {
  console.log("(no row shown in Mantras tab for this suffix)");
}

// Simulate Prathama Khanda section list (common Viveka bucket)
const prathamaKhanda = secs.find((s) =>
  String(s.title ?? "").toLowerCase().includes("prathama khanda"),
);
const khandaDocId = prathamaKhanda?.documentId;
const khandaMantras = khandaDocId
  ? hits.filter((m) => m.Section?.documentId === khandaDocId)
  : [];

const refs = hits.map((m) => ({
  title: String(m.ShlokaManthraNumber ?? ""),
  docId: m.documentId,
  order: m.order ?? 0,
  contentScore: scoreStrapiManthraRowContent(m.ShlokaManthraEntry),
}));

const linkPick = pickBestStrapiMantraRefForLink(
  refs.filter((r) => r.title.includes(SUFFIX) || r.title.endsWith(SUFFIX)),
);
const suffixPick = findStrapiMantraByVerseSuffix(refs, "Shloka 1.1.5", "Shloka");

console.log("\n=== Grantha-style link (richest in merged refs) ===");
console.log(
  linkPick
    ? {
        docId: linkPick.docId,
        title: linkPick.title,
        order: linkPick.order,
        contentScore: linkPick.contentScore,
      }
    : null,
);

// Portal draft with stale preferred id (orphan from fix_viveka_duplicates.mjs)
const stalePreferred = "mdxi9j3ertfj1nj3vy0gxw2r";
const resolveStale = resolvePortalMantraToStrapiDoc(
  { title: "Shloka 1.1.5", strapiDocumentId: stalePreferred },
  { configuredLeaf: "Shloka", sectionMantras: refs, byOrder: new Map(), ambiguousOrders: new Set() },
);
const resolveNoPreferred = resolvePortalMantraToStrapiDoc(
  { title: "Shloka 1.1.5" },
  { configuredLeaf: "Shloka", sectionMantras: refs, byOrder: new Map(), ambiguousOrders: new Set() },
);
console.log("\n=== resolvePortalMantraToStrapiDoc ===");
console.log("With stale portal docId:", resolveStale);
console.log("Title only (no preferred):", resolveNoPreferred);

const sectionsWithMantras = secs.map((s) => ({
  ...s,
  manthras: all
    .filter((m) => m.Section?.documentId === s.documentId)
    .map((m) => ({
      documentId: m.documentId,
      ShlokaManthraNumber: m.ShlokaManthraNumber,
      order: m.order,
      ShlokaManthraEntry: m.ShlokaManthraEntry,
    })),
}));
const index = buildMantraShlokaIndexFromSections(sectionsWithMantras);
if (resolveStale?.docId) {
  const e = index.get(resolveStale.docId);
  const sk = blocksToText(e?.SanskritTextEntry).trim();
  console.log("\nShloka index body for stale preferred docId:", sk.slice(0, 100));
}
if (tabWinner?.documentId) {
  const e = index.get(tabWinner.documentId);
  const sk = blocksToText(e?.SanskritTextEntry).trim();
  console.log("Shloka index body for Mantras-tab winner:", sk.slice(0, 100));
}

const dedupeSec = dedupePublishedMantrasForDisplay(
  hits.map((m) => ({
    documentId: m.documentId,
    ShlokaManthraNumber: m.ShlokaManthraNumber,
    ShlokaManthraEntry: m.ShlokaManthraEntry,
    section: { documentId: m.Section?.documentId },
  })),
);
console.log("\n=== dedupePublishedMantrasForDisplay (per section:suffix) ===");
for (const m of dedupeSec) {
  const sk = blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry).trim();
  console.log(m.documentId, m.ShlokaManthraNumber, "sec", m.section?.documentId, sk.slice(0, 60));
}
