import {
  assertVerseSuffixStable,
  detectSuspectCrossGranthaContent,
  findDocIdByExactLabelInRows,
  isBareLeafCounterTitle,
  isStructuralSuffixExtension,
  pickDocIdForSuffixInSectionRows,
  portalMantraTitleForConfiguredLeaf,
  scanMantraForPublish,
  scanGranthaHierarchyMantras,
  sectionSuffixCollision,
} from "../shared/grantha-publish-integrity";
import { repairDuplicateSuffixesInHierarchy } from "../client/src/lib/grantha-structure-sync.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Leaf relabel (Shloka → Mantra when grantha uses Mantra)
assert(
  portalMantraTitleForConfiguredLeaf("Shloka 3.10", "Mantra") === "Mantra 3.10",
  "wrong leaf prefix should normalize on publish",
);
assert(
  portalMantraTitleForConfiguredLeaf("", "Mantra") === "",
  "blank portal title must not default to Mantra 1",
);
assert(
  portalMantraTitleForConfiguredLeaf("Mantra 1", "Mantra") === "",
  "bare Mantra 1 placeholder must not pass as verse label",
);
assert(
  isBareLeafCounterTitle("Vaakhyaa 1") === true,
  "Vaakhyaa 1 must be detected as bare leaf counter",
);
assert(
  isBareLeafCounterTitle("Vaakhyaa 1.1.1") === false,
  "Vaakhyaa 1.1.1 must not be bare leaf counter",
);
assert(
  portalMantraTitleForConfiguredLeaf("Mantra 1.7", "Mantra") === "Mantra 1.7",
  "valid dotted suffix must be kept",
);
const relabeled = scanMantraForPublish({
  portalLabel: portalMantraTitleForConfiguredLeaf("Shloka 3.10", "Mantra"),
  configuredLeaf: "Mantra",
  granthaName: "Test",
});
assert(
  !relabeled.some((x) => x.code === "wrong_leaf_prefix"),
  "normalized label must pass leaf check",
);

// Suffix stability
assert(
  assertVerseSuffixStable("Shloka 1.372", "Mantra 1.2.4") !== null,
  "1.372 → 1.2.4 must be blocked",
);
assert(
  assertVerseSuffixStable("Shloka 1.372", "Shloka 1.372") === null,
  "same suffix ok",
);
assert(
  assertVerseSuffixStable("Shloka 1.372", "Mantra 1.372") === null,
  "leaf-only relabel ok",
);
assert(
  assertVerseSuffixStable("Vaakhyaa 1.1", "Mantra 1.1.1") === null,
  "hierarchy migration 1.1 → 1.1.1 must be allowed",
);
assert(
  isStructuralSuffixExtension("1.1", "1.1.1") === true,
  "1.1 → 1.1.1 is structural extension",
);
assert(
  isStructuralSuffixExtension("1.372", "1.2.4") === false,
  "1.372 → 1.2.4 is not structural extension",
);

// Portal-owned row: intentional renumber after deletion (1.4 → 1.2 on same documentId)
const portalRenumber = scanMantraForPublish({
  portalLabel: "Shloka 1.2",
  configuredLeaf: "Shloka",
  existingStrapiLabel: "Shloka 1.4",
  targetDocumentId: "doc-444444444444",
  portalLinkedDocumentId: "doc-444444444444",
});
assert(
  !portalRenumber.some((x) => x.code === "suffix_changed"),
  "portal-owned row must allow suffix renumber",
);

// Heuristic match without portal link: still blocked (1.372 → 1.2.4 style cross-write)
const crossWrite = scanMantraForPublish({
  portalLabel: "Shloka 1.2",
  configuredLeaf: "Shloka",
  existingStrapiLabel: "Shloka 1.4",
  targetDocumentId: "doc-444444444444",
  portalLinkedDocumentId: "doc-other99999999",
});
assert(
  crossWrite.some((x) => x.code === "suffix_changed"),
  "non-owned row must block suffix change",
);

// BG cross-text
const bgHit = detectSuspectCrossGranthaContent(
  "Sarva Vedanta Siddhanta Saar Sangraha",
  "अयनेषु च सर्वेषु यथाभागमवस्थिताः",
  "",
);
assert(bgHit !== null, "BG sanskrit in SVSSS must be flagged");

const bgOk = detectSuspectCrossGranthaContent(
  "Bhagavad Gita",
  "अयनेषु च सर्वेषु",
  "",
);
assert(bgOk === null, "BG in BG grantha allowed");

// Scan mantra
const v = scanMantraForPublish({
  portalLabel: "Shloka 1.11",
  configuredLeaf: "Shloka",
  granthaName: "Sarva Vedanta",
  existingStrapiLabel: "Shloka 1.11",
  sanskritPlain: "अयनेषु च सर्वेषु",
  englishPlain: "Protect Bhishma",
});
assert(v.some((x) => x.code.startsWith("suspect_bg")), "publish scan must catch BG text");

// Draft duplicate suffix
const hier = [
  {
    khandas: [
      {
        manthras: [
          { id: "a", title: "Shloka 1.1" },
          { id: "b", title: "Shloka 1.1" },
        ],
      },
    ],
  },
];
const dup = scanGranthaHierarchyMantras(hier, "Shloka", "Test");
assert(dup.some((x) => x.code === "duplicate_suffix_in_draft"), "draft dup suffix");

const cfg = { leafName: "Shloka", levelTwoEnabled: false, levelThreeEnabled: false };
const repaired = repairDuplicateSuffixesInHierarchy(hier as any, cfg as any);
const dupAfter = scanGranthaHierarchyMantras(repaired, "Shloka", "Test");
assert(!dupAfter.some((x) => x.code === "duplicate_suffix_in_draft"), "repair removes dup suffix");
assert(repaired[0].khandas[0].manthras[0].title === "Shloka 1.1", "first title 1.1");
assert(repaired[0].khandas[0].manthras[1].title === "Shloka 1.2", "second title 1.2");

// Leaf relabel: same suffix, different prefix — publish updates one row
const sectionRows = [
  { documentId: "doc-m-1", label: "Mantra 1.1.1" },
  { documentId: "doc-m-2", label: "Mantra 1.1.2" },
];
assert(
  pickDocIdForSuffixInSectionRows(sectionRows, "Vaakhyaa 1.1.1") === "doc-m-1",
  "suffix match must resolve Mantra row for Vaakhyaa publish",
);
assert(
  findDocIdByExactLabelInRows(sectionRows, "Vaakhyaa 1.1.1") === undefined,
  "exact label must not match cross-leaf title",
);
const labelMap = new Map(sectionRows.map((r) => [r.label, r.documentId]));
assert(
  sectionSuffixCollision(
    sectionRows.map((r) => r.label),
    "Vaakhyaa 1.1.1",
    "doc-m-1",
    labelMap,
  ) === null,
  "collision must skip the row being updated on leaf relabel",
);
const sectionWithThree = [
  ...sectionRows,
  { documentId: "doc-m-3", label: "Mantra 1.1.3" },
];
assert(
  sectionSuffixCollision(
    sectionWithThree.map((r) => r.label),
    "Vaakhyaa 1.1.3",
    undefined,
    new Map(sectionWithThree.map((r) => [r.label, r.documentId])),
  )?.code === "duplicate_suffix_in_section",
  "collision must block when suffix row exists but publish target is unresolved",
);

console.log("grantha-publish-integrity: all tests passed");
