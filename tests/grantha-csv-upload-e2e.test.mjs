#!/usr/bin/env node --import tsx
/**
 * CSV grantha upload - end to end, on the real import code (no browser).
 * ======================================================================
 * Drives the exact shape the editors use:
 *
 *   Number,Mantra,Bhashyam
 *   1.1,<sanskrit>,<bhashyam>
 *   1.2,...
 *   2.1,...        <- chapter 2 starts
 *
 * through the real pipeline the dialog runs -
 *   parseCsv -> planCsvRows -> buildImportPayload -> placeCsvCreates -> prepareHierarchyForSave
 * - and checks the tree the editor ends up holding, plus the verse labels the publish
 * step would send to Strapi.
 *
 * Run: node --import tsx tests/grantha-csv-upload-e2e.test.mjs
 */

import {
  parseCsv,
  planCsvRows,
  buildImportPayload,
  buildCoreTargets,
  buildTokenCounts,
  flattenTree,
  guessNumberColumn,
} from "../client/src/lib/grantha-csv-import.ts";
import { placeCsvCreates } from "../client/src/lib/grantha-csv-placement.ts";
import { prepareHierarchyForSave } from "../client/src/lib/grantha-structure-sync.ts";
import { portalMantraTitleForConfiguredLeaf } from "../shared/grantha-publish-integrity.ts";

let PASS = 0;
let FAIL = 0;
function assert(cond, label) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL++;
    console.error(`  ✗ ${label}`);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const detail = a === e ? "" : "\n      expected " + e + "\n      actual   " + a;
  assert(a === e, label + detail);
}

// ── The grantha: one level of sections (chapters), verses hang off the chapter ──
const CFG = {
  levelOneEnabled: true,
  levelOneName: "Adhyaya",
  levelTwoEnabled: false,
  levelTwoName: "Khanda",
  levelThreeEnabled: false,
  levelThreeName: "Pada",
  leafName: "Shloka",
};
const PLACEMENT_CFG = {
  levelOneName: CFG.levelOneName,
  levelTwoName: CFG.levelTwoName,
  levelThreeName: CFG.levelThreeName,
  levelTwoEnabled: CFG.levelTwoEnabled,
  levelThreeEnabled: CFG.levelThreeEnabled,
};

let seq = 0;
const uid = () => `u${++seq}`;

/** Chapter verse counts, deliberately past 9 so 1.10 vs 1.2 ordering is exercised. */
const CHAPTERS = [12, 3, 11, 2];

function buildCsv({ rowOrder = "natural" } = {}) {
  const rows = [];
  CHAPTERS.forEach((count, ci) => {
    for (let v = 1; v <= count; v++) {
      rows.push([`${ci + 1}.${v}`, `mantra ${ci + 1}.${v}`, `bhashyam ${ci + 1}.${v}`]);
    }
  });
  if (rowOrder === "text") rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = rows
    .map(([n, m, b]) => `${n},"${m}","${b}"`)
    .join("\n");
  return `Number,Mantra,Bhashyam\n${body}\n`;
}

/** The whole import, exactly as the dialog sequences it. */
function importCsv(csvText, existingTree = []) {
  const parsed = parseCsv(csvText);
  const headers = parsed[0].map((h) => h.trim());
  const rows = parsed.slice(1);
  const numberColumn = guessNumberColumn(headers);

  const flat = flattenTree(existingTree);
  const plan = planCsvRows({
    rows,
    numberColumn,
    matchMode: "number",
    onMissing: "create",
    flat,
    rangeVerses: flat,
    rangeIds: new Set(flat.map((f) => f.manthraId)),
    tokenCounts: buildTokenCounts(flat),
  });

  const coreTargets = buildCoreTargets([]);
  const mapping = {
    coreTargets,
    // "Mantra" column -> the shloka's Sanskrit; "Bhashyam" column -> the bhashyam's Sanskrit.
    coreMapping: {
      "shloka.SanskritTextEntry": headers.indexOf("Mantra"),
      "bhashyam.SanskritTextEntry": headers.indexOf("Bhashyam"),
    },
    translationRows: [],
    teekas: [],
  };
  const payload = buildImportPayload({
    plan,
    rows,
    mapping,
    placement: { mode: "group", sectionLevels: 1 },
  });

  const placed = placeCsvCreates(
    existingTree,
    payload.creates,
    payload.placement,
    PLACEMENT_CFG,
    {
      uid,
      buildManthra: (c, order) => ({
        id: uid(),
        title: c.number,
        order,
        _isNewLocal: true,
        ShlokaManthraEntry: c.updates.ShlokaManthraEntry,
        BhashyamForShlokaManthra: c.updates.BhashyamForShlokaManthra,
      }),
    },
  );
  // What the editor stores on Save, and what publish then walks.
  return { headers, plan, payload, tree: prepareHierarchyForSave(placed, CFG) };
}

/** First line of text out of a Strapi blocks value. */
function blockText(blocks) {
  if (!Array.isArray(blocks)) return null;
  return (blocks[0]?.children ?? []).map((c) => c.text ?? "").join("");
}
function chapterLayout(tree) {
  return tree.map((a) => [a.title, a.khandas.flatMap((k) => k.manthras.map((m) => m.title))]);
}

// ── 1. The natural file: 1.1 … 1.12, 2.1 …, in row order ─────────────────────
{
  console.log("\nNatural row order (1.1, 1.2, ... then 2.1, ...)");
  const { headers, plan, payload, tree } = importCsv(buildCsv());

  eq(headers, ["Number", "Mantra", "Bhashyam"], "header row parsed");
  eq(guessNumberColumn(headers), 0, "verse-number column auto-detected");
  eq(plan.filter((p) => p.action === "create").length, 28, "every row is a create on an empty grantha");
  eq(plan.filter((p) => p.action !== "create").length, 0, "nothing skipped");
  eq(payload.updates.length, 0, "no updates against an empty grantha");

  eq(tree.length, CHAPTERS.length, "one section per chapter number");
  eq(
    tree.map((a) => a.title),
    ["Prathama Adhyaya", "Dvitiya Adhyaya", "Tritiya Adhyaya", "Chaturtha Adhyaya"],
    "chapters are named for their own number",
  );
  eq(tree.map((a) => a.order), [1, 2, 3, 4], "chapter order 1..n");
  eq(
    tree.map((a) => a.khandas[0].manthras.length),
    CHAPTERS,
    "each chapter holds exactly its own verses",
  );
  eq(
    tree[0].khandas[0].manthras.map((m) => m.title),
    ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11", "1.12"],
    "chapter 1 verses in numeric order, 1.10 after 1.9",
  );
  eq(
    tree[2].khandas[0].manthras.map((m) => m.title),
    ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "3.11"],
    "chapter 3 likewise",
  );
  assert(
    tree.every((a) => a.khandas.length === 1 && a.khandas[0].title === "_default"),
    "single-level grantha: verses sit under the chapter's _default khanda (publish attaches them to the chapter itself)",
  );

  // Content landed on the right verse, in the right field.
  const v = tree[1].khandas[0].manthras[2]; // 2.3
  eq(v.title, "2.3", "verse 2.3 is where it should be");
  eq(blockText(v.ShlokaManthraEntry?.SanskritTextEntry), "mantra 2.3", "Mantra column -> shloka Sanskrit");
  eq(blockText(v.BhashyamForShlokaManthra?.SanskritTextEntry), "bhashyam 2.3", "Bhashyam column -> bhashyam Sanskrit");
  const mismatched = tree.flatMap((a) =>
    a.khandas[0].manthras.filter(
      (m) =>
        blockText(m.ShlokaManthraEntry?.SanskritTextEntry) !== `mantra ${m.title}` ||
        blockText(m.BhashyamForShlokaManthra?.SanskritTextEntry) !== `bhashyam ${m.title}`,
    ),
  );
  eq(mismatched.map((m) => m.title), [], "every verse carries its own mantra + bhashyam");

  // What publish will send as ShlokaManthraNumber.
  eq(
    tree[0].khandas[0].manthras.slice(0, 3).map((m) => portalMantraTitleForConfiguredLeaf(m.title, CFG.leafName, m.title)),
    ["Shloka 1.1", "Shloka 1.2", "Shloka 1.3"],
    "publish labels are the configured leaf + the CSV number",
  );
}

// ── 2. The same file sorted as text - the shape that broke ───────────────────
{
  console.log("\nSame file with rows sorted as text (1.1, 1.10, 1.11, 1.12, 1.2, ...)");
  const csv = buildCsv({ rowOrder: "text" });
  const firstNumbers = parseCsv(csv).slice(1, 5).map((r) => r[0]);
  eq(firstNumbers, ["1.1", "1.10", "1.11", "1.12"], "the file really is in text order");

  const { tree } = importCsv(csv);
  eq(
    chapterLayout(tree),
    chapterLayout(importCsv(buildCsv()).tree),
    "text-sorted rows produce the identical tree as the natural order",
  );
  const bad = tree.filter(
    (a) => new Set(a.khandas[0].manthras.map((m) => m.title.split(".")[0])).size > 1,
  );
  eq(bad.map((a) => a.title), [], "no chapter mixes two chapters' verses");
}

// ── 3. Re-uploading the same file updates in place ───────────────────────────
{
  console.log("\nRe-upload of the same file");
  const first = importCsv(buildCsv());
  const second = importCsv(buildCsv(), first.tree);

  eq(second.plan.filter((p) => p.action === "create").length, 0, "nothing is created twice");
  eq(second.plan.filter((p) => p.action === "update").length, 28, "every row matches its existing verse");
  eq(second.payload.placement, null, "no placement needed when there is nothing to create");
  eq(chapterLayout(second.tree), chapterLayout(first.tree), "tree unchanged by the re-upload");
}

// ── 4. A follow-up file that adds a chapter and extends an existing one ──────
{
  console.log("\nSecond file: new chapter 5 plus more verses for chapter 2");
  const first = importCsv(buildCsv());
  const extra = "Number,Mantra,Bhashyam\n5.1,\"mantra 5.1\",\"bhashyam 5.1\"\n2.4,\"mantra 2.4\",\"bhashyam 2.4\"\n";
  const { plan, tree } = importCsv(extra, first.tree);

  eq(plan.map((p) => p.action), ["create", "create"], "both rows are new verses");
  eq(tree.length, 5, "chapter 5 added");
  eq(tree[4].title, "Panchama Adhyaya", "and named for its number");
  eq(tree[1].khandas[0].manthras.map((m) => m.title), ["2.1", "2.2", "2.3", "2.4"], "2.4 appended to chapter 2 in order");
  eq(
    blockText(tree[1].khandas[0].manthras[3].BhashyamForShlokaManthra?.SanskritTextEntry),
    "bhashyam 2.4",
    "its bhashyam came along",
  );
}

// ── 5. Quoted cells: commas, embedded newlines, escaped quotes ───────────────
{
  console.log("\nQuoted multi-line Sanskrit/bhashyam cells");
  const csv =
    'Number,Mantra,Bhashyam\n' +
    '1.1,"line one,\nline two","he said ""om"", then paused"\n' +
    '1.2,"plain","plain b"\n';
  const { plan, tree } = importCsv(csv);
  eq(plan.map((p) => p.action), ["create", "create"], "an embedded newline does not split the row");
  const m = tree[0].khandas[0].manthras[0];
  eq(
    (m.ShlokaManthraEntry?.SanskritTextEntry ?? []).map((b) => (b.children ?? []).map((c) => c.text).join("")),
    ["line one,", "line two"],
    "a newline inside a quoted cell becomes a second block",
  );
  eq(blockText(m.BhashyamForShlokaManthra?.SanskritTextEntry), 'he said "om", then paused', "escaped quotes survive");
}

// ── 6. Two-level grantha: chapter.khanda.verse ───────────────────────────────
{
  console.log("\nTwo-level grantha (1.1.1 = chapter 1, khanda 1, verse 1)");
  const cfg2 = { ...CFG, levelTwoEnabled: true };
  const placement2 = { ...PLACEMENT_CFG, levelTwoEnabled: true };
  const csv = [
    "Number,Mantra,Bhashyam",
    ...["1.1.1", "1.1.2", "1.2.1", "2.1.1"].map((n) => `${n},"mantra ${n}","bhashyam ${n}"`),
  ].join("\n");

  const parsed = parseCsv(csv);
  const headers = parsed[0];
  const rows = parsed.slice(1);
  const plan = planCsvRows({
    rows,
    numberColumn: 0,
    matchMode: "number",
    onMissing: "create",
    flat: [],
    rangeVerses: [],
    rangeIds: new Set(),
    tokenCounts: new Map(),
  });
  const payload = buildImportPayload({
    plan,
    rows,
    mapping: {
      coreTargets: buildCoreTargets([]),
      coreMapping: {
        "shloka.SanskritTextEntry": headers.indexOf("Mantra"),
        "bhashyam.SanskritTextEntry": headers.indexOf("Bhashyam"),
      },
      translationRows: [],
      teekas: [],
    },
    placement: { mode: "group", sectionLevels: 2 },
  });
  const tree = prepareHierarchyForSave(
    placeCsvCreates([], payload.creates, payload.placement, placement2, {
      uid,
      buildManthra: (c, order) => ({ id: uid(), title: c.number, order }),
    }),
    cfg2,
  );

  eq(
    tree.map((a) => [a.title, a.khandas.map((k) => [k.title, k.manthras.map((m) => m.title)])]),
    [
      ["Prathama Adhyaya", [["Prathama Khanda", ["1.1.1", "1.1.2"]], ["Dvitiya Khanda", ["1.2.1"]]]],
      ["Dvitiya Adhyaya", [["Prathama Khanda", ["2.1.1"]]]],
    ],
    "chapters and khandas both resolve by their own number",
  );
}

console.log(`\n${FAIL === 0 ? "PASS" : "FAIL"} - ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
