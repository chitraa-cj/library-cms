/**
 * Two-pass translation: Sanskrit → English, then English → everything else.
 * =========================================================================
 * Every other language is translated FROM English, so a field entered with only its
 * Sanskrit original used to be skipped forever ("no English source"). Pass 1 now
 * fills that English from the Sanskrit; pass 2 is the unchanged old path reading it.
 *
 * What is locked here is the decision each builder makes — which pass claims which
 * field, where the answer is written, and that the two passes can never collide in
 * the resume checkpoint. No browser, no Gemini, no network, no Strapi.
 *
 * Run:  npm run test:hermex-two-pass
 */
import "dotenv/config";

const {
  buildEnglishJobsForMantra,
  buildJobsForMantra,
  chunkKey,
  mantraFieldUnits,
  narrowToRequestedLanguages,
} = await import("../script/lib/hermex-grantha-sync.ts");

let PASS = 0;
const FAILURES = [];

function check(name, ok, detail = "") {
  if (ok) {
    PASS += 1;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const blocks = (text) => [{ type: "paragraph", children: [{ type: "text", text }] }];

/** A mantra where each field is in a different state. */
const mantra = {
  documentId: "mantra1",
  // Sanskrit only — pass 1 territory.
  ShlokaManthraEntry: {
    SanskritTextEntry: blocks("ॐ इति एतत् अक्षरम्"),
  },
  // English already there — pass 2 territory, pass 1 must not touch it.
  BhashyamEntry: {
    SanskritTextEntry: blocks("भाष्यम् संस्कृतम्"),
    EnglishTranslationText: blocks("The syllable Om is this."),
    OtherTranslations: [
      { LanguageOfTranslation: "Tamil", TranslationText: blocks("தமிழ்") },
    ],
  },
  Teekas: [
    // Sanskrit only.
    { teeka: { TeekaName: "Anandagiri" }, TeekaEntry: { SanskritTextEntry: blocks("टीका") } },
    // Neither English nor Sanskrit — nothing to translate from, in either pass.
    { teeka: { TeekaName: "Shankarananda" }, TeekaEntry: { IASTTransliteration: blocks("ṭīkā") } },
  ],
};

console.log("\nfield units");
const units = mantraFieldUnits(mantra);
check("one unit per translatable block", units.length === 4, `got ${units.length}`);
check(
  "Shloka and Bhashyam come first, in that order",
  units[0].field === "ShlokaManthraEntry" && units[1].field === "BhashyamEntry",
);
check(
  "teeka units carry their index and name",
  units[2].field === "teeka" &&
    units[2].teekaIndex === 0 &&
    units[2].name === "Teeka Anandagiri" &&
    units[3].teekaIndex === 1,
  JSON.stringify(units.map((u) => [u.field, u.teekaIndex, u.name])),
);
check("a mantra with no Teekas is fine", mantraFieldUnits({ documentId: "x" }).length === 2);

console.log("\npass 1 — Sanskrit → English, only where English is absent");
const englishJobs = buildEnglishJobsForMantra(mantra, "1.1.1", "Chandogya Upanishad");
check("only the fields missing English", englishJobs.length === 2, `got ${englishJobs.length}`);
check(
  "picks the Shloka and the first Teeka",
  englishJobs[0].field === "ShlokaManthraEntry" &&
    englishJobs[1].field === "teeka" &&
    englishJobs[1].teekaIndex === 0,
);
check(
  "never the field that already has English",
  englishJobs.every((j) => j.field !== "BhashyamEntry"),
);
check(
  "a field with neither English nor Sanskrit is skipped",
  englishJobs.every((j) => j.teekaIndex !== 1),
);
check(
  "source is the Sanskrit original",
  englishJobs[0].sourceLanguage === "Sanskrit" && englishJobs[0].sourceText.includes("अक्षरम्"),
);
check(
  "the one target is English",
  englishJobs.every((j) => j.targetLanguages.length === 1 && j.targetLanguages[0] === "English"),
);
check(
  "the answer is written to the field's own English text",
  englishJobs.every((j) => j.produces === "english"),
);
check(
  "context names the grantha, the verse, the field and the direction",
  englishJobs[0].context === "Chandogya Upanishad — 1.1.1 — ShlokaManthraEntry → English",
  englishJobs[0].context,
);

console.log("\npass 2 — English → every other language still missing");
const otherJobs = buildJobsForMantra(mantra, "1.1.1", "Chandogya Upanishad");
check(
  "only the field that HAS English, before pass 1 runs",
  otherJobs.length === 1 && otherJobs[0].field === "BhashyamEntry",
  JSON.stringify(otherJobs.map((j) => j.field)),
);
check("source is the English text", otherJobs[0].sourceLanguage === "English");
check("writes OtherTranslations rows", otherJobs[0].produces === "others");
check(
  "a language already present is not re-requested",
  !otherJobs[0].targetLanguages.includes("Tamil"),
);
check(
  "English is never one of the targets",
  !otherJobs[0].targetLanguages.includes("English"),
);
check("many languages are still missing", otherJobs[0].targetLanguages.length > 10);

console.log("\npass 2 sees what pass 1 wrote");
// The worker re-reads the mantra between the passes; this is that re-read.
const afterPass1 = structuredClone(mantra);
afterPass1.ShlokaManthraEntry.EnglishTranslationText = blocks("Om is this syllable.");
afterPass1.Teekas[0].TeekaEntry.EnglishTranslationText = blocks("The commentary says...");
const secondPass = buildJobsForMantra(afterPass1, "1.1.1", "Chandogya Upanishad");
check(
  "the two filled fields now have other-language work",
  secondPass.length === 3,
  `got ${secondPass.length}`,
);
check(
  "and they translate from the English pass 1 produced",
  secondPass
    .filter((j) => j.field !== "BhashyamEntry")
    .every((j) => j.sourceLanguage === "English" && j.sourceText.includes("Om is this syllable.") === (j.field === "ShlokaManthraEntry")),
);
check(
  "pass 1 has nothing left to do",
  buildEnglishJobsForMantra(afterPass1, "1.1.1", "Chandogya Upanishad").length === 0,
);

console.log("\nthe passes cannot collide in the checkpoint");
// Both passes produce chunks for the same field; a shared key would make one pass
// mark the other's work "done" and skip it.
const p1Key = chunkKey(englishJobs[0], englishJobs[0].targetLanguages);
const p2Key = chunkKey(secondPass[0], ["Hindi", "Telugu"]);
check("different keys for the same field", p1Key !== p2Key, `${p1Key} vs ${p2Key}`);
check("the pass-1 key is recognisable by its single English target", p1Key.endsWith("|English"), p1Key);

console.log("\nrequested-language narrowing");
const narrowed = narrowToRequestedLanguages(otherJobs[0], ["Tamil", "Hindi"]);
check("keeps only what was asked for", narrowed.targetLanguages.join(",") === "Hindi", narrowed.targetLanguages.join(","));
check("an empty request means everything missing", narrowToRequestedLanguages(otherJobs[0], []).targetLanguages.length === otherJobs[0].targetLanguages.length);
// Pass 1 is a prerequisite, not a language choice: narrowing must never be applied
// to it, or asking for "Tamil only" would delete the English the Tamil needs.
check(
  "narrowing an English job to other languages would empty it (hence pass 1 is never narrowed)",
  narrowToRequestedLanguages(englishJobs[0], ["Tamil"]).targetLanguages.length === 0,
);

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("hermex-two-pass: all ok");
