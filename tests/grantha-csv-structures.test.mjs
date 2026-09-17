#!/usr/bin/env node --import tsx
/**
 * CSV upload across the other grantha structures and numbering patterns.
 * ======================================================================
 * Companion to grantha-csv-upload-e2e.test.mjs, which covers the common
 * "chapter.verse into a one-level grantha" file. This one runs the same real
 * pipeline over the rest of what editors actually upload:
 *
 *   structures  - flat/stotra (no chapter numbers), two-level, three-level,
 *                 custom level and leaf names
 *   numbering   - bare numbers, "Shloka 1.1" prefixes, hyphen/colon/slash
 *                 separators, leading zeros, letter suffixes, duplicates
 *   modes       - match by number vs sequential, create-missing vs skip
 *
 * Run: node --import tsx tests/grantha-csv-structures.test.mjs
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
import {
  placeCsvCreates,
  duplicateVerseNumberGroups,
  sectionPathTokens,
  numberTokens,
} from "../client/src/lib/grantha-csv-placement.ts";
import { prepareHierarchyForSave } from "../client/src/lib/grantha-structure-sync.ts";

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

let seq = 0;
const uid = () => `u${++seq}`;

const FLAT = {
  levelOneEnabled: true, levelOneName: "Adhyaya",
  levelTwoEnabled: false, levelTwoName: "Khanda",
  levelThreeEnabled: false, levelThreeName: "Pada",
  leafName: "Shloka",
};
const TWO_LEVEL = { ...FLAT, levelTwoEnabled: true };
const THREE_LEVEL = { ...TWO_LEVEL, levelThreeEnabled: true };
const VEDIC = {
  levelOneEnabled: true, levelOneName: "Kanda",
  levelTwoEnabled: true, levelTwoName: "Sukta",
  levelThreeEnabled: false, levelThreeName: "Varga",
  leafName: "Mantra",
};

/** The whole import, exactly as the dialog sequences it. */
function importCsv({
  cfg,
  numbers,
  sectionLevels = 1,
  placementMode = "group",
  tree = [],
  onMissing = "create",
  matchMode = "number",
}) {
  const csv = "Number,Mantra,Bhashyam\n" + numbers.map((n) => `${n},"m ${n}","b ${n}"`).join("\n") + "\n";
  const parsed = parseCsv(csv);
  const headers = parsed[0];
  const rows = parsed.slice(1);
  const flat = flattenTree(tree);
  const plan = planCsvRows({
    rows,
    numberColumn: guessNumberColumn(headers),
    matchMode,
    onMissing,
    flat,
    rangeVerses: flat,
    rangeIds: new Set(flat.map((f) => f.manthraId)),
    tokenCounts: buildTokenCounts(flat),
  });
  const payload = buildImportPayload({
    plan,
    rows,
    mapping: {
      coreTargets: buildCoreTargets([]),
      coreMapping: { "shloka.SanskritTextEntry": 1, "bhashyam.SanskritTextEntry": 2 },
      translationRows: [],
      teekas: [],
    },
    placement:
      placementMode === "group"
        ? { mode: "group", sectionLevels }
        : { mode: "single", target: { adhyayaId: null, khandaId: null } },
  });
  // Step 1 of handleCsvImport: patch the verses the plan matched, in place.
  const patched = JSON.parse(JSON.stringify(tree));
  for (const u of payload.updates) {
    const a = patched.find((x) => x.id === u.adhyayaId);
    const k = a?.khandas.find((x) => x.id === u.khandaId);
    const list = u.padaId ? k?.padas?.find((x) => x.id === u.padaId)?.manthras : k?.manthras;
    const node = list?.find((m) => m.id === u.manthraId);
    if (node) Object.assign(node, u.updates);
  }
  tree = patched;

  const placed = placeCsvCreates(tree, payload.creates, payload.placement, {
    levelOneName: cfg.levelOneName,
    levelTwoName: cfg.levelTwoName,
    levelThreeName: cfg.levelThreeName,
    levelTwoEnabled: cfg.levelTwoEnabled !== false,
    levelThreeEnabled: !!cfg.levelThreeEnabled,
  }, {
    uid,
    buildManthra: (c, order) => ({
      id: uid(),
      title: c.number,
      order,
      ShlokaManthraEntry: c.updates.ShlokaManthraEntry,
      BhashyamForShlokaManthra: c.updates.BhashyamForShlokaManthra,
    }),
  });
  return { plan, payload, tree: prepareHierarchyForSave(placed, cfg) };
}

const text = (blocks) =>
  Array.isArray(blocks) ? (blocks[0]?.children ?? []).map((c) => c.text ?? "").join("") : null;

/** [sectionPath, verseLabels] for every leaf section, in tree order. */
function layout(tree) {
  const out = [];
  for (const a of tree) {
    for (const k of a.khandas) {
      if ((k.padas ?? []).length > 0) {
        for (const p of k.padas) out.push([`${a.title} > ${k.title} > ${p.title}`, p.manthras.map((m) => m.title)]);
      } else {
        out.push([`${a.title} > ${k.title}`, k.manthras.map((m) => m.title)]);
      }
    }
  }
  return out;
}
/** Every verse's mantra text, in tree order — proves content tracked its row. */
function contents(tree) {
  return tree.flatMap((a) =>
    a.khandas.flatMap((k) => [
      ...k.manthras.map((m) => text(m.ShlokaManthraEntry?.SanskritTextEntry)),
      ...(k.padas ?? []).flatMap((p) => p.manthras.map((m) => text(m.ShlokaManthraEntry?.SanskritTextEntry))),
    ]),
  );
}

// ── 1. Flat / stotra: one section, bare verse numbers ────────────────────────
{
  console.log("\nFlat grantha, bare numbers (stotra style)");
  const numbers = Array.from({ length: 12 }, (_, i) => `${i + 1}`);
  const { plan, tree } = importCsv({ cfg: FLAT, numbers, placementMode: "single" });

  eq(plan.filter((p) => p.action === "create").length, 12, "all 12 rows create a verse");
  eq(layout(tree).length, 1, "everything in one section");
  eq(
    layout(tree)[0][1],
    ["Shloka 1.1", "Shloka 1.2", "Shloka 1.3", "Shloka 1.4", "Shloka 1.5", "Shloka 1.6",
     "Shloka 1.7", "Shloka 1.8", "Shloka 1.9", "Shloka 1.10", "Shloka 1.11", "Shloka 1.12"],
    "bare numbers become the portal's canonical Shloka 1.n labels, 1.10 after 1.9",
  );
  eq(contents(tree), numbers.map((n) => `m ${n}`), "each verse kept its own row's text");
}

// ── 2. Numbers written with the leaf word in front ───────────────────────────
{
  console.log('\nNumbers written as "Shloka 1.1"');
  eq(numberTokens("Shloka 1.1"), ["1", "1"], "the leaf word is not a section token");
  const { tree } = importCsv({ cfg: FLAT, numbers: ["Shloka 1.1", "Shloka 1.2", "Shloka 2.1", "Shloka 2.2"] });
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya > _default", ["Shloka 1.1", "Shloka 1.2"]],
      ["Dvitiya Adhyaya > _default", ["Shloka 2.1", "Shloka 2.2"]],
    ],
    "chapter 2 gets its own section (it used to pile into chapter 1)",
  );
  eq(contents(tree), ["m Shloka 1.1", "m Shloka 1.2", "m Shloka 2.1", "m Shloka 2.2"], "content follows");
}

// ── 3. Separators other than "." ─────────────────────────────────────────────
{
  console.log("\nHyphen / colon / slash separators");
  for (const sep of ["-", ":", "/"]) {
    const { tree } = importCsv({ cfg: FLAT, numbers: [`1${sep}1`, `1${sep}2`, `2${sep}1`] });
    eq(
      layout(tree),
      [
        ["Prathama Adhyaya > _default", ["Shloka 1.1", "Shloka 1.2"]],
        ["Dvitiya Adhyaya > _default", ["Shloka 2.1"]],
      ],
      `"1${sep}1" numbering splits chapters the same way`,
    );
  }
}

// ── 4. Leading zeros ─────────────────────────────────────────────────────────
{
  console.log("\nLeading zeros");
  const { tree } = importCsv({ cfg: FLAT, numbers: ["01.01", "01.02", "02.01"] });
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya > _default", ["01.01", "01.02"]],
      ["Dvitiya Adhyaya > _default", ["02.01"]],
    ],
    "01.x and 02.x are chapters 1 and 2, labels left as the file wrote them",
  );
}

// ── 5. Two-level grantha ─────────────────────────────────────────────────────
{
  console.log("\nTwo-level grantha");
  const deep = importCsv({ cfg: TWO_LEVEL, numbers: ["1.1.1", "1.1.2", "1.2.1", "2.1.1"], sectionLevels: 2 });
  eq(
    layout(deep.tree),
    [
      ["Prathama Adhyaya > Prathama Khanda", ["1.1.1", "1.1.2"]],
      ["Prathama Adhyaya > Dvitiya Khanda", ["1.2.1"]],
      ["Dvitiya Adhyaya > Prathama Khanda", ["2.1.1"]],
    ],
    "chapter.khanda.verse fills both levels by number",
  );

  // Same grantha, but the file only numbers chapter.verse.
  const shallow = importCsv({ cfg: TWO_LEVEL, numbers: ["1.1", "1.2", "2.1"], sectionLevels: 1 });
  eq(
    layout(shallow.tree),
    [
      ["Prathama Adhyaya > Prathama Khanda", ["1.1", "1.2"]],
      ["Dvitiya Adhyaya > Prathama Khanda", ["2.1"]],
    ],
    "a chapter.verse file into a two-level grantha puts each chapter's verses in its first khanda",
  );
}

// ── 6. Three-level grantha ───────────────────────────────────────────────────
{
  console.log("\nThree-level grantha");
  const { tree } = importCsv({
    cfg: THREE_LEVEL,
    numbers: ["1.1.1.1", "1.1.1.2", "1.1.2.1", "1.2.1.1", "2.1.1.1"],
    sectionLevels: 3,
  });
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya > Prathama Khanda > Prathama Pada", ["1.1.1.1", "1.1.1.2"]],
      ["Prathama Adhyaya > Prathama Khanda > Dvitiya Pada", ["1.1.2.1"]],
      ["Prathama Adhyaya > Dvitiya Khanda > Prathama Pada", ["1.2.1.1"]],
      ["Dvitiya Adhyaya > Prathama Khanda > Prathama Pada", ["2.1.1.1"]],
    ],
    "all three levels resolve by their own number",
  );
  eq(contents(tree).length, 5, "every verse kept its content");

  // A follow-up file lands in the right place, and skips straight to chapter 3.
  const more = importCsv({ cfg: THREE_LEVEL, numbers: ["1.1.2.2", "3.1.1.1"], sectionLevels: 3, tree });
  eq(
    layout(more.tree).map(([path, v]) => [path, v.length]),
    [
      ["Prathama Adhyaya > Prathama Khanda > Prathama Pada", 2],
      ["Prathama Adhyaya > Prathama Khanda > Dvitiya Pada", 2],
      ["Prathama Adhyaya > Dvitiya Khanda > Prathama Pada", 1],
      ["Dvitiya Adhyaya > Prathama Khanda > Prathama Pada", 1],
      ["Tritiya Adhyaya > Prathama Khanda > Prathama Pada", 1],
    ],
    "1.1.2.2 joins its pada; chapter 3 is created as Tritiya even with no chapter 2 in the file",
  );
}

// ── 7. Custom level and leaf names ───────────────────────────────────────────
{
  console.log("\nCustom level / leaf names (Kanda > Sukta, leaf Mantra)");
  const { tree } = importCsv({ cfg: VEDIC, numbers: ["1.1.1", "1.1.2", "1.2.1", "2.1.1"], sectionLevels: 2 });
  eq(
    layout(tree),
    [
      ["Prathama Kanda > Prathama Sukta", ["1.1.1", "1.1.2"]],
      ["Prathama Kanda > Dvitiya Sukta", ["1.2.1"]],
      ["Dvitiya Kanda > Prathama Sukta", ["2.1.1"]],
    ],
    "sections are named with the grantha's configured level names",
  );

  const bare = importCsv({ cfg: VEDIC, numbers: ["1", "2", "3"], placementMode: "single" });
  eq(layout(bare.tree)[0][1], ["Mantra 1.1.1", "Mantra 1.1.2", "Mantra 1.1.3"], "bare numbers use the configured leaf name");
}

// ── 8. Colliding verse numbers are detected before import ────────────────────
{
  console.log("\nColliding verse numbers");
  eq(duplicateVerseNumberGroups(["1.1", "1.2", "1.1"]), [["1.1", "1.1"]], "the same number twice is flagged");
  eq(duplicateVerseNumberGroups(["1.1", "1.1a", "1.2"]), [["1.1", "1.1a"]], "a letter variant keys onto its base number");
  eq(duplicateVerseNumberGroups(["1.1", "1.2", "2.1"]), [], "distinct numbers are not flagged");
  eq(duplicateVerseNumberGroups(["Mangala", "1.1"]), [], "a number with no digits is not a numbering collision");

  // Why the warning matters: a save renumbers the letter form onto its neighbour.
  const { tree } = importCsv({ cfg: FLAT, numbers: ["1.1", "1.1a", "1.2"] });
  eq(
    layout(tree)[0][1],
    ["1.1", "Shloka 1.2", "1.2"],
    "unflagged, 1.1a would be relabelled onto 1.2 — which is exactly what the dialog now warns about",
  );
}

// ── 9. A row whose number has no digits at all ───────────────────────────────
{
  console.log("\nNumber column with no digits");
  eq(sectionPathTokens("Mangala"), ["Mangala"], "a wordy number keeps its own token");
  const { tree } = importCsv({ cfg: FLAT, numbers: ["1.1", "Mangala", "1.2"] });
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya > _default", ["1.1", "1.2"]],
      ["Dvitiya Adhyaya > _default", ["Shloka 2.1"]],
    ],
    "it is parked in a section of its own instead of being folded into chapter 1",
  );
}

// ── 10. Match modes and skip mode ────────────────────────────────────────────
{
  console.log("\nMatch modes");
  const base = importCsv({ cfg: FLAT, numbers: ["1.1", "1.2", "1.3"] });

  const seqRun = importCsv({
    cfg: FLAT,
    numbers: ["ignored-a", "ignored-b", "ignored-c"],
    tree: base.tree,
    matchMode: "sequential",
  });
  eq(seqRun.plan.map((p) => p.action), ["update", "update", "update"], "sequential mode maps row N to verse N");
  eq(layout(seqRun.tree)[0][1], ["1.1", "1.2", "1.3"], "labels untouched by a sequential update");
  eq(
    contents(seqRun.tree),
    ["m ignored-a", "m ignored-b", "m ignored-c"],
    "row content replaced verse content in row order",
  );

  const skipRun = importCsv({ cfg: FLAT, numbers: ["1.1", "9.9"], tree: base.tree, onMissing: "skip" });
  eq(skipRun.plan.map((p) => p.action), ["update", "skip"], "skip mode updates what exists and drops the rest");
  eq(skipRun.payload.creates.length, 0, "nothing created");
  eq(skipRun.payload.placement, null, "no placement when there is nothing to place");
  eq(layout(skipRun.tree)[0][1], ["1.1", "1.2", "1.3"], "tree keeps its three verses");

  const emptySkip = importCsv({ cfg: FLAT, numbers: ["1.1", "1.2"], onMissing: "skip" });
  eq(emptySkip.plan.map((p) => p.action), ["skip", "skip"], "skip mode against an empty grantha imports nothing");
  eq(emptySkip.tree, [], "and leaves the tree empty");
}

// ── 11. Numbers that restart per chapter, uploaded one chapter at a time ─────
{
  console.log("\nOne file per chapter, verses numbered from 1 each time");
  // Chapter 1 file, then chapter 2 file, each targeting its own section explicitly.
  const first = importCsv({ cfg: FLAT, numbers: ["1", "2", "3"], placementMode: "single" });
  eq(layout(first.tree)[0][1], ["Shloka 1.1", "Shloka 1.2", "Shloka 1.3"], "chapter 1 verses");

  // The second file's bare numbers would match chapter 1's verses by trailing token, so
  // an editor uploading chapter 2 must number them 2.x — check that path works.
  const second = importCsv({ cfg: FLAT, numbers: ["2.1", "2.2"], tree: first.tree });
  eq(
    layout(second.tree),
    [
      ["Prathama Adhyaya > _default", ["Shloka 1.1", "Shloka 1.2", "Shloka 1.3"]],
      ["Dvitiya Adhyaya > _default", ["2.1", "2.2"]],
    ],
    "chapter 2 lands in its own section without disturbing chapter 1",
  );
  eq(
    contents(second.tree),
    ["m 1", "m 2", "m 3", "m 2.1", "m 2.2"],
    "chapter 1's content untouched by the second upload",
  );
}

console.log(`\n${FAIL === 0 ? "PASS" : "FAIL"} - ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
