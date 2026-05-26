/**
 * Audit a grantha for mantra rows that look mis-linked or partially updated.
 * Run: npx tsx script/audit-grantha-mantra-integrity.ts --grantha "Sarva Vedanta"
 */
import { execFileSync } from "node:child_process";
import {
  buildSectionAncestorPath,
  buildSectionByDocIdMap,
  isMantraSectionMisplacedOnAdhyaya,
  sectionPathLabel,
  strapiGranthaHasKhandaSections,
} from "../client/src/lib/grantha-structure-sync.ts";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const TOKEN = process.env.STRAPI_API_TOKEN || "";

function curl(path: string): any {
  const out = execFileSync(
    "curl",
    ["-gsk", "--max-time", "90", "-H", `Authorization: Bearer ${TOKEN}`, `${STRAPI_URL}${path}`],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function blocksText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return (v as any[])
    .map((b) => ((b.children ?? []) as any[]).map((c) => c.text || "").join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let granthaQuery = "Sarva Vedanta";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) granthaQuery = args[++i];
  }
  return { granthaQuery };
}

async function main() {
  const { granthaQuery } = parseArgs();
  if (!TOKEN) {
    console.error("STRAPI_API_TOKEN required");
    process.exit(1);
  }

  const gRes = curl(
    `/api/granthas?filters[GranthaName][$containsi]=${encodeURIComponent(granthaQuery)}&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=10`,
  );
  const grantha = (gRes.data ?? [])[0];
  if (!grantha?.documentId) {
    console.error("Grantha not found");
    process.exit(1);
  }

  const gid = grantha.documentId;
  const sections = curl(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(gid)}&populate[parent][fields][0]=documentId&fields[0]=documentId&fields[1]=title&pagination[pageSize]=100`,
  ).data ?? [];

  const manthras = curl(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(gid)}&populate[ShlokaManthraEntry][populate]=*&populate[Section][fields][0]=title&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=updatedAt&pagination[pageSize]=500`,
  ).data ?? [];

  const byId = buildSectionByDocIdMap(sections);
  console.log(`\n=== ${grantha.GranthaName} (${gid}) ===`);
  console.log(`Sections: ${sections.length}, Mantras: ${manthras.length}\n`);

  const misplaced = strapiGranthaHasKhandaSections(sections)
    ? manthras.filter((m: any) => isMantraSectionMisplacedOnAdhyaya(m.Section?.documentId, sections))
    : [];

  if (misplaced.length > 0) {
    console.log(`⚠ ${misplaced.length} mantra(s) on Adhyaya (should be on Khanda):`);
    for (const m of misplaced.slice(0, 20)) {
      console.log(`  ${m.ShlokaManthraNumber}  ${m.documentId}  updated ${m.updatedAt}`);
    }
  }

  const partial: any[] = [];
  const empty: any[] = [];
  for (const m of manthras) {
    const sk = blocksText(m.ShlokaManthraEntry?.SanskritTextEntry);
    const en = blocksText(m.ShlokaManthraEntry?.EnglishTranslationText);
    const secId = m.Section?.documentId;
    const path = secId ? sectionPathLabel(buildSectionAncestorPath(secId, byId)) : "?";
    if (sk.length > 30 && en.length < 20) {
      partial.push({ m, path, issue: "Sanskrit only (English empty)" });
    } else if (en.length > 30 && sk.length < 20) {
      partial.push({ m, path, issue: "English only (Sanskrit empty) — often after partial publish" });
    } else if (sk.length < 5 && en.length < 5) {
      empty.push({ m, path });
    }
  }

  if (partial.length > 0) {
    console.log(`\n⚠ ${partial.length} row(s) with mismatched Sanskrit/English fill:`);
    for (const { m, path, issue } of partial.slice(0, 25)) {
      console.log(`  ${m.ShlokaManthraNumber}  [${issue}]`);
      console.log(`    ${path}`);
      console.log(`    updated ${m.updatedAt}  docId ${m.documentId}`);
      console.log(`    SK: ${blocksText(m.ShlokaManthraEntry?.SanskritTextEntry).slice(0, 70)}`);
      console.log(`    EN: ${blocksText(m.ShlokaManthraEntry?.EnglishTranslationText).slice(0, 70)}`);
    }
  }

  if (empty.length > 0) {
    console.log(`\n○ ${empty.length} empty stub row(s) (first 10):`);
    for (const { m, path } of empty.slice(0, 10)) {
      console.log(`  ${m.ShlokaManthraNumber}  ${path}`);
    }
  }

  if (misplaced.length === 0 && partial.length === 0) {
    console.log("\nNo obvious integrity issues detected in live Strapi data.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
