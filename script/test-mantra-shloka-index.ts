import assert from "node:assert/strict";
import { blocksToText, textToBlocks } from "../client/src/lib/strapi-blocks";
import {
  buildMantraShlokaIndexFromSections,
  prepareManthraAfterStrapiResolve,
} from "../client/src/lib/strapi-mantra-hydration";

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

// Published relink: stale draft body cleared, CMS index applied.
const localDraft = {
  strapiDocumentId: "old-doc-id-aaaaaa",
  ShlokaManthraEntry: entryWithText("local draft verse"),
};
const publishedRelink = prepareManthraAfterStrapiResolve(
  localDraft,
  DOC,
  index,
  "Shloka 1.1.1",
);
assert.equal(publishedRelink.strapiDocumentId, DOC);
assert.ok(
  blocksToText(publishedRelink.ShlokaManthraEntry!.SanskritTextEntry as never).includes("Rich Sanskrit"),
);

// Portal relink to a different CMS doc: stale local body cleared, index applied.
const portalRelink = prepareManthraAfterStrapiResolve(
  localDraft,
  DOC,
  index,
  "Shloka 1.1.1",
  { preferPortalContent: true },
);
assert.equal(portalRelink.strapiDocumentId, DOC);
assert.ok(
  blocksToText(portalRelink.ShlokaManthraEntry!.SanskritTextEntry as never).includes("Rich Sanskrit"),
);

// Same documentId, portal mode: keep in-progress local text.
const portalSameDoc = prepareManthraAfterStrapiResolve(
  { ...localDraft, strapiDocumentId: DOC },
  DOC,
  index,
  "Shloka 1.1.1",
  { preferPortalContent: true },
);
assert.equal(
  blocksToText(portalSameDoc.ShlokaManthraEntry!.SanskritTextEntry as never),
  "local draft verse",
);

// Portal label-only row (e.g. 1.18–1.26 in draft): fill from CMS index.
const labelOnly = prepareManthraAfterStrapiResolve(
  { strapiDocumentId: "old-doc-id-aaaaaa", title: "Shloka 1.1.18" },
  DOC,
  index,
  "Shloka 1.1.18",
  { preferPortalContent: true },
);
assert.ok(
  blocksToText(labelOnly.ShlokaManthraEntry!.SanskritTextEntry as never).includes("Rich Sanskrit"),
);

console.log("test-mantra-shloka-index: all ok");
