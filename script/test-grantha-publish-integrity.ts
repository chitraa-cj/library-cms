import {
  assertVerseSuffixStable,
  detectSuspectCrossGranthaContent,
  scanMantraForPublish,
  scanGranthaHierarchyMantras,
} from "../shared/grantha-publish-integrity";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

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
