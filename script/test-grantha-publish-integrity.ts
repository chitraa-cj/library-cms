import {
  assertVerseSuffixStable,
  detectSuspectCrossGranthaContent,
  isBareLeafCounterTitle,
  portalMantraTitleForConfiguredLeaf,
  scanMantraForPublish,
  scanGranthaHierarchyMantras,
} from "../shared/grantha-publish-integrity";

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

console.log("grantha-publish-integrity: all tests passed");
