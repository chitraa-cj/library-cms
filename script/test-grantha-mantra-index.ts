/**
 * Regression tests for mantra list reindexing (insert/delete numbering).
 * Run from repo root: npx tsx script/test-grantha-mantra-index.ts
 */
import assert from "node:assert/strict";
import {
  reindexMantrasContiguous,
  reindexMantrasInListOrder,
  titlePrefixFromMantraTitle,
  mantraNumberSuffix,
  mantrasShareNumberSuffix,
  mantrasShareLeafAndSuffix,
  findStrapiMantraByLeafAndSuffix,
  pickPreferredStrapiMantraRef,
  pickBestStrapiMantraRefForLink,
  resolvePortalMantraToStrapiDoc,
  buildUniqueStrapiOrderMap,
  buildMantraDisplayTitle,
  type StrapiMantraRef,
  ordinalIndexInSortedOrder,
  normalizeEditorHierarchy,
  syncPortalSectionTitle,
  editorOrdinalLabel,
  reindexMantraOrdersPreservingTitles,
  prepareHierarchyForSave,
  buildMantraTitleCtx,
  mantraLabelForCmsSync,
  assignContiguousMantraOrders,
  sortNodesByOrder,
  portalMantraTitleForLeaf,
  inferLeafNameFromStrapiMantras,
  countLeafMantrasInKhanda,
  countLeafMantrasInAdhyaya,
  countMantrasOnLeafSections,
  countLeafMantrasInSectionTree,
  enforceMantraPlacementByStructure,
  dedupePublishedMantrasForDisplay,
  strapiMantrasForResolvedSection,
  linkFlatGranthaAdhyayasToSoleStrapiSection,
  type MantraTitleCtx,
} from "../client/src/lib/grantha-structure-sync.ts";
import {
  isPlaceholderVersusCms,
  entryContentCharCount,
} from "../client/src/lib/strapi-blocks.ts";
import { sortKeyBetween, STRAPI_SORT_GAP } from "../shared/mantra-sort-key.ts";

type ManthraRow = { id: string; title: string; order: number; strapiDocumentId?: string };

/** Mirrors server `insert-between` — fractional sort key, no sibling shifts. */
function simulateStrapiInsertBetween(
  rows: ManthraRow[],
  afterDocumentId: string,
  newId: string,
): ManthraRow[] {
  const all = [...rows].sort((a, b) => a.order - b.order);
  const anchorIdx = all.findIndex((m) => m.strapiDocumentId === afterDocumentId);
  if (anchorIdx < 0) throw new Error(`anchor ${afterDocumentId} not found`);
  const prevSort = all[anchorIdx].order;
  const nextSort = all[anchorIdx + 1]?.order;
  const { sortKey: newSort } = sortKeyBetween(prevSort, nextSort);
  all.splice(anchorIdx + 1, 0, {
    id: newId,
    title: "",
    order: newSort,
    strapiDocumentId: newId,
  });
  return all;
}

function portalRowsToStrapiSortKeys(rows: ManthraRow[]): ManthraRow[] {
  return rows.map((m) => ({ ...m, order: m.order * STRAPI_SORT_GAP }));
}

function simulateEditorInsertAfter(
  manthras: ManthraRow[],
  afterLocalId: string,
  newId: string,
): ManthraRow[] {
  const sorted = sortNodesByOrder(manthras);
  const j = sorted.findIndex((m) => m.id === afterLocalId);
  if (j < 0) throw new Error(`after ${afterLocalId} not found`);
  const newRow: ManthraRow = { id: newId, title: "", order: 0 };
  return assignContiguousMantraOrders([
    ...sorted.slice(0, j + 1),
    newRow,
    ...sorted.slice(j + 1),
  ]);
}

function simulateEditorDelete(
  manthras: ManthraRow[],
  removeId: string,
  renumberTitles: boolean,
  ctx: MantraTitleCtx,
): ManthraRow[] {
  const filtered = manthras.filter((m) => m.id !== removeId);
  if (renumberTitles) {
    return reindexMantrasInListOrder(sortNodesByOrder(filtered), ctx);
  }
  return reindexMantraOrdersPreservingTitles(filtered);
}

function assertUniqueContiguousOrders(rows: ManthraRow[], label: string) {
  const orders = rows.map((r) => r.order).sort((a, b) => a - b);
  assert.equal(orders.length, rows.length, `${label}: length`);
  for (let i = 0; i < orders.length; i++) {
    assert.equal(orders[i], i + 1, `${label}: order ${i + 1}`);
  }
}

function batchUpdatesFromSnapshot(rows: ManthraRow[]) {
  return sortNodesByOrder(rows)
    .filter((m) => m.strapiDocumentId && m.strapiDocumentId.length >= 10)
    .map((m) => ({
      documentId: m.strapiDocumentId!,
      order: m.order,
      ShlokaManthraNumber: m.title,
    }));
}

const siblings = [
  { id: "second", order: 2 },
  { id: "first", order: 1 },
];
assert.equal(ordinalIndexInSortedOrder(siblings, "first"), 1);
assert.equal(ordinalIndexInSortedOrder(siblings, "second"), 2);

assert.equal(titlePrefixFromMantraTitle("Shloka 1.1.23", "Shloka"), "Shloka");
assert.equal(titlePrefixFromMantraTitle("", "Mantra"), "Mantra");
assert.equal(titlePrefixFromMantraTitle("Mantra 1.1.1", "Shloka"), "Shloka");
assert.equal(titlePrefixFromMantraTitle("Manthra 1.2", "Shloka"), "Shloka");

assert.equal(mantraNumberSuffix("Mantra 1.1.5"), "1.1.5");
assert.equal(mantrasShareNumberSuffix("Shloka 1.1.5", "Mantra 1.1.5"), true);
assert.equal(mantrasShareLeafAndSuffix("Shloka 1.1.5", "Mantra 1.1.5", "Shloka"), false);
assert.equal(mantrasShareLeafAndSuffix("Shloka 1.1.5", "Shloka 1.1.5", "Shloka"), true);

const orderMapRefs: StrapiMantraRef[] = [
  { title: "A", docId: "doc-a1111111111111", order: 1 },
  { title: "B", docId: "doc-b2222222222222", order: 2 },
];
assert.equal(buildUniqueStrapiOrderMap(orderMapRefs).byOrder.get(1)?.docId, "doc-a1111111111111");

const sectionRefs = [
  { title: "Shloka 1.1.5", docId: "doc-aaaa1111111111", order: 5 },
  { title: "Shloka 1.1.6", docId: "doc-bbbb2222222222", order: 6 },
  { title: "Mantra 1.1.4", docId: "doc-cccc3333333333", order: 4 },
  { title: "Mantra 1.1.4", docId: "doc-dddd4444444444", order: 4 },
];
const { byOrder, ambiguousOrders } = buildUniqueStrapiOrderMap(sectionRefs);
assert(ambiguousOrders.has(4));
assert.equal(byOrder.get(5)?.docId, "doc-aaaa1111111111");

const remap = resolvePortalMantraToStrapiDoc(
  { title: "Shloka 1.1.5", order: 5, strapiDocumentId: "doc-bbbb2222222222" },
  {
    configuredLeaf: "Shloka",
    sectionMantras: sectionRefs,
    byOrder,
    ambiguousOrders,
  },
);
assert.equal(remap?.docId, "doc-aaaa1111111111");

// After renumber: trust portal strapiDocumentId even when Strapi label suffix differs.
const renumberSection: StrapiMantraRef[] = [
  { title: "Shloka 1.3", docId: "doc-3333333333333333", order: 300000 },
  { title: "Shloka 1.4", docId: "doc-4444444444444444", order: 400000 },
];
const { byOrder: renumberByOrder, ambiguousOrders: renumberAmbiguous } =
  buildUniqueStrapiOrderMap(renumberSection);
const renumberLink = resolvePortalMantraToStrapiDoc(
  { title: "Shloka 1.2", strapiDocumentId: "doc-4444444444444444", order: 400000 },
  {
    configuredLeaf: "Shloka",
    sectionMantras: renumberSection,
    byOrder: renumberByOrder,
    ambiguousOrders: renumberAmbiguous,
  },
);
assert.equal(
  renumberLink?.docId,
  "doc-4444444444444444",
  "must trust documentId after renumber, not remap by stale Strapi order",
);

// Order-only fallback removed: no title suffix match and no stored docId → no link.
const noOrderFallback = resolvePortalMantraToStrapiDoc(
  { title: "Shloka 1.2", order: 400000 },
  {
    configuredLeaf: "Shloka",
    sectionMantras: renumberSection,
    byOrder: renumberByOrder,
    ambiguousOrders: renumberAmbiguous,
  },
);
assert.equal(
  noOrderFallback?.docId,
  undefined,
  "must not match by Strapi sort order when suffix is missing in CMS",
);

// Same verse label in two sections must not cross-link (no grantha-wide title map).
const sectionARefs: StrapiMantraRef[] = [
  { title: "Mantra 1.1.1", docId: "doc-aaaa1111111111", order: 1, contentScore: 50 },
];
const sectionBRefs: StrapiMantraRef[] = [
  { title: "Mantra 1.1.1", docId: "doc-bbbb2222222222", order: 1, contentScore: 100 },
];
const inA = resolvePortalMantraToStrapiDoc(
  { title: "Mantra 1.1.1", order: 1 },
  {
    configuredLeaf: "Mantra",
    sectionMantras: sectionARefs,
    byOrder: buildUniqueStrapiOrderMap(sectionARefs).byOrder,
    ambiguousOrders: buildUniqueStrapiOrderMap(sectionARefs).ambiguousOrders,
  },
);
assert.equal(inA?.docId, "doc-aaaa1111111111");
assert.equal(
  findStrapiMantraByLeafAndSuffix(sectionRefs, "Shloka 1.1.5", "Shloka")?.docId,
  "doc-aaaa1111111111",
);
assert.equal(findStrapiMantraByLeafAndSuffix(sectionRefs, "Shloka 1.1.5", "Mantra")?.docId, undefined);

const dupRefs = [
  { title: "Shloka 1.1.119", docId: "doc-empty119xxxxxx", order: 119 },
  { title: "Shloka 1.1.119", docId: "doc-full119xxxxxxxx", order: 119 },
];
assert.equal(
  pickPreferredStrapiMantraRef(dupRefs, "doc-full119xxxxxxxx")?.docId,
  "doc-full119xxxxxxxx",
);
assert.equal(
  pickPreferredStrapiMantraRef(dupRefs)?.docId,
  "doc-empty119xxxxxx",
);
assert.equal(
  findStrapiMantraByLeafAndSuffix(dupRefs, "Shloka 1.1.119", "Shloka", "doc-full119xxxxxxxx")?.docId,
  "doc-full119xxxxxxxx",
);

const flat: MantraTitleCtx = {
  leaf: "Shloka",
  aIdx: 1,
  kIdx: 1,
  isDefaultKhanda: true,
  padaPath: false,
  levelTwoEnabled: false,
};

const mantraLabeled = [
  { id: "m1", title: "Mantra 1.1", order: 1 },
  { id: "m2", title: "Mantra 1.2", order: 2 },
];
const afterMantraStyleInsert = reindexMantrasInListOrder(
  assignContiguousMantraOrders([
    mantraLabeled[0],
    { id: "new", title: "", order: 0 },
    mantraLabeled[1],
  ]),
  flat,
);
assert.equal(afterMantraStyleInsert.find((m) => m.id === "new")?.title, "Shloka 1.2");
assert.equal(afterMantraStyleInsert.find((m) => m.id === "m1")?.title, "Shloka 1.1");
assert.equal(afterMantraStyleInsert.find((m) => m.id === "m2")?.title, "Shloka 1.3");

const drifted = [
  { id: "a", title: "Shloka 1.23", order: 23, note: "first row" },
  { id: "b", title: "Shloka 1.24", order: 25, note: "third in sort" },
  { id: "c", title: "Shloka 1.25", order: 24, note: "second in sort" },
];

const fixed = reindexMantrasContiguous(drifted, flat);
assert.deepEqual(
  fixed.map((m) => ({ id: m.id, order: m.order, title: m.title })),
  [
    { id: "a", order: 1, title: "Shloka 1.1" },
    { id: "c", order: 2, title: "Shloka 1.2" },
    { id: "b", order: 3, title: "Shloka 1.3" },
  ],
);

const sortedDrifted = [...drifted].sort((x, y) => x.order - y.order);
const insertAfterFirst = [
  ...sortedDrifted.slice(0, 1),
  { id: "new", title: "", order: 0, note: "blank" },
  ...sortedDrifted.slice(1),
];
const afterInsert = reindexMantrasInListOrder(insertAfterFirst, flat);
assert.equal(afterInsert.find((x) => x.id === "new")?.order, 2);
assert.equal(afterInsert.find((x) => x.id === "new")?.title, "Shloka 1.2");
assert.equal(afterInsert.find((x) => x.id === "c")?.title, "Shloka 1.3");
assert.equal(afterInsert.find((x) => x.id === "b")?.title, "Shloka 1.4");

const padaCtx: MantraTitleCtx = {
  leaf: "S",
  aIdx: 1,
  kIdx: 99,
  pIdx: 2,
  isDefaultKhanda: true,
  padaPath: true,
  levelTwoEnabled: true,
};
const pList = [{ id: "m1", title: "S 1.2.1", order: 1, x: 1 }];
assert.equal(reindexMantrasContiguous(pList, padaCtx)[0].title, "S 1.2.1");

const l2: MantraTitleCtx = {
  leaf: "M",
  aIdx: 2,
  kIdx: 3,
  isDefaultKhanda: false,
  padaPath: false,
  levelTwoEnabled: true,
};
assert.equal(buildMantraDisplayTitle("M", 7, l2), "M 2.3.7");

assert.equal(syncPortalSectionTitle("Dvitiya Adhyaya", "Adhyaya", 1), "Prathama Adhyaya");
assert.equal(syncPortalSectionTitle("Arjuna Vishada", "Adhyaya", 1), "Arjuna Vishada");
assert.equal(syncPortalSectionTitle("3 Khanda", "Khanda", 2), "Dvitiya Khanda");
assert.equal(editorOrdinalLabel(11), "11");

const preserve = reindexMantraOrdersPreservingTitles([
  { id: "a", title: "Shloka 1.1.99", order: 5 },
  { id: "b", title: "Shloka 1.1.100", order: 2 },
]);
assert.deepEqual(
  preserve.map((m) => ({ id: m.id, order: m.order, title: m.title })),
  [
    { id: "b", order: 1, title: "Shloka 1.1.100" },
    { id: "a", order: 2, title: "Shloka 1.1.99" },
  ],
);

// prepareHierarchyForSave: insert order changes must not rewrite verse labels
const afterInsertSave = prepareHierarchyForSave(
  [
    {
      id: "a1",
      title: "Prathama Adhyaya",
      order: 1,
      expanded: true,
      khandas: [
        {
          id: "k1",
          title: "Prathama Khanda",
          order: 1,
          expanded: true,
          padas: [],
          manthras: [
            { id: "m1", title: "Shloka 1.1.268", order: 1 },
            { id: "new", title: "", order: 2, _isNewLocal: true },
            { id: "m2", title: "Shloka 1.1.269", order: 3 },
          ],
        },
      ],
    },
  ],
  { levelTwoEnabled: true, levelThreeEnabled: false, leafName: "Shloka" },
);
const savedMantras = afterInsertSave[0].khandas[0].manthras;
assert.equal(savedMantras[0].title, "Shloka 1.1.268");
assert.equal(savedMantras[1].title, "Shloka 1.1.2");
assert.equal(savedMantras[2].title, "Shloka 1.1.269");
assert.equal(savedMantras[0].order, 1);
assert.equal(savedMantras[1].order, 2);
assert.equal(savedMantras[2].order, 3);

const flatCtx = buildMantraTitleCtx(0, { title: "_default" }, 0, {
  levelTwoEnabled: false,
  leafName: "Mantra",
});
assert.equal(mantraLabelForCmsSync("", 7, flatCtx), "Mantra 1.7");
assert.equal(mantraLabelForCmsSync("Mantra 1", 7, flatCtx), "Mantra 1.7");
assert.equal(mantraLabelForCmsSync("Mantra 1.5", 5, flatCtx), "Mantra 1.5");

const flatTree = normalizeEditorHierarchy(
  [
    {
      id: "a1",
      title: "A",
      order: 2,
      expanded: true,
      khandas: [
        {
          id: "k1",
          title: "_default",
          order: 1,
          expanded: true,
          padas: [],
          manthras: [
            { id: "m1", title: "Shloka 9.9", order: 2, note: "x" },
            { id: "m2", title: "Shloka 9.8", order: 1, note: "y" },
          ],
        },
      ],
    },
  ],
  { levelTwoEnabled: false, levelThreeEnabled: false, leafName: "Shloka" },
);
assert.equal(flatTree[0].order, 1);
assert.equal(flatTree[0].khandas[0].manthras[0].id, "m2");
assert.equal(flatTree[0].khandas[0].manthras[0].title, "Shloka 1.1");
assert.equal(flatTree[0].khandas[0].manthras[1].title, "Shloka 1.2");

// ── assignContiguousMantraOrders: new row must not sort to front (order: 0 bug) ──
const baseFour: ManthraRow[] = [
  { id: "m1", title: "Shloka 1.1", order: 1, strapiDocumentId: "strapi-doc-m1xxxxxx" },
  { id: "m2", title: "Shloka 1.2", order: 2, strapiDocumentId: "strapi-doc-m2xxxxxx" },
  { id: "m3", title: "Shloka 1.3", order: 3, strapiDocumentId: "strapi-doc-m3xxxxxx" },
  { id: "m4", title: "Shloka 1.4", order: 4, strapiDocumentId: "strapi-doc-m4xxxxxx" },
];

let editor = simulateEditorInsertAfter(baseFour, "m2", "newA");
assert.deepEqual(
  editor.map((m) => m.id),
  ["m1", "m2", "newA", "m3", "m4"],
);
assertUniqueContiguousOrders(editor, "insert after m2");

let strapi = portalRowsToStrapiSortKeys(baseFour);
strapi = simulateStrapiInsertBetween(strapi, "strapi-doc-m2xxxxxx", "strapi-doc-newAxxxxx");
assert.deepEqual(
  strapi.map((m) => m.strapiDocumentId),
  ["strapi-doc-m1xxxxxx", "strapi-doc-m2xxxxxx", "strapi-doc-newAxxxxx", "strapi-doc-m3xxxxxx", "strapi-doc-m4xxxxxx"],
);
assert.equal(strapi.find((m) => m.strapiDocumentId === "strapi-doc-newAxxxxx")?.order, 2500);
assert.equal(strapi.find((m) => m.strapiDocumentId === "strapi-doc-m3xxxxxx")?.order, 3000);
assert.equal(strapi.find((m) => m.strapiDocumentId === "strapi-doc-m4xxxxxx")?.order, 4000);

// ── Chained insert: after 2, then after new 3 ──
editor = simulateEditorInsertAfter(baseFour, "m2", "newA");
editor = simulateEditorInsertAfter(editor, "newA", "newB");
assert.deepEqual(
  editor.map((m) => m.id),
  ["m1", "m2", "newA", "newB", "m3", "m4"],
);
assertUniqueContiguousOrders(editor, "chained editor insert");

strapi = portalRowsToStrapiSortKeys(baseFour);
strapi = simulateStrapiInsertBetween(strapi, "strapi-doc-m2xxxxxx", "strapi-doc-newAxxxxx");
strapi = simulateStrapiInsertBetween(strapi, "strapi-doc-newAxxxxx", "strapi-doc-newBxxxxx");
assert.equal(strapi.find((m) => m.strapiDocumentId === "strapi-doc-newBxxxxx")?.order, 2750);
assert.equal(strapi.find((m) => m.strapiDocumentId === "strapi-doc-m4xxxxxx")?.order, 4000);

// Editor snapshot batch payload matches contiguous orders
editor = simulateEditorInsertAfter(baseFour, "m2", "newA");
editor = simulateEditorInsertAfter(editor, "newA", "newB");
editor = editor.map((m, i) =>
  m.id === "newA"
    ? { ...m, strapiDocumentId: "strapi-doc-newAxxxxx" }
    : m.id === "newB"
      ? { ...m, strapiDocumentId: "strapi-doc-newBxxxxx" }
      : m,
);
const batch = batchUpdatesFromSnapshot(editor);
assert.deepEqual(
  batch.map((u) => u.order),
  [1, 2, 3, 4, 5, 6],
);
assert.equal(new Set(batch.map((u) => u.order)).size, batch.length, "batch orders unique");

// Batch identity must update every Strapi row by documentId (not dedupe by verse label).
const labelCollisionBatch = batchUpdatesFromSnapshot([
  { id: "m1", title: "Shloka 1.3", order: 3, strapiDocumentId: "strapi-doc-aaaaaaa1" },
  { id: "m2", title: "Shloka 1.3", order: 4, strapiDocumentId: "strapi-doc-bbbbbbb2" },
]);
assert.equal(labelCollisionBatch.length, 2);
assert.deepEqual(
  labelCollisionBatch.map((u) => u.documentId).sort(),
  ["strapi-doc-aaaaaaa1", "strapi-doc-bbbbbbb2"],
);

// ── Delete: remove middle, keep titles ──
editor = baseFour.map((m) => ({ ...m }));
editor = simulateEditorDelete(editor, "m2", false, flat);
assert.deepEqual(
  editor.map((m) => ({ id: m.id, order: m.order, title: m.title })),
  [
    { id: "m1", order: 1, title: "Shloka 1.1" },
    { id: "m3", order: 2, title: "Shloka 1.3" },
    { id: "m4", order: 3, title: "Shloka 1.4" },
  ],
);

// ── Consecutive deletes: remove 2 then 3 (original m3) ──
editor = baseFour.map((m) => ({ ...m }));
editor = simulateEditorDelete(editor, "m2", false, flat);
editor = simulateEditorDelete(editor, "m3", false, flat);
assert.deepEqual(
  editor.map((m) => m.id),
  ["m1", "m4"],
);
assert.deepEqual(
  editor.map((m) => m.order),
  [1, 2],
);

// Strapi: after deletes, batch sync remaining to compact orders
strapi = baseFour.map((m) => ({ ...m }));
strapi = strapi.filter((m) => m.id !== "m2" && m.id !== "m3");
strapi = reindexMantraOrdersPreservingTitles(strapi);
const batchAfterDelete = batchUpdatesFromSnapshot(strapi);
assert.deepEqual(
  batchAfterDelete.map((u) => ({ id: u.documentId, order: u.order })),
  [
    { id: "strapi-doc-m1xxxxxx", order: 1 },
    { id: "strapi-doc-m4xxxxxx", order: 2 },
  ],
);

// Delete with renumber titles
editor = baseFour.map((m) => ({ ...m }));
editor = simulateEditorDelete(editor, "m2", true, flat);
assert.deepEqual(
  editor.map((m) => m.title),
  ["Shloka 1.1", "Shloka 1.2", "Shloka 1.3"],
);

assert.equal(portalMantraTitleForLeaf("Mantra 1.1.5", "Shloka"), "Shloka 1.1.5");
assert.equal(
  portalMantraTitleForLeaf("Mantra 1.1.5", "Shloka", "Shloka 1.1.5"),
  "Shloka 1.1.5",
);

const shlokaHeavy = Array.from({ length: 30 }, (_, i) => ({
  title: `Shloka 1.1.${i + 1}`,
}));
const mantraSparse = [{ title: "Mantra 1.1.1" }, { title: "Mantra 1.1.2" }];
assert.equal(inferLeafNameFromStrapiMantras(shlokaHeavy, "Mantra"), "Shloka");
assert.equal(inferLeafNameFromStrapiMantras(mantraSparse, "Mantra"), "Mantra");

assert.equal(isPlaceholderVersusCms("4", "uddharedātmanātmānaṃ magnaṃ"), true);
assert.equal(isPlaceholderVersusCms("4..", ""), true);
assert.equal(
  isPlaceholderVersusCms(
    [{ type: "paragraph", children: [{ type: "text", text: "4.." }] }],
    [{ type: "paragraph", children: [{ type: "text", text: "उद्धरेदात्मनात्मानं" }] }],
  ),
  true,
);
assert.equal(
  isPlaceholderVersusCms(
    [{ type: "paragraph", children: [{ type: "text", text: "4" }] }],
    [{ type: "paragraph", children: [{ type: "text", text: "उद्धरेदात्मनात्मानं" }] }],
  ),
  true,
);
assert.equal(entryContentCharCount("4"), 1);

const dupRefsByRichness: StrapiMantraRef[] = [
  { title: "Shloka 1.1.3", docId: "empty-doc", order: 3, contentScore: 0 },
  { title: "Shloka 1.1.3", docId: "full-doc", order: 3, contentScore: 120 },
];
assert.equal(pickBestStrapiMantraRefForLink(dupRefsByRichness, "empty-doc")?.docId, "full-doc");

// ── Leaf mantra counts: parent sections must not inflate totals (549 vs 13) ──
const l3Khanda = {
  id: "khanda1",
  title: "Khanda 1",
  order: 1,
  expanded: true,
  manthras: Array.from({ length: 549 }, (_, i) => ({
    id: `legacy-${i}`,
    title: `Shloka 1.${i + 1}`,
    order: i + 1,
  })),
  padas: [
    {
      id: "p1",
      title: "Pada 1",
      order: 1,
      expanded: true,
      manthras: [{ id: "m1", title: "Shloka 1.1.1", order: 1 }],
    },
    {
      id: "p2",
      title: "Pada 2",
      order: 2,
      expanded: true,
      manthras: [{ id: "m2", title: "Shloka 1.1.2", order: 1 }],
    },
  ],
};
assert.equal(countLeafMantrasInKhanda(l3Khanda, { levelThreeEnabled: true }), 2);
assert.equal(countLeafMantrasInKhanda(l3Khanda, { levelThreeEnabled: false }), 549);

const l3Adhyaya = { khandas: [l3Khanda] };
assert.equal(
  countLeafMantrasInAdhyaya(l3Adhyaya, { levelTwoEnabled: true, levelThreeEnabled: true }),
  2,
);

const strapiSections = [
  { documentId: "khanda", parent: { documentId: "adhyaya" }, manthras: [{ id: 1 }] },
  { documentId: "pada1", parent: { documentId: "khanda" }, manthras: [{ id: 2 }, { id: 3 }] },
  { documentId: "pada2", parent: { documentId: "khanda" }, manthras: [{ id: 4 }] },
  { documentId: "adhyaya", manthras: [] },
];
assert.equal(countMantrasOnLeafSections(strapiSections as any), 3);

const childrenOf = new Map<string, any[]>([
  ["khanda", [{ documentId: "pada1", manthras: [] }, { documentId: "pada2", manthras: [] }]],
  ["pada1", []],
  ["pada2", []],
]);
assert.equal(
  countLeafMantrasInSectionTree({ documentId: "khanda", manthras: [{ id: 1 }] }, childrenOf as any),
  0,
);

const cleared = enforceMantraPlacementByStructure(
  [{ id: "a", title: "A", order: 1, expanded: true, khandas: [l3Khanda as any] }],
  { levelThreeEnabled: true, leafName: "Shloka" },
);
assert.equal(cleared[0].khandas[0].manthras.length, 0);
assert.equal(cleared[0].khandas[0].padas.length, 2);

const vedantaSection = "mangala-sec";
const vedantaRows = dedupePublishedMantrasForDisplay([
  {
    documentId: "good-vaakhyaa",
    ShlokaManthraNumber: "Vaakhyaa 1.1.1",
    order: 100_000,
    section: { documentId: vedantaSection },
    ShlokaManthraEntry: { SanskritTextEntry: [{ type: "paragraph", children: [{ type: "text", text: "यदविद्याविलासेन" }] }] },
  },
  {
    documentId: "stub-vaakhyaa",
    ShlokaManthraNumber: "Vaakhyaa 1",
    order: 200_000,
    section: { documentId: vedantaSection },
    ShlokaManthraEntry: undefined,
  },
]);
assert.equal(vedantaRows.length, 1);
assert.equal(vedantaRows[0].documentId, "good-vaakhyaa");

const flatMap = new Map<string, StrapiMantraRef[]>([
  ["shloka-sec", [{ title: "Mantra 1.1", docId: "doc-111111111111", order: 100_000 }]],
  ["empty-adhyaya", []],
]);
assert.equal(
  strapiMantrasForResolvedSection(flatMap, undefined, undefined).length,
  1,
  "sole non-empty Strapi section used when portal has no docId",
);
const linked = linkFlatGranthaAdhyayasToSoleStrapiSection(
  [{ id: "a1", title: "Adhyaya 1", khandas: [{ id: "k1", title: "_default", manthras: [] }] }],
  [{ documentId: "shloka-sec", manthras: [{ documentId: "doc-111111111111" }] }],
);
assert.equal(linked[0].documentId, "shloka-sec");

console.log("test-grantha-mantra-index: all ok (insert/delete/order)");
