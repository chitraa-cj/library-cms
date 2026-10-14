/**
 * Accuracy and user-intervention metrics for the OCR → Grantha analysis.
 *
 * Why this exists: "99% correct" is only a number if something measures it, and model
 * self-reported confidence is NOT a measurement — a model that is wrong and sure of it
 * scores perfectly on its own confidence. This script scores a finished structure job
 * against a human-labelled expectation of the same document and prints the per-dimension
 * figures the acceptance criteria ask for. Nothing here infers quality from confidence;
 * confidence is reported separately, as calibration evidence.
 *
 * Usage
 * -----
 *   npm run accuracy:ocr-structure -- --job <structureJobId> --labels labels.json
 *   npm run accuracy:ocr-structure -- --labels labels.json --items items.json
 *
 * `--items` scores a saved StructureItem[] without a database, which is how a labelled
 * set can live in CI.
 *
 * The labels file
 * ---------------
 * {
 *   "config": { "depth": 3, "levelNames": ["Adhyaya", "Khanda", "Mantra"] },
 *   "verses": [
 *     {
 *       "csvNumber": "1.1.1",
 *       "shloka": { "sanskrit": "…" },          // any subset of sanskrit/iast/english
 *       "bhashyam": { "sanskrit": "…" },        // omit when the verse has none
 *       "teekas": [{ "teekaName": "Anandagiri", "sanskrit": "…" }]
 *     }
 *   ]
 * }
 *
 * Text is compared after whitespace normalisation only — never after "cleaning", because
 * preserving the source exactly is one of the things being measured.
 */
import "../server/env";

import { readFile } from "node:fs/promises";
import {
  assembleStructure,
  normalizeHierarchyConfig,
  validateStructure,
  type AssembledVerse,
  type StructureItem,
} from "@shared/ocr-structure";

interface LabelFieldSet {
  sanskrit?: string;
  iast?: string;
  english?: string;
  others?: Array<{ language: string; text: string }>;
}
interface LabelVerse {
  csvNumber: string;
  shloka?: LabelFieldSet;
  bhashyam?: LabelFieldSet;
  teekas?: Array<LabelFieldSet & { teekaName: string }>;
}
interface LabelFile {
  config: { depth: number; levelNames: string[] };
  verses: LabelVerse[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Whitespace-only normalisation: everything else is a real difference. */
function norm(text: string | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

function fieldsEqual(actual: LabelFieldSet | undefined, expected: LabelFieldSet | undefined): boolean {
  const fields: Array<keyof LabelFieldSet> = ["sanskrit", "iast", "english"];
  for (const field of fields) {
    const want = expected?.[field];
    if (want == null) continue;
    if (norm(actual?.[field] as string | undefined) !== norm(want as string)) return false;
  }
  for (const other of expected?.others ?? []) {
    const got = (actual?.others ?? []).find((o) => o.language === other.language);
    if (norm(got?.text) !== norm(other.text)) return false;
  }
  return true;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}% (${part}/${whole})`;
}

async function loadItems(): Promise<{ items: StructureItem[]; overridesApplied: number; label: string }> {
  const itemsPath = arg("items");
  if (itemsPath) {
    const parsed = JSON.parse(await readFile(itemsPath, "utf8"));
    const items: StructureItem[] = Array.isArray(parsed) ? parsed : parsed.items;
    return { items, overridesApplied: 0, label: itemsPath };
  }

  const jobId = arg("job");
  if (!jobId) {
    throw new Error("Pass --job <structureJobId> or --items <file.json>.");
  }
  // Imported lazily so the --items path needs no DATABASE_URL.
  const { getStructureJob } = await import("../server/structure/store");
  const { buildStructureResult } = await import("../server/structure/jobs");
  const job = await getStructureJob(jobId);
  if (!job) throw new Error(`No structure job ${jobId}.`);
  const result = await buildStructureResult(job);
  return {
    items: result.items,
    overridesApplied: ((job.overrides ?? []) as unknown[]).length,
    label: `job ${jobId}`,
  };
}

async function main() {
  const labelsPath = arg("labels");
  if (!labelsPath) throw new Error("Pass --labels <labels.json>.");
  const labels: LabelFile = JSON.parse(await readFile(labelsPath, "utf8"));
  const config = normalizeHierarchyConfig(labels.config);

  const { items, overridesApplied, label } = await loadItems();
  const structure = assembleStructure(items, config);
  const validation = validateStructure(structure);

  const byNumber = new Map<string, AssembledVerse>();
  for (const verse of structure.verses) byNumber.set(verse.csvNumber, verse);

  let hierarchyHit = 0;
  let textHit = 0;
  let bhashyamHit = 0;
  let bhashyamExpected = 0;
  let teekaHit = 0;
  let teekaExpected = 0;
  let missing = 0;
  const problems: string[] = [];

  for (const expected of labels.verses) {
    const actual = byNumber.get(expected.csvNumber);
    if (!actual) {
      missing++;
      problems.push(`missing entry ${expected.csvNumber}`);
      continue;
    }
    hierarchyHit++;

    if (fieldsEqual(actual.shloka, expected.shloka)) textHit++;
    else problems.push(`text differs on ${expected.csvNumber}`);

    if (expected.bhashyam) {
      bhashyamExpected++;
      if (fieldsEqual(actual.bhashyam, expected.bhashyam)) bhashyamHit++;
      else problems.push(`bhashyam differs on ${expected.csvNumber}`);
    }
    for (const teeka of expected.teekas ?? []) {
      teekaExpected++;
      const got = actual.teekas.find((t) => t.teekaName === teeka.teekaName);
      if (got && fieldsEqual(got, teeka)) teekaHit++;
      else problems.push(`teeka "${teeka.teekaName}" differs on ${expected.csvNumber}`);
    }
  }

  // Ordering: the generated entries, in document order, against the labelled order.
  const expectedOrder = labels.verses.map((v) => v.csvNumber);
  const actualOrder = structure.verses.map((v) => v.csvNumber).filter((n) => byNumber.has(n));
  const orderedPairs = actualOrder.filter((n) => expectedOrder.includes(n));
  let orderHits = 0;
  for (let i = 0; i < orderedPairs.length; i++) {
    if (orderedPairs[i] === expectedOrder[i]) orderHits++;
  }

  const spurious = structure.verses.filter((v) => !labels.verses.some((e) => e.csvNumber === v.csvNumber));
  const total = labels.verses.length;

  // Confidence calibration: how often a passage the model was confident about was wrong,
  // and how often a passage it doubted was right. This is the number that says whether
  // the confidence threshold is worth anything.
  const wrongNumbers = new Set(
    problems
      .map((p) => /(?:on|entry) ([\d.]+)/.exec(p)?.[1])
      .filter((n): n is string => Boolean(n)),
  );
  let confidentButWrong = 0;
  let doubtedButRight = 0;
  for (const verse of structure.verses) {
    const wrong = wrongNumbers.has(verse.csvNumber);
    if (verse.confidence >= 0.7 && wrong) confidentButWrong++;
    if (verse.confidence < 0.7 && !wrong) doubtedButRight++;
  }

  console.log(`\nOCR → Grantha accuracy — ${label}`);
  console.log(`labels: ${labelsPath} (${total} labelled entries)\n`);
  console.log(`hierarchy assignment     ${pct(hierarchyHit, total)}`);
  console.log(`content / text preserved ${pct(textHit, total)}`);
  console.log(`bhashyam association     ${pct(bhashyamHit, bhashyamExpected)}`);
  console.log(`teeka association        ${pct(teekaHit, teekaExpected)}`);
  console.log(`ordering                 ${pct(orderHits, expectedOrder.length)}`);
  console.log(`entries not found        ${missing}`);
  console.log(`entries not in labels    ${spurious.length}`);
  console.log("");
  console.log(`clarification questions  ${structure.ambiguities.length}`);
  console.log(`manual edits applied     ${overridesApplied}`);
  console.log(
    `content needing a look   ${pct(structure.stats.lowConfidence + structure.stats.unassigned, structure.stats.items)}`,
  );
  console.log(`blocking validation errors ${validation.errors.length}`);
  console.log("");
  console.log(`confident but wrong      ${confidentButWrong}`);
  console.log(`doubted but right        ${doubtedButRight}`);

  if (problems.length > 0) {
    console.log(`\nfirst ${Math.min(20, problems.length)} difference(s):`);
    for (const problem of problems.slice(0, 20)) console.log(`  - ${problem}`);
    if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
  }

  // Non-zero exit when the headline figure misses the target, so this can gate CI once a
  // labelled set exists.
  const targetPct = Number(arg("target") ?? "99");
  const headline = total === 0 ? 0 : (Math.min(hierarchyHit, textHit) / total) * 100;
  console.log(`\nheadline (hierarchy ∧ text): ${headline.toFixed(1)}% — target ${targetPct}%`);
  if (headline + 1e-9 < targetPct) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
