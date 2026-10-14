#!/usr/bin/env node --import tsx
/**
 * OCR → Grantha: the generated CSV, driven back through the REAL importer.
 * ========================================================================
 * The point of this file is compatibility, not plausibility. Every case takes an
 * assembled structure, writes the CSV with `buildStructureCsv`, and then pushes those
 * exact bytes through the code path the editors use —
 *
 *   parseCsv → guessNumberColumn → planCsvRows → buildImportPayload → placeCsvCreates
 *            → prepareHierarchyForSave
 *
 * — and asserts the tree the grantha editor ends up holding, plus the verse labels the
 * publish step would send to Strapi. If the importer contract ever changes, this fails
 * here rather than in a half-imported grantha.
 *
 * Run: node --import tsx tests/ocr-structure-csv.test.mjs
 */

import {
  assembleStructure,
  buildStructureCsv,
  csvCell,
  parseStructureChunkAnswer,
  validateStructure,
} from "../shared/ocr-structure.ts";
import {
  buildCoreTargets,
  buildImportPayload,
  buildTokenCounts,
  flattenTree,
  guessNumberColumn,
  parseCsv,
  planCsvRows,
} from "../client/src/lib/grantha-csv-import.ts";
import { placeCsvCreates } from "../client/src/lib/grantha-csv-placement.ts";
import { prepareHierarchyForSave } from "../client/src/lib/grantha-structure-sync.ts";
import { blocksToText } from "../client/src/lib/strapi-blocks.ts";

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

let uidSeq = 0;
const uid = () => `id-${uidSeq++}`;

function structureFrom(rawItems, config) {
  const { items } = parseStructureChunkAnswer(
    JSON.stringify({ items: rawItems, warnings: [] }),
    { chunkIndex: 0, startPage: 1, endPage: 50 },
  );
  return assembleStructure(items, config);
}

/**
 * The editor's own import path, start to finish, on a generated CSV. `teekas` are the
 * destination grantha's teeka definitions, as the dialog holds them.
 */
function runImporter(csvText, { structureConfig, teekas = [], tree = [], sectionLevels }) {
  const parsed = parseCsv(csvText);
  const headers = parsed[0].map((h) => h.trim());
  const rows = parsed.slice(1);
  const numberColumn = guessNumberColumn(headers);

  const coreTargets = buildCoreTargets(teekas);
  // Map by header, the way the dialog's proposed mapping does.
  const coreMapping = {};
  const translationRows = [];
  headers.forEach((header, index) => {
    const lower = header.toLowerCase();
    const scope = /^bhashyam/i.test(header)
      ? "bhashyam"
      : teekas.find((t) => header.startsWith(t.TeekaName))?.id ?? "shloka";
    if (/\(sanskrit\)$/i.test(lower)) coreMapping[`${scope}.SanskritTextEntry`] = index;
    else if (/\(iast\)$/i.test(lower)) coreMapping[`${scope}.IASTTransliteration`] = index;
    else if (/\(english\)$/i.test(lower)) coreMapping[`${scope}.EnglishTranslationText`] = index;
    else if (index !== numberColumn) {
      const language = /\(([^)]+)\)$/.exec(header)?.[1];
      if (language) translationRows.push({ id: `tr-${index}`, scope, language, column: index });
    }
  });

  const flat = flattenTree(tree);
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
  const payload = buildImportPayload({
    plan,
    rows,
    mapping: { coreTargets, coreMapping, translationRows, teekas },
    placement: { mode: "group", sectionLevels },
  });
  const placed = placeCsvCreates(
    tree,
    payload.creates,
    payload.placement ?? { mode: "group", sectionLevels },
    {
      levelOneName: structureConfig.levelOneName,
      levelTwoName: structureConfig.levelTwoName,
      levelThreeName: structureConfig.levelThreeName,
      levelTwoEnabled: structureConfig.levelTwoEnabled !== false,
      levelThreeEnabled: !!structureConfig.levelThreeEnabled,
    },
    {
      uid,
      buildManthra: (create, order) => ({
        id: uid(),
        title: create.number,
        order,
        _isNewLocal: true,
        ShlokaManthraEntry: create.updates.ShlokaManthraEntry,
        BhashyamForShlokaManthra: create.updates.BhashyamForShlokaManthra,
        Teekas: create.updates.Teekas,
      }),
    },
  );
  const prepared = prepareHierarchyForSave(placed, structureConfig);
  return { headers, rows, plan, payload, placed, prepared: prepared.hierarchy ?? prepared };
}

// ── 1. CSV mechanics ────────────────────────────────────────────────────────
console.log("\nCSV mechanics");
{
  eq(csvCell("plain"), "plain", "a plain cell is unquoted");
  eq(csvCell("a,b"), '"a,b"', "a comma forces quoting");
  eq(csvCell('say "x"'), '"say ""x"""', "a quote is doubled inside quotes");
  eq(csvCell("line1\nline2"), '"line1\nline2"', "an embedded newline is quoted, not stripped");
  eq(csvCell(""), "", "an empty cell stays empty");

  // Round-trip through the importer's own parser — the only parser that matters.
  const nasty = 'He said "yes", then\nleft; 1,2,3';
  const text = `Number,Mantra (Sanskrit)\n1,${csvCell(nasty)}\n`;
  eq(parseCsv(text)[1][1], nasty, "quoting survives the importer's parser verbatim");
}

// ── 2. depth 2: one section level ───────────────────────────────────────────
console.log("\ndepth 2 — chapters and verses");
{
  const structure = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "First", page: 1, confidence: 1 },
      { kind: "verse", number: "1", text: "क ख ग", page: 1, confidence: 1, script: "devanagari" },
      { kind: "verse", number: "2", text: "घ ङ च", page: 1, confidence: 1, script: "devanagari" },
      { kind: "section", level: 1, number: "2", title: "Second", page: 2, confidence: 1 },
      { kind: "verse", number: "1", text: "छ ज झ", page: 2, confidence: 1, script: "devanagari" },
    ],
    { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
  );
  const csv = buildStructureCsv(structure);
  eq(csv.rowCount, 3, "one row per entry");
  eq(csv.sectionLevels, 1, "one section level is encoded in the number column");
  eq(csv.columns.map((c) => c.header), ["Number", "Mantra (Sanskrit)"],
    "only columns with content are emitted");
  eq(parseCsv(csv.csv)[1][0], "1.1", "the number column carries the section path");

  const run = runImporter(csv.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Adhyaya",
      levelTwoEnabled: false,
      levelTwoName: "Khanda",
      levelThreeEnabled: false,
      levelThreeName: "Pada",
      leafName: "Mantra",
    },
    sectionLevels: csv.sectionLevels,
  });
  eq(run.payload.creates.length, 3, "every row becomes a new verse");
  eq(run.prepared.length, 2, "two chapters are created");
  eq(
    run.prepared.map((a) => (a.khandas ?? []).flatMap((k) => k.manthras ?? []).map((m) => m.title)),
    [["1.1", "1.2"], ["2.1"]],
    "verses land in the chapter their number names",
  );
  eq(
    blocksToText(run.prepared[0].khandas[0].manthras[0].ShlokaManthraEntry.SanskritTextEntry),
    "क ख ग",
    "Devanagari text arrives intact in the Sanskrit field",
  );
}

// ── 3. depth 3 and 4 ────────────────────────────────────────────────────────
console.log("\ndepth 3 and 4 — nested sections");
{
  const structure3 = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "A1", page: 1, confidence: 1 },
      { kind: "section", level: 2, number: "1", title: "K1", page: 1, confidence: 1 },
      { kind: "verse", number: "1", text: "a", page: 1, confidence: 1 },
      { kind: "section", level: 2, number: "2", title: "K2", page: 2, confidence: 1 },
      { kind: "verse", number: "1", text: "b", page: 2, confidence: 1 },
      { kind: "section", level: 1, number: "2", title: "A2", page: 3, confidence: 1 },
      { kind: "section", level: 2, number: "1", title: "K1", page: 3, confidence: 1 },
      { kind: "verse", number: "1", text: "c", page: 3, confidence: 1 },
    ],
    { depth: 3, levelNames: ["Adhyaya", "Khanda", "Mantra"] },
  );
  const csv3 = buildStructureCsv(structure3);
  eq(parseCsv(csv3.csv).slice(1).map((r) => r[0]), ["1.1.1", "1.2.1", "2.1.1"],
    "two section levels and the verse number");

  const run3 = runImporter(csv3.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Adhyaya",
      levelTwoEnabled: true,
      levelTwoName: "Khanda",
      levelThreeEnabled: false,
      levelThreeName: "Pada",
      leafName: "Mantra",
    },
    sectionLevels: csv3.sectionLevels,
  });
  eq(
    run3.prepared.map((a) => ({
      chapter: a.khandas.length,
      verses: a.khandas.map((k) => k.manthras.map((m) => m.title)),
    })),
    [
      { chapter: 2, verses: [["1.1.1"], ["1.2.1"]] },
      { chapter: 1, verses: [["2.1.1"]] },
    ],
    "the tree has two chapters, with two and one sections",
  );

  const structure4 = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "Kanda 1", page: 1, confidence: 1 },
      { kind: "section", level: 2, number: "2", title: "Sarga 2", page: 1, confidence: 1 },
      { kind: "section", level: 3, number: "3", title: "Adhyaya 3", page: 1, confidence: 1 },
      { kind: "verse", number: "4", text: "a", page: 1, confidence: 1 },
      { kind: "verse", number: "5", text: "b", page: 1, confidence: 1 },
    ],
    { depth: 4, levelNames: ["Kanda", "Sarga", "Adhyaya", "Shloka"] },
  );
  const csv4 = buildStructureCsv(structure4);
  eq(parseCsv(csv4.csv).slice(1).map((r) => r[0]), ["1.2.3.4", "1.2.3.5"],
    "three section levels and the verse number");

  const run4 = runImporter(csv4.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Kanda",
      levelTwoEnabled: true,
      levelTwoName: "Sarga",
      levelThreeEnabled: true,
      levelThreeName: "Adhyaya",
      leafName: "Shloka",
    },
    sectionLevels: csv4.sectionLevels,
  });
  const pada = run4.prepared[0].khandas[0].padas[0];
  eq(pada.manthras.map((m) => m.title), ["1.2.3.4", "1.2.3.5"],
    "verses land three levels deep");
  // Placement puts each level in the numbered slot the document printed...
  const placedPada = run4.placed[0].khandas[0].padas[0];
  eq([run4.placed[0].order, run4.placed[0].khandas[0].order, placedPada.order], [1, 2, 3],
    "placement puts each level in the slot its printed number names");
  // ...and the portal's own save-prep then normalises section order to 1…n by position,
  // which is why a document that starts at "Sarga 2" is reported as a section gap before
  // export (see the section-gap warning in validateStructure).
  eq([run4.prepared[0].order, run4.prepared[0].khandas[0].order, pada.order], [1, 1, 1],
    "the portal renumbers sections positionally on save, as it does for any import");
}

// ── 4. bhashyam, teekas, translations ───────────────────────────────────────
console.log("\nassociated content through the importer");
{
  const structure = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "A", page: 1, confidence: 1 },
      { kind: "verse", number: "1", text: "मन्त्रः", page: 1, confidence: 1, script: "devanagari" },
      { kind: "verse", number: "1", text: "mantraḥ", page: 1, confidence: 1, script: "iast" },
      { kind: "bhashyam", text: "भाष्यम्", page: 1, confidence: 1, script: "devanagari", attachTo: "previous_verse" },
      { kind: "bhashyam", text: "The commentary, in English", page: 1, confidence: 1, script: "english", attachTo: "previous_verse" },
      { kind: "teeka", teekaName: "Anandagiri", text: "टीका", page: 1, confidence: 1, script: "devanagari", attachTo: "previous_verse" },
      { kind: "translation", language: "Hindi", text: "हिन्दी", page: 1, confidence: 1, attachTo: "previous_verse" },
      { kind: "verse", number: "2", text: "दूसरा", page: 1, confidence: 1, script: "devanagari" },
    ],
    { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
  );
  const csv = buildStructureCsv(structure);
  eq(
    csv.columns.map((c) => c.header),
    [
      "Number",
      "Mantra (Sanskrit)",
      "Mantra (IAST)",
      "Bhashyam (Sanskrit)",
      "Bhashyam (English)",
      "Anandagiri (Sanskrit)",
      "Mantra (Hindi)",
    ],
    "one column per scope × field that has content",
  );

  const teekas = [{ id: "fx8k2md91cq7vtr4hb0zs6ya", TeekaName: "Anandagiri", TeekaAuthor: "Anandajnana" }];
  const run = runImporter(csv.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Adhyaya",
      levelTwoEnabled: false,
      levelTwoName: "Khanda",
      levelThreeEnabled: false,
      levelThreeName: "Pada",
      leafName: "Mantra",
    },
    teekas,
    sectionLevels: csv.sectionLevels,
  });

  const verse = run.prepared[0].khandas[0].manthras[0];
  eq(blocksToText(verse.ShlokaManthraEntry.SanskritTextEntry), "मन्त्रः", "the entry's Sanskrit");
  eq(blocksToText(verse.ShlokaManthraEntry.IASTTransliteration), "mantraḥ",
    "the same entry's IAST, on the same verse");
  eq(blocksToText(verse.BhashyamForShlokaManthra.SanskritTextEntry), "भाष्यम्",
    "the bhashyam is on the verse it followed");
  eq(blocksToText(verse.BhashyamForShlokaManthra.EnglishTranslationText), "The commentary, in English",
    "the bhashyam's English too");
  eq(verse.Teekas.map((t) => t.TeekaName), ["Anandagiri"], "the teeka is linked by name");
  eq(blocksToText(verse.Teekas[0].TeekaEntry.SanskritTextEntry), "टीका", "the teeka's text");
  eq(verse.Teekas[0].teekaDocId, "fx8k2md91cq7vtr4hb0zs6ya",
    "and it carries the destination teeka documentId");
  eq(
    verse.ShlokaManthraEntry.OtherTranslations.map((o) => [
      o.LanguageOfTranslation,
      blocksToText(o.TranslationText),
    ]),
    [["Hindi", "हिन्दी"]],
    "a Hindi translation becomes an OtherTranslations row",
  );
  const second = run.prepared[0].khandas[0].manthras[1];
  check("the second verse has no commentary", !second.BhashyamForShlokaManthra?.SanskritTextEntry);
}

// ── 5. updating verses that already exist ───────────────────────────────────
console.log("\nimporting onto an existing grantha");
{
  const structure = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "A", page: 1, confidence: 1 },
      { kind: "verse", number: "1", text: "new text for 1.1", page: 1, confidence: 1, script: "english" },
      { kind: "verse", number: "2", text: "brand new 1.2", page: 1, confidence: 1, script: "english" },
    ],
    { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
  );
  const csv = buildStructureCsv(structure);

  // An existing grantha that already has verse 1.1.
  const tree = [
    {
      id: "a1",
      title: "Prathama Adhyaya",
      order: 1,
      khandas: [
        {
          id: "k1",
          title: "_default",
          order: 1,
          padas: [],
          manthras: [{ id: "m1", title: "1.1", order: 1 }],
        },
      ],
    },
  ];
  const run = runImporter(csv.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Adhyaya",
      levelTwoEnabled: false,
      levelTwoName: "Khanda",
      levelThreeEnabled: false,
      levelThreeName: "Pada",
      leafName: "Mantra",
    },
    tree,
    sectionLevels: csv.sectionLevels,
  });
  eq(run.payload.updates.length, 1, "the row matching an existing verse is an update");
  eq(run.payload.creates.length, 1, "the row with no match is a create");
  eq(run.payload.updates[0].manthraId, "m1", "the update targets the existing verse");
  eq(
    blocksToText(run.payload.updates[0].updates.ShlokaManthraEntry.EnglishTranslationText),
    "new text for 1.1",
    "the update carries the generated text",
  );
}

// ── 6. refusing to export a broken structure ────────────────────────────────
console.log("\nvalidation gates the export");
{
  const duplicate = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "A", page: 1, confidence: 1 },
      { kind: "verse", number: "1", text: "first", page: 1, confidence: 1, script: "english" },
      { kind: "verse", number: "1", text: "second, same number and script", page: 2, confidence: 1, script: "english" },
    ],
    { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
  );
  const validation = validateStructure(duplicate);
  check("a duplicate number blocks the export", !validation.ok);
  check("and the message is actionable",
    /Renumber them in the review/.test(validation.errors.find((e) => e.code === "duplicate-number").message));

  // What the importer would have done with it, if it had got through: the portal
  // renumbers the odd one out onto its neighbour's number. That is the damage the gate
  // is there to prevent.
  const csv = buildStructureCsv(duplicate);
  eq(parseCsv(csv.csv).slice(1).map((r) => r[0]), ["1.1", "1.1"],
    "the CSV would carry the same number twice, which is why export is blocked");
}

// ── 7. unicode end to end ───────────────────────────────────────────────────
console.log("\nunicode and scripts, end to end");
{
  const samples = [
    "ॐ भूर्भुवः स्वः तत्सवितुर्वरेण्यम्",
    "oṃ bhūrbhuvaḥ svaḥ tatsavitur vareṇyam",
    "ಕನ್ನಡ ಪಠ್ಯ",
    "தமிழ் உரை",
    "«Ελληνικά», “quoted”, 1,2",
  ];
  const structure = structureFrom(
    [
      { kind: "section", level: 1, number: "1", title: "A", page: 1, confidence: 1 },
      ...samples.map((text, i) => ({
        kind: "verse",
        number: String(i + 1),
        text,
        page: 1,
        confidence: 1,
        script: "other",
      })),
    ],
    { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
  );
  const csv = buildStructureCsv(structure);
  const run = runImporter(csv.csv, {
    structureConfig: {
      levelOneEnabled: true,
      levelOneName: "Adhyaya",
      levelTwoEnabled: false,
      levelTwoName: "Khanda",
      levelThreeEnabled: false,
      levelThreeName: "Pada",
      leafName: "Mantra",
    },
    sectionLevels: csv.sectionLevels,
  });
  const got = run.prepared[0].khandas[0].manthras.map((m) =>
    blocksToText(m.ShlokaManthraEntry.SanskritTextEntry),
  );
  eq(got, samples, "every script and every special character survives the round trip");
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const failure of FAILURES) console.error(` - ${failure}`);
  process.exit(1);
}
