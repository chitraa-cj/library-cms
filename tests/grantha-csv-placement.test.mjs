#!/usr/bin/env node --import tsx
/**
 * CSV import placement - pure unit test (no I/O, no React).
 * =========================================================
 * Locks in the rules that the Ganesha Gita import broke on 2026-09-17:
 *   1. a leading number token names its section, never "whatever is Nth right now"
 *   2. verses land in verse-number order, whatever order the file rows are in
 *   3. re-importing the same file is idempotent (no duplicate sections)
 *
 * Run: node --import tsx tests/grantha-csv-placement.test.mjs
 */

import {
  placeCsvCreates,
  sortManthrasByVerseNumber,
  missingLeadingSectionNumbers,
  verseNumberKey,
} from "../client/src/lib/grantha-csv-placement.ts";

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

const CFG = {
  levelOneName: "Adhyaya",
  levelTwoName: "Khanda",
  levelThreeName: "Pada",
  levelTwoEnabled: true,
  levelThreeEnabled: false,
};

let seq = 0;
const deps = {
  uid: () => `n${++seq}`,
  buildManthra: (c, order) => ({ id: `m${++seq}`, title: c.number, order }),
};
const group = (sectionLevels = 1) => ({ mode: "group", sectionLevels });
const verses = (...numbers) => numbers.map((number) => ({ number, updates: {} }));

/** Chapter title → the verse numbers it ended up holding, in stored order. */
function layout(tree) {
  return tree
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((a) => [
      a.title,
      a.khandas.flatMap((k) => k.manthras.map((m) => m.title)),
    ]);
}

// ── 1. The original failure: a CSV sorted as text ────────────────────────────
// Row order 1.x, 10.x, 11.x, 2.x, 3.x … is what a spreadsheet sort gives you.
// Position-based resolution handed chapter 2 the node chapter 10 had just made.
{
  console.log("\nCSV sorted as text (1, 10, 11, 2, 3 …)");
  const csv = [];
  for (const ch of [1, 10, 11, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const v of [1, 2]) csv.push(`${ch}.${v}`);
  }
  const tree = placeCsvCreates([], verses(...csv), group(1), CFG, deps);

  assert(tree.length === 11, `all 11 chapters created (got ${tree.length})`);
  const byTitle = Object.fromEntries(layout(tree));
  eq(byTitle["Dvitiya Adhyaya"], ["2.1", "2.2"], "chapter 2 is Dvitiya — not merged into chapter 10's");
  eq(byTitle["Dashama Adhyaya"], ["10.1", "10.2"], "chapter 10 is Dashama");
  eq(byTitle["Ekadasha Adhyaya"], ["11.1", "11.2"], "chapter 11 is Ekadasha");
  eq(
    tree.slice().sort((a, b) => a.order - b.order).map((a) => a.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "chapter order follows the CSV number, not arrival",
  );
  const mixed = tree.filter((a) =>
    new Set(a.khandas.flatMap((k) => k.manthras.map((m) => m.title.split(".")[0]))).size > 1,
  );
  eq(mixed.map((a) => a.title), [], "no chapter holds verses from two CSV chapters");
}

// ── 2. Verses ordered by number, not by row ──────────────────────────────────
{
  console.log("\nVerse order within a section");
  const tree = placeCsvCreates(
    [],
    verses("1.1", "1.10", "1.11", "1.2", "1.20", "1.3"),
    group(1),
    CFG,
    deps,
  );
  eq(
    tree[0].khandas[0].manthras.map((m) => m.title),
    ["1.1", "1.2", "1.3", "1.10", "1.11", "1.20"],
    "text-sorted rows are stored in verse-number order",
  );
  eq(
    tree[0].khandas[0].manthras.map((m) => m.order),
    [1, 2, 3, 4, 5, 6],
    "order is contiguous 1…n after sorting",
  );
}

// ── 3. Ascending CSV into an empty grantha still behaves ─────────────────────
{
  console.log("\nAscending CSV (the case that already worked)");
  const csv = [];
  for (const ch of [1, 2, 3]) for (const v of [1, 2, 3]) csv.push(`${ch}.${v}`);
  const tree = placeCsvCreates([], verses(...csv), group(1), CFG, deps);
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya", ["1.1", "1.2", "1.3"]],
      ["Dvitiya Adhyaya", ["2.1", "2.2", "2.3"]],
      ["Tritiya Adhyaya", ["3.1", "3.2", "3.3"]],
    ],
    "three chapters, each with its own verses",
  );
}

// ── 4. Importing into a grantha that already has chapters ────────────────────
{
  console.log("\nImport into an existing tree");
  const existing = [
    {
      id: "a1",
      title: "Prathama Adhyaya",
      order: 1,
      expanded: true,
      khandas: [
        {
          id: "k1",
          title: "_default",
          order: 1,
          expanded: true,
          padas: [],
          manthras: [{ id: "old1", title: "1.1", order: 1 }],
        },
      ],
    },
  ];
  const tree = placeCsvCreates(existing, verses("1.2", "3.1", "2.1"), group(1), CFG, deps);
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya", ["1.1", "1.2"]],
      ["Dvitiya Adhyaya", ["2.1"]],
      ["Tritiya Adhyaya", ["3.1"]],
    ],
    "1.2 joins the existing chapter 1; 2.x and 3.x get their own",
  );
  eq(existing[0].khandas[0].manthras.map((m) => m.title), ["1.1"], "the input tree is not mutated");
}

// ── 5. A gap in the file leaves a gap, not a mislabelled chapter ─────────────
{
  console.log("\nCSV with a missing chapter");
  const tree = placeCsvCreates([], verses("1.1", "2.1", "5.1"), group(1), CFG, deps);
  eq(
    layout(tree),
    [
      ["Prathama Adhyaya", ["1.1"]],
      ["Dvitiya Adhyaya", ["2.1"]],
      ["Panchama Adhyaya", ["5.1"]],
    ],
    "chapter 5 is named Panchama even though it is only the third section",
  );
  eq(missingLeadingSectionNumbers(["1.1", "2.1", "5.1"]), [3, 4], "the dialog can warn about 3 and 4");
  eq(missingLeadingSectionNumbers(["1.1", "1.2", "2.1"]), [], "no gap → no warning");
}

// ── 6. Re-running the same import doesn't fork the tree ──────────────────────
{
  console.log("\nIdempotence");
  const once = placeCsvCreates([], verses("2.1", "1.1"), group(1), CFG, deps);
  const twice = placeCsvCreates(once, verses("3.1"), group(1), CFG, deps);
  eq(twice.length, 3, "second import adds one chapter, not a duplicate set");
  eq(
    layout(twice),
    [
      ["Prathama Adhyaya", ["1.1"]],
      ["Dvitiya Adhyaya", ["2.1"]],
      ["Tritiya Adhyaya", ["3.1"]],
    ],
    "tree is still one chapter per number",
  );
}

// ── 7. Two- and three-level paths ────────────────────────────────────────────
{
  console.log("\nDeeper section paths");
  const tree = placeCsvCreates([], verses("2.3.1", "1.2.1", "1.1.1"), group(2), CFG, deps);
  eq(
    tree
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((a) => [a.title, a.khandas.slice().sort((x, y) => x.order - y.order).map((k) => [k.title, k.manthras.map((m) => m.title)])]),
    [
      ["Prathama Adhyaya", [["Prathama Khanda", ["1.1.1"]], ["Dvitiya Khanda", ["1.2.1"]]]],
      ["Dvitiya Adhyaya", [["Tritiya Khanda", ["2.3.1"]]]],
    ],
    "khanda 3 keeps its number inside chapter 2",
  );

  const l3 = placeCsvCreates(
    [],
    verses("1.1.2.1", "1.1.1.1"),
    group(3),
    { ...CFG, levelThreeEnabled: true },
    deps,
  );
  eq(
    l3[0].khandas[0].padas.slice().sort((a, b) => a.order - b.order).map((p) => [p.title, p.manthras.map((m) => m.title)]),
    [["Prathama Pada", ["1.1.1.1"]], ["Dvitiya Pada", ["1.1.2.1"]]],
    "level-three padas resolve by number too",
  );
}

// ── 8. "All in one section" placement is unchanged ───────────────────────────
{
  console.log("\nSingle-section placement");
  const existing = [
    {
      id: "a1",
      title: "Prathama Adhyaya",
      order: 1,
      expanded: true,
      khandas: [{ id: "k1", title: "_default", order: 1, expanded: true, padas: [], manthras: [] }],
    },
  ];
  const tree = placeCsvCreates(
    existing,
    verses("7", "5", "6"),
    { mode: "single", target: { adhyayaId: "a1", khandaId: "k1" } },
    CFG,
    deps,
  );
  eq(tree.length, 1, "no new chapter invented");
  eq(tree[0].khandas[0].manthras.map((m) => m.title), ["5", "6", "7"], "all rows in the chosen section, in number order");
}

// ── 9. Ambiguous labels keep file order rather than guessing ─────────────────
{
  console.log("\nAmbiguous verse labels");
  assert(
    sortManthrasByVerseNumber([{ id: "a", title: "Mangala Shloka", order: 1 }]) === null,
    "a label with no number → no reordering",
  );
  assert(
    sortManthrasByVerseNumber([
      { id: "a", title: "1.1", order: 1 },
      { id: "b", title: "Shloka 1.1", order: 2 },
    ]) === null,
    "two labels with the same number → no reordering",
  );
  eq(verseNumberKey("Shloka 1.42"), [1, 42], "verse key ignores the leaf word");
  eq(verseNumberKey("नमः"), null, "no digits → no key");

  // One section holding a label with no number: that section keeps file order, because
  // there is no number to sort "Mangala" against.
  const one = placeCsvCreates(
    [],
    verses("2", "Mangala", "1"),
    { mode: "single", target: { adhyayaId: null, khandaId: null } },
    CFG,
    deps,
  );
  eq(
    one[0].khandas[0].manthras.map((m) => m.title),
    ["2", "Mangala", "1"],
    "one unnumbered row → that section keeps file order",
  );

  // In group mode a non-numeric leading token names no section, so the row gets one of
  // its own rather than being silently folded into someone else's chapter.
  const grouped = placeCsvCreates([], verses("1.2", "Mangala", "1.1"), group(1), CFG, deps);
  eq(
    layout(grouped),
    [
      ["Prathama Adhyaya", ["1.1", "1.2"]],
      ["Dvitiya Adhyaya", ["Mangala"]],
    ],
    "the numbered rows stay together; the unnumbered one is parked in its own section",
  );
}

console.log(`\n${FAIL === 0 ? "PASS" : "FAIL"} — ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
