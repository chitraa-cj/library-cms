import assert from "node:assert/strict";
import { blocksToText, textToBlocks } from "../client/src/lib/strapi-blocks";
import { buildMantraShlokaIndexFromSections } from "../client/src/lib/strapi-mantra-hydration";

const DOC = "doc-aaaaaaaaaaaaaa";

function entryWithText(sanskrit: string, english = ""): Record<string, unknown> {
  return {
    SanskritTextEntry: textToBlocks(sanskrit),
    EnglishTranslationText: english ? textToBlocks(english) : [],
  };
}

const sections = [
  {
    title: "Section A",
    manthras: [
      {
        documentId: DOC,
        ShlokaManthraEntry: entryWithText("stub"),
      },
    ],
  },
  {
    title: "Section B",
    manthras: [
      {
        documentId: DOC,
        ShlokaManthraEntry: entryWithText(
          "Rich Sanskrit verse body with substantive content for linking.",
          "English translation with enough characters.",
        ),
      },
    ],
  },
];

const index = buildMantraShlokaIndexFromSections(sections);
const picked = index.get(DOC);
assert.ok(picked);
const sanskrit = blocksToText(picked!.SanskritTextEntry as never);
assert.ok(sanskrit.includes("Rich Sanskrit"), `expected richer entry, got: ${sanskrit}`);

// First-seen wins on equal richness (stable) — identical text so scores match.
const sameBody = "Identical Sanskrit body for tie-break test.";
const tieSections = [
  { manthras: [{ documentId: DOC, ShlokaManthraEntry: entryWithText(sameBody) }] },
  { manthras: [{ documentId: DOC, ShlokaManthraEntry: entryWithText(sameBody) }] },
];
const tieIndex = buildMantraShlokaIndexFromSections(tieSections);
assert.equal(blocksToText(tieIndex.get(DOC)!.SanskritTextEntry as never), sameBody);

console.log("test-mantra-shloka-index: all ok");
