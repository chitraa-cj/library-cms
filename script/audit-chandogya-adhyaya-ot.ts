/**
 * List Chandogya mantras in Adhyaya 1 with missing ShlokaManthraEntry OtherTranslations.
 * Usage: npx tsx script/audit-chandogya-adhyaya-ot.ts [--adhyaya 1]
 */
import "../server/env";
import { otherTranslationLanguages } from "@shared/schema";
import {
  filledLangs,
  fetchMantraFull,
  listMantrasForGrantha,
  missingLangs,
  resolveGranthaByName,
} from "./lib/hermex-grantha-sync";
import { strapiRequest } from "../server/strapi";

const EXPECTED_OT = otherTranslationLanguages.length; // 43

function adhyayaFromLabel(label: string): number | null {
  const m = label.match(/(\d+(?:\.\d+)+)\s*$/);
  if (!m) return null;
  return parseInt(m[1].split(".")[0], 10);
}

function verseSuffix(label: string): string | null {
  const m = label.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

async function main() {
  const adhyayaNum = parseInt(
    process.argv.find((a, i) => process.argv[i - 1] === "--adhyaya") ?? "1",
    10,
  );

  const grantha = await resolveGranthaByName("Chandogya Upanishad");
  console.log(`Grantha: ${grantha.GranthaName} (${grantha.documentId})\n`);

  const sectionsRes = await strapiRequest(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(grantha.documentId)}` +
      `&pagination[pageSize]=100&fields[0]=documentId&fields[1]=title&fields[2]=order&fields[3]=type` +
      `&sort[0]=order:asc`,
  );
  const sections: any[] = sectionsRes?.data ?? [];
  const topLevel = sections.filter((s) => !s.parent).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  console.log(`Top-level sections (${topLevel.length}):`);
  for (const s of topLevel.slice(0, 8)) {
    console.log(`  order=${s.order} "${s.title}" ${s.documentId}`);
  }
  console.log("");

  const refs = await listMantrasForGrantha(grantha.documentId);
  const adhyayaRefs = refs.filter((r) => adhyayaFromLabel(r.label) === adhyayaNum);
  console.log(`Mantras with verse prefix ${adhyayaNum}.* : ${adhyayaRefs.length}\n`);

  const incomplete: Array<{
    label: string;
    docId: string;
    shlokaCount: number;
    missing: string[];
    bhashyamCount: number;
    bhashyamMissing: string[];
  }> = [];

  let idx = 0;
  for (const ref of adhyayaRefs) {
    idx++;
    if (idx % 20 === 0) process.stderr.write(`  fetched ${idx}/${adhyayaRefs.length}...\n`);
    const m = await fetchMantraFull(ref.documentId);
    if (!m) continue;
    const shlokaMissing = missingLangs(m.ShlokaManthraEntry);
    const shlokaCount = filledLangs(m.ShlokaManthraEntry).size;
    const bhashyamMissing = missingLangs(m.BhashyamEntry);
    const bhashyamCount = filledLangs(m.BhashyamEntry).size;

    if (shlokaMissing.length > 0 || bhashyamMissing.length > 0) {
      incomplete.push({
        label: ref.label,
        docId: ref.documentId,
        shlokaCount,
        missing: shlokaMissing,
        bhashyamCount,
        bhashyamMissing,
      });
    }
  }

  const shlokaOnly = incomplete.filter((r) => r.missing.length > 0);
  const complete = adhyayaRefs.length - shlokaOnly.length;

  console.log(`=== Adhyaya ${adhyayaNum} summary (live Strapi) ===`);
  console.log(`Shloka OT complete (${EXPECTED_OT}/${EXPECTED_OT}): ${complete}`);
  console.log(`Shloka OT incomplete: ${shlokaOnly.length}\n`);

  if (shlokaOnly.length === 0) {
    console.log("All mantras have full Shloka OtherTranslations.");
    return;
  }

  // Group by missing count
  const bySeverity = [...shlokaOnly].sort((a, b) => a.shlokaCount - b.shlokaCount);
  console.log("Mantras missing Shloka OtherTranslations:\n");
  console.log("verse | filled | missing count | missing languages");
  console.log("------|--------|---------------|------------------");
  for (const r of bySeverity) {
    const suf = verseSuffix(r.label) ?? r.label;
    const missPreview =
      r.missing.length <= 8
        ? r.missing.join(", ")
        : `${r.missing.slice(0, 6).join(", ")} … +${r.missing.length - 6} more`;
    console.log(
      `${suf.padEnd(8)} | ${String(r.shlokaCount).padStart(2)}/${EXPECTED_OT} | ${String(r.missing.length).padStart(13)} | ${missPreview}`,
    );
  }

  // Aggregate: which langs missing most often
  const langFreq = new Map<string, number>();
  for (const r of shlokaOnly) {
    for (const lang of r.missing) {
      langFreq.set(lang, (langFreq.get(lang) ?? 0) + 1);
    }
  }
  const topLangs = [...langFreq.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nLanguages missing most often (across incomplete mantras):");
  for (const [lang, n] of topLangs.slice(0, 15)) {
    console.log(`  ${lang}: ${n} mantra(s)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
